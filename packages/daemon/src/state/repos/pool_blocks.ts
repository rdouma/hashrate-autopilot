/**
 * Repository for Ocean's pool-blocks ledger (#108).
 *
 * Persistent ground truth for every pool block the daemon has seen.
 * Two write-paths feed it:
 *
 *   1. Per-tick observation: every successful Ocean fetch upserts the
 *      ~15 most recent blocks. Idempotent on `height` PK so duplicate
 *      observations are no-ops.
 *
 *   2. Startup backfill: when the table is empty (fresh install) or
 *      its earliest row is younger than 7 days ago (long downtime),
 *      page through `/v1/blocks` to retro-fill so the historical
 *      pool-luck plot works without a multi-day data-accrual wait.
 *
 * Read-paths compute 24h / 7d counts as live queries against this
 * table, replacing the per-tick `pool_blocks_*_count` snapshots that
 * couldn't reconstruct a pre-install window from nothing.
 */

import type { Kysely } from 'kysely';

import type { Database, PoolBlocksTable } from '../types.js';

export interface PoolBlockInsert {
  readonly height: number;
  readonly block_hash: string;
  readonly timestamp_ms: number;
  readonly total_reward_sat: number;
  readonly subsidy_sat: number;
  readonly fees_sat: number;
  readonly worker: string | null;
  readonly username: string | null;
}

export class PoolBlocksRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Upsert N blocks. `height` is the conflict key (Ocean blocks are
   * uniquely identified by their network height). Existing rows are
   * not overwritten - the per-tick observation path may see a block
   * that the backfill already recorded with finer fields, and we'd
   * rather keep the first-write timestamp than reset it.
   */
  async upsertMany(blocks: readonly PoolBlockInsert[], nowMs: number): Promise<void> {
    if (blocks.length === 0) return;
    const rows = blocks.map((b) => ({ ...b, observed_at_ms: nowMs }));
    await this.db
      .insertInto('pool_blocks')
      .values(rows)
      .onConflict((oc) => oc.column('height').doNothing())
      .execute();
  }

  /** Count of blocks with `timestamp_ms >= sinceMs`. */
  async countSince(sinceMs: number): Promise<number> {
    const row = await this.db
      .selectFrom('pool_blocks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('timestamp_ms', '>=', sinceMs)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** ms-epoch of the oldest row, or null if the table is empty. */
  async earliestTimestampMs(): Promise<number | null> {
    const row = await this.db
      .selectFrom('pool_blocks')
      .select('timestamp_ms')
      .orderBy('timestamp_ms', 'asc')
      .limit(1)
      .executeTakeFirst();
    return row ? row.timestamp_ms : null;
  }

  /** Most recent N blocks, newest first. Used by the dashboard's "last pool block" panel. */
  async recent(limit: number): Promise<PoolBlocksTable[]> {
    return this.db
      .selectFrom('pool_blocks')
      .selectAll()
      .orderBy('timestamp_ms', 'desc')
      .limit(limit)
      .execute() as Promise<PoolBlocksTable[]>;
  }

  /**
   * All block timestamps with `timestamp_ms >= sinceMs`, newest
   * first. Feeds `computePoolLuck`'s elapsed-since-last-block
   * input over the matching window.
   */
  async timestampsSince(sinceMs: number): Promise<number[]> {
    const rows = await this.db
      .selectFrom('pool_blocks')
      .select('timestamp_ms')
      .where('timestamp_ms', '>=', sinceMs)
      .orderBy('timestamp_ms', 'desc')
      .execute();
    return rows.map((r) => r.timestamp_ms);
  }

  /**
   * Count of blocks with `startMs <= timestamp_ms <= endMs`. Used by
   * the historical pool-luck recompute (#108 follow-up) to fix
   * tick_metrics rows whose counts were under-reported by the old
   * 15-block-slice logic. `countSince` only bounds the lower edge;
   * this method bounds both so a recompute for a past tick doesn't
   * count blocks that landed after that tick.
   */
  async countInWindow(startMs: number, endMs: number): Promise<number> {
    const row = await this.db
      .selectFrom('pool_blocks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('timestamp_ms', '>=', startMs)
      .where('timestamp_ms', '<=', endMs)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * Highest block height in the table, or null when empty. Used at
   * boot by the alert evaluator's `pool_block_credited` baseline:
   * hydrate `lastNotifiedHeight` from this so the boot-time backfill
   * doesn't fire a Telegram celebration for every historical block
   * the table just got populated with.
   */
  async maxHeight(): Promise<number | null> {
    const row = await this.db
      .selectFrom('pool_blocks')
      .select('height')
      .orderBy('height', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? row.height : null;
  }

  /**
   * Blocks with `height > sinceHeight`, oldest first. Drives the
   * alert evaluator's pool-block-credited celebration: each tick the
   * evaluator pulls everything above its last-notified watermark and
   * fires once per row.
   */
  async sinceHeight(sinceHeight: number): Promise<PoolBlocksTable[]> {
    return this.db
      .selectFrom('pool_blocks')
      .selectAll()
      .where('height', '>', sinceHeight)
      .orderBy('height', 'asc')
      .execute() as Promise<PoolBlocksTable[]>;
  }

  /**
   * Block timestamps with `startMs <= timestamp_ms <= endMs`, newest
   * first. Past-tick variant of `timestampsSince` for the recompute.
   */
  async timestampsInWindow(startMs: number, endMs: number): Promise<number[]> {
    const rows = await this.db
      .selectFrom('pool_blocks')
      .select('timestamp_ms')
      .where('timestamp_ms', '>=', startMs)
      .where('timestamp_ms', '<=', endMs)
      .orderBy('timestamp_ms', 'desc')
      .execute();
    return rows.map((r) => r.timestamp_ms);
  }
}
