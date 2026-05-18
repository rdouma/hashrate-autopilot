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

import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database } from '../state/types.js';

const RETARGET_INTERVAL = 2016;
const AVG_BLOCK_TIME_MS = 600_000;
const DIFFICULTY_THRESHOLD = 0.005;

export interface RetargetBackfillDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log?: (msg: string) => void;
}

export async function runRetargetBackfill(deps: RetargetBackfillDeps): Promise<void> {
  const { db, poolBlocksRepo, log = () => {} } = deps;

  const lastTick = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'network_difficulty'])
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!lastTick || lastTick.network_difficulty == null) return;

  const prevTick = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'network_difficulty'])
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

  const nearestBlock = await db
    .selectFrom('pool_blocks')
    .select(['height', 'timestamp_ms'])
    .orderBy(sql`ABS(height - ${latestRetargetHeight})`)
    .limit(1)
    .executeTakeFirst();
  if (!nearestBlock) return;

  const estimatedRetargetMs =
    nearestBlock.timestamp_ms - (nearestBlock.height - latestRetargetHeight) * AVG_BLOCK_TIME_MS;

  if (estimatedRetargetMs <= gapStart || estimatedRetargetMs >= gapEnd) {
    log(`[retarget-backfill] estimated retarget at ${new Date(estimatedRetargetMs).toISOString()} is outside gap ${new Date(gapStart).toISOString()}..${new Date(gapEnd).toISOString()}, skipping`);
    return;
  }

  const existing = await db
    .selectFrom('tick_metrics')
    .select('tick_at')
    .where('tick_at', '>=', estimatedRetargetMs - 60_000)
    .where('tick_at', '<=', estimatedRetargetMs + 60_000)
    .executeTakeFirst();
  if (existing) {
    log(`[retarget-backfill] tick already exists near retarget time, skipping`);
    return;
  }

  const templateTick = await db
    .selectFrom('tick_metrics')
    .selectAll()
    .where('tick_at', '<=', gapStart)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!templateTick) return;

  const { id: _id, ...rest } = templateTick;
  await db
    .insertInto('tick_metrics')
    .values({
      ...rest,
      tick_at: estimatedRetargetMs,
      network_difficulty: newDiff,
    })
    .execute();

  const pctChange = (((newDiff - oldDiff) / oldDiff) * 100).toFixed(2);
  log(`[retarget-backfill] inserted synthetic tick at ${new Date(estimatedRetargetMs).toISOString()} for retarget at height ${latestRetargetHeight} (difficulty ${pctChange > '0' ? '+' : ''}${pctChange}%)`);
}
