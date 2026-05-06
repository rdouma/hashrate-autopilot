/**
 * Persistent cache of terminal Braiins bids (is_current=false).
 *
 * Terminal bids' `counters_committed.amount_consumed_sat` is
 * immutable, so we store the amount once and
 * `AccountSpendService.getLifetimeSpend()` starts each refresh from
 * this cached running total - only paginating `/spot/bid` far enough
 * to pick up newly-closed bids.
 *
 * Active bids (is_current=true) are NOT cached here - their consumed
 * counter updates hourly as Braiins settles, and the service always
 * re-reads them live.
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';

import type { Database } from '../types.js';

export interface ClosedBidCacheRow {
  braiins_order_id: string;
  amount_consumed_sat: number;
  first_seen_at: number;
  last_seen_at: number;
}

export class ClosedBidsCacheRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert a terminal bid by order id. On conflict we refresh
   * `amount_consumed_sat` (in case Braiins ever publishes a slightly
   * different final figure after status flip) and bump `last_seen_at`.
   */
  async upsert(row: { braiins_order_id: string; amount_consumed_sat: number }, now: number): Promise<void> {
    await this.db
      .insertInto('closed_bids_cache')
      .values({
        braiins_order_id: row.braiins_order_id,
        amount_consumed_sat: row.amount_consumed_sat,
        first_seen_at: now,
        last_seen_at: now,
      })
      .onConflict((oc) =>
        oc.column('braiins_order_id').doUpdateSet({
          amount_consumed_sat: row.amount_consumed_sat,
          last_seen_at: now,
        }),
      )
      .execute();
  }

  /** Total consumed sat across every cached terminal bid. */
  async sumConsumedSat(): Promise<number> {
    const result = await this.db
      .selectFrom('closed_bids_cache')
      .select(sql<number>`COALESCE(SUM(amount_consumed_sat), 0)`.as('total'))
      .executeTakeFirst();
    return Number(result?.total ?? 0);
  }

  /** Returns the set of cached order IDs for fast membership checks. */
  async allIds(): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('closed_bids_cache')
      .select('braiins_order_id')
      .execute();
    return new Set(rows.map((r) => r.braiins_order_id));
  }

  /** Row count - mostly for diagnostics / tests. */
  async count(): Promise<number> {
    const result = await this.db
      .selectFrom('closed_bids_cache')
      .select(sql<number>`COUNT(*)`.as('count'))
      .executeTakeFirst();
    return Number(result?.count ?? 0);
  }

  /**
   * Nuke every row. Exposed so the operator can force a full
   * re-paginate when they suspect the cache has gone stale.
   */
  async clear(): Promise<void> {
    await this.db.deleteFrom('closed_bids_cache').execute();
  }
}
