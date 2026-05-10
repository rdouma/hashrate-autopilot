/**
 * Repository for the `braiins_deposits` table (#130 - DEAD WEIGHT
 * post-#132).
 *
 * The on-chain-transaction polling design that this table backed was
 * retired in #132 - the Braiins endpoint produced zero rows in
 * practice and the per-tick `tick_metrics.braiins_total_deposited_sat`
 * delta turned out to be a far simpler and more reliable signal. No
 * code in the daemon writes or reads this table any longer; the
 * migration (0080) and this repo are kept in tree for schema
 * continuity, mirroring the legacy-column precedent
 * (`hibernate_on_expensive_market` and friends). A future cleanup
 * commit could drop the table via DROP TABLE migration if it ever
 * matters; for now the cost of leaving it is one empty SQLite table.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export type DepositNotificationKind = 'detected' | 'available' | 'returned';

export interface BraiinsDepositRow {
  readonly tx_id: string;
  readonly amount_sat: number;
  readonly address: string | null;
  readonly last_seen_status: number;
  readonly last_seen_return_tx_id: string | null;
  readonly first_seen_at_ms: number;
  readonly updated_at_ms: number;
  readonly notified_detected: boolean;
  readonly notified_available: boolean;
  readonly notified_returned: boolean;
}

export interface UpsertSeenArgs {
  readonly tx_id: string;
  readonly amount_sat: number;
  readonly address: string | null;
  readonly status: number;
  readonly return_tx_id: string | null;
  readonly observed_at_ms: number;
}

export class BraiinsDepositsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert the row's current observed state. New rows are inserted
   * with all `notified_*` flags = 0. Existing rows have their state
   * fields refreshed but `notified_*` flags are preserved (ON
   * CONFLICT DO UPDATE).
   */
  async upsertSeen(args: UpsertSeenArgs): Promise<BraiinsDepositRow> {
    await this.db
      .insertInto('braiins_deposits')
      .values({
        tx_id: args.tx_id,
        amount_sat: args.amount_sat,
        address: args.address,
        last_seen_status: args.status,
        last_seen_return_tx_id: args.return_tx_id,
        first_seen_at_ms: args.observed_at_ms,
        updated_at_ms: args.observed_at_ms,
        notified_detected: 0,
        notified_available: 0,
        notified_returned: 0,
      })
      .onConflict((oc) =>
        oc.column('tx_id').doUpdateSet({
          last_seen_status: args.status,
          last_seen_return_tx_id: args.return_tx_id,
          updated_at_ms: args.observed_at_ms,
          // amount_sat is immutable per Braiins's own contract; address
          // could change if Braiins ever cycles its receiving keys.
          // Keep them refreshed defensively.
          amount_sat: args.amount_sat,
          address: args.address,
        }),
      )
      .execute();

    const row = await this.findByTxId(args.tx_id);
    if (!row) {
      throw new Error(`upsertSeen: row vanished after upsert (${args.tx_id})`);
    }
    return row;
  }

  /** Row count - used by the watcher to detect fresh-install state. */
  async countAll(): Promise<number> {
    const row = await this.db
      .selectFrom('braiins_deposits')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async findByTxId(tx_id: string): Promise<BraiinsDepositRow | null> {
    const row = await this.db
      .selectFrom('braiins_deposits')
      .selectAll()
      .where('tx_id', '=', tx_id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      tx_id: row.tx_id,
      amount_sat: row.amount_sat,
      address: row.address,
      last_seen_status: row.last_seen_status,
      last_seen_return_tx_id: row.last_seen_return_tx_id,
      first_seen_at_ms: row.first_seen_at_ms,
      updated_at_ms: row.updated_at_ms,
      notified_detected: row.notified_detected === 1,
      notified_available: row.notified_available === 1,
      notified_returned: row.notified_returned === 1,
    };
  }

  /**
   * Flip a single `notified_*` flag to 1. Used by both the actual
   * notification path (after the alert manager records the alert)
   * and the "silently absorb backlog when toggle is off" path.
   */
  async markNotified(tx_id: string, kind: DepositNotificationKind): Promise<void> {
    const col =
      kind === 'detected'
        ? 'notified_detected'
        : kind === 'available'
          ? 'notified_available'
          : 'notified_returned';
    await this.db
      .updateTable('braiins_deposits')
      .set({ [col]: 1 })
      .where('tx_id', '=', tx_id)
      .execute();
  }
}
