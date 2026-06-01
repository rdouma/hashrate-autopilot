/**
 * #178: backfill difficulty-retarget markers after a daemon outage.
 *
 * The dashboard detects retargets by finding consecutive tick_metrics
 * rows where network_difficulty changes by > 0.5%. During an outage
 * the retarget falls in the gap and gets attributed to the first tick
 * after restart - wrong timestamp. This service runs once at boot
 * (after pool-blocks backfill) and inserts synthetic tick_metrics rows
 * at the estimated retarget time so the chart markers land correctly.
 *
 * Retargets happen every 2016 blocks (~2 weeks). The retarget block
 * height is deterministic: any height where `height % 2016 === 0`.
 * We estimate the retarget timestamp from the nearest pool block and
 * the ~10-min average block interval.
 */

import { sql, type Kysely } from 'kysely';

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database } from '../state/types.js';

const RETARGET_INTERVAL = 2016;
const AVG_BLOCK_TIME_MS = 600_000;
const DIFFICULTY_THRESHOLD = 0.005;

export interface RetargetBackfillDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  /**
   * #241 follow-up: when bitcoindClient is wired, the exact retarget
   * block's timestamp is fetched via `getblockhash` + `getblockheader`
   * and used as the synthetic-tick `tick_at`. This is deterministic
   * and consistent across machines (every node sees the same block
   * header), whereas the legacy nearest-pool-block estimate produces
   * different timestamps on different installs depending on which
   * blocks Ocean had returned to each install at backfill time.
   * Empirical case: Clarent had marker at 2026-05-29 10:59 UTC,
   * Talisman at 2026-05-30 13:11 UTC, actual block 951,552 mined at
   * 2026-05-29 10:29:46 UTC.
   */
  readonly bitcoindClient?: BitcoindClient;
  readonly log?: (msg: string) => void;
}

export async function runRetargetBackfill(deps: RetargetBackfillDeps): Promise<void> {
  const { db, poolBlocksRepo, log = () => {} } = deps;

  // #241: anchor gap detection on REAL polled rows only. If a previous
  // boot's backfill inserted a synthetic tick (potentially at a wrong
  // timestamp from the pre-bitcoind nearest-pool-block estimate), that
  // synthetic row must NOT be the "previous tick" candidate - it has
  // the post-retarget difficulty already, which would falsely make the
  // diff appear stable and short-circuit the re-correction.
  const lastTick = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'network_difficulty'])
    .where('synthetic', '=', 0)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!lastTick || lastTick.network_difficulty == null) return;

  const prevTick = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'network_difficulty'])
    .where('synthetic', '=', 0)
    .where('tick_at', '<', lastTick.tick_at - 180_000)
    .where('network_difficulty', 'is not', null)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!prevTick || prevTick.network_difficulty == null) return;

  const oldDiff = prevTick.network_difficulty;
  const newDiff = lastTick.network_difficulty;
  if (Math.abs(newDiff - oldDiff) / oldDiff < DIFFICULTY_THRESHOLD) return;

  const gapStart = prevTick.tick_at;
  const gapEnd = lastTick.tick_at;
  const gapMs = gapEnd - gapStart;
  if (gapMs < 300_000) return;

  const maxHeight = await poolBlocksRepo.maxHeight();
  if (maxHeight == null) return;

  const latestRetargetHeight = Math.floor(maxHeight / RETARGET_INTERVAL) * RETARGET_INTERVAL;

  // #241 follow-up: prefer bitcoind's authoritative block-header
  // timestamp for the retarget block itself. Two batched RPC calls.
  // Falls back to the legacy nearest-pool-block estimate when
  // bitcoindClient is unavailable - that path is the historical
  // behavior preserved verbatim.
  let estimatedRetargetMs: number | null = null;
  let timestampSource: 'bitcoind' | 'nearest-pool-block' = 'nearest-pool-block';
  if (deps.bitcoindClient) {
    try {
      const hash = await deps.bitcoindClient.batch<string>([
        { method: 'getblockhash', params: [latestRetargetHeight] },
      ]);
      const header = await deps.bitcoindClient.batch<{ time: number }>([
        { method: 'getblockheader', params: [hash[0], true] },
      ]);
      if (header[0]?.time) {
        estimatedRetargetMs = header[0].time * 1000;
        timestampSource = 'bitcoind';
      }
    } catch (err) {
      log(
        `[retarget-backfill] bitcoind lookup for retarget block ${latestRetargetHeight} failed (${(err as Error).message}); falling back to nearest-pool-block estimate`,
      );
    }
  }
  if (estimatedRetargetMs === null) {
    const nearestBlock = await db
      .selectFrom('pool_blocks')
      .select(['height', 'timestamp_ms'])
      .orderBy(sql`ABS(height - ${latestRetargetHeight})`)
      .limit(1)
      .executeTakeFirst();
    if (!nearestBlock) return;
    estimatedRetargetMs =
      nearestBlock.timestamp_ms - (nearestBlock.height - latestRetargetHeight) * AVG_BLOCK_TIME_MS;
  }

  if (estimatedRetargetMs <= gapStart || estimatedRetargetMs >= gapEnd) {
    log(`[retarget-backfill] estimated retarget at ${new Date(estimatedRetargetMs).toISOString()} (source: ${timestampSource}) is outside gap ${new Date(gapStart).toISOString()}..${new Date(gapEnd).toISOString()}, skipping`);
    return;
  }

  // #241: clear ANY synthetic ticks that fell inside the detected gap.
  // A previous boot may have inserted one at a wrong timestamp (legacy
  // nearest-pool-block estimate before bitcoind was wired). Deleting
  // strictly inside (gapStart, gapEnd) is safe - real polled rows
  // can't exist in the outage window by definition - and lets the
  // current run re-insert at the now-canonical timestamp without
  // leaving the wrong-time marker behind.
  const cleared = await db
    .deleteFrom('tick_metrics')
    .where('synthetic', '=', 1)
    .where('tick_at', '>', gapStart)
    .where('tick_at', '<', gapEnd)
    .executeTakeFirst();
  if (cleared.numDeletedRows > 0n) {
    log(`[retarget-backfill] cleared ${cleared.numDeletedRows} stale synthetic tick(s) inside gap before re-insert`);
  }

  // Template the new synthetic row off the last REAL polled row before
  // the gap (synthetic=0). Anchoring on a real row keeps copied fields
  // (hashrate, pool stats, etc.) representative rather than inheriting
  // values from another backfill row.
  const templateTick = await db
    .selectFrom('tick_metrics')
    .selectAll()
    .where('synthetic', '=', 0)
    .where('tick_at', '<=', gapStart)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!templateTick) return;

  const { id: _id, synthetic: _syn, ...rest } = templateTick;
  await db
    .insertInto('tick_metrics')
    .values({
      ...rest,
      tick_at: estimatedRetargetMs,
      network_difficulty: newDiff,
      synthetic: 1,
    })
    .execute();

  const pctChange = (((newDiff - oldDiff) / oldDiff) * 100).toFixed(2);
  log(`[retarget-backfill] inserted synthetic tick at ${new Date(estimatedRetargetMs).toISOString()} (source: ${timestampSource}) for retarget at height ${latestRetargetHeight} (difficulty ${pctChange > '0' ? '+' : ''}${pctChange}%)`);
}
