/**
 * Repository for the owned-bids ledger (SPEC §10 client-side ownership).
 *
 * On successful CREATE: {@link insert}.
 * On successful EDIT (price decrease): {@link setLastPriceDecrease}.
 * On successful CANCEL: {@link markCancelled}.
 * Every tick: {@link reconcileFromApi} brings the ledger into line with
 * what Braiins reports.
 */

import { sql, type Kysely, type Selectable } from 'kysely';

import type { Database, OwnedBidsTable } from '../types.js';

type OwnedBidsRow = Selectable<OwnedBidsTable>;

export interface OwnedBidRow {
  readonly braiins_order_id: string;
  readonly cl_order_id: string | null;
  readonly created_at: number;
  readonly first_seen_active_at: number | null;
  readonly last_known_status: string | null;
  readonly price_sat: number | null;
  readonly amount_sat: number | null;
  readonly speed_limit_ph: number | null;
  readonly last_price_decrease_at: number | null;
  readonly abandoned: boolean;
}

export interface InsertOwnedBidArgs {
  readonly braiins_order_id: string;
  readonly cl_order_id: string | null;
  readonly created_at: number;
  readonly price_sat: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number | null;
  readonly last_known_status?: string;
}

export interface ReconcilableBid {
  readonly braiins_order_id: string;
  readonly status: string;
  readonly price_sat: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number | null;
  /** Currently consumed sat (= amount_sat − amount_remaining_sat). */
  readonly amount_consumed_sat: number;
}

export class OwnedBidsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async list(): Promise<OwnedBidRow[]> {
    const rows = await this.db.selectFrom('owned_bids').selectAll().execute();
    return rows.map(toDomain);
  }

  async getIds(): Promise<Set<string>> {
    const rows = await this.db.selectFrom('owned_bids').select('braiins_order_id').execute();
    return new Set(rows.map((r) => r.braiins_order_id));
  }

  async findById(braiinsOrderId: string): Promise<OwnedBidRow | null> {
    const row = await this.db
      .selectFrom('owned_bids')
      .selectAll()
      .where('braiins_order_id', '=', braiinsOrderId)
      .executeTakeFirst();
    return row ? toDomain(row) : null;
  }

  /**
   * Record a newly-placed bid. Safe to call repeatedly — does nothing if
   * the ID is already known (idempotent on Braiins's own retry semantics).
   *
   * Empty cl_order_id strings are stored as NULL so they don't collide on
   * the UNIQUE index (SQLite treats multiple NULLs as distinct but
   * multiple empty strings as duplicates).
   */
  async insert(args: InsertOwnedBidArgs): Promise<void> {
    const normalisedClOrderId =
      args.cl_order_id && args.cl_order_id.length > 0 ? args.cl_order_id : null;
    await this.db
      .insertInto('owned_bids')
      .values({
        braiins_order_id: args.braiins_order_id,
        cl_order_id: normalisedClOrderId,
        created_at: args.created_at,
        first_seen_active_at: null,
        last_known_status: args.last_known_status ?? null,
        price_sat: args.price_sat,
        amount_sat: args.amount_sat,
        speed_limit_ph: args.speed_limit_ph,
        last_price_decrease_at: null,
      })
      .onConflict((oc) => oc.column('braiins_order_id').doNothing())
      .execute();
  }

  async setLastPriceDecrease(braiinsOrderId: string, at: number, newPriceSat: number): Promise<void> {
    await this.db
      .updateTable('owned_bids')
      .set({ last_price_decrease_at: at, price_sat: newPriceSat })
      .where('braiins_order_id', '=', braiinsOrderId)
      .execute();
  }

  async markCancelled(braiinsOrderId: string, status = 'BID_STATUS_CANCELED'): Promise<void> {
    await this.db
      .updateTable('owned_bids')
      .set({ last_known_status: status })
      .where('braiins_order_id', '=', braiinsOrderId)
      .execute();
  }

  /**
   * Bring the ledger rows into line with what Braiins currently reports for
   * our owned bids. Updates `last_known_status`, `price_sat`, `amount_sat`,
   * `speed_limit_ph`, and sets `first_seen_active_at` the first time a bid
   * appears as ACTIVE.
   *
   * Does NOT insert unknown bids — ownership is a client-side decision that
   * happens only on our own POST.
   */
  async reconcileFromApi(now: number, bids: readonly ReconcilableBid[]): Promise<void> {
    for (const b of bids) {
      await this.db
        .updateTable('owned_bids')
        .set((eb) => ({
          last_known_status: b.status,
          price_sat: b.price_sat,
          amount_sat: b.amount_sat,
          speed_limit_ph: b.speed_limit_ph,
          // Monotonic: never roll the persisted consumed value
          // backwards. Braiins's `amount_remaining_sat` can wobble by
          // a few sat between polls (counters_estimate vs
          // counters_committed), so always keep the highest seen
          // value to avoid spurious dips on the finance panel.
          amount_consumed_sat: sql<number>`MAX(amount_consumed_sat, ${b.amount_consumed_sat})`,
          first_seen_active_at:
            b.status === 'BID_STATUS_ACTIVE'
              ? eb.fn.coalesce('first_seen_active_at', eb.val(now))
              : eb.ref('first_seen_active_at'),
        }))
        .where('braiins_order_id', '=', b.braiins_order_id)
        .execute();
    }
  }

  /**
   * Sum of `amount_consumed_sat` across every bid the autopilot has
   * ever owned. The lifetime "money spent on hashrate" figure for the
   * finance panel.
   */
  async sumLifetimeConsumedSat(): Promise<number> {
    const row = await this.db
      .selectFrom('owned_bids')
      .select(sql<number>`COALESCE(SUM(amount_consumed_sat), 0)`.as('total'))
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }
}

function toDomain(row: OwnedBidsRow): OwnedBidRow {
  return {
    braiins_order_id: row.braiins_order_id,
    cl_order_id: row.cl_order_id,
    created_at: row.created_at,
    first_seen_active_at: row.first_seen_active_at,
    last_known_status: row.last_known_status,
    price_sat: row.price_sat,
    amount_sat: row.amount_sat,
    speed_limit_ph: row.speed_limit_ph,
    last_price_decrease_at: row.last_price_decrease_at,
    abandoned: row.abandoned === 1,
  };
}
