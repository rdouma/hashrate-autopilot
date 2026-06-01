/**
 * #108 follow-up: one-time historical recompute of
 * `tick_metrics.pool_blocks_24h_count`, `pool_blocks_7d_count`,
 * `pool_luck_24h`, `pool_luck_7d`, `paid_total_sat`, and
 * `ocean_unpaid_sat`.
 *
 * Why this exists:
 *
 * 1. Before #108 the per-tick counts came from Ocean's
 *    `recent_blocks.slice(0, 15)` filtered to the trailing window.
 *    The 15-block slice cap was binding for the 7-day window (Ocean
 *    finds ~3/day, so 15 blocks covers only ~5 days), so any blocks
 *    5-7 days old at tick time were silently dropped. The historical
 *    luck line was systematically biased low.
 *
 * 2. `network_difficulty` and `pool_hashrate_ph_avg_*` only started
 *    being captured per-tick at migrations 0053 / 0056. Older ticks
 *    have null inputs and the original write skipped them - even
 *    though both values are recoverable: difficulty changes only on
 *    retarget (~2 weeks), pool hashrate drifts slowly. We backfill
 *    those inputs from the nearest non-null tick at recompute time
 *    so older ticks become computable too.
 *
 * Together: this service walks every tick_metrics row whose 7d
 * window is covered by `pool_blocks`, gathers the formula inputs
 * (using nearest-non-null fallbacks where the row's own value is
 * null), and writes the recomputed counts + luck back.
 *
 * Bonus pass: cumulative `paid_total_sat` (exact - from
 * `reward_events.value_sat` running sum). Filled only on rows where
 * the column is currently null.
 *
 * NOT recomputed: `ocean_unpaid_sat`. The earlier attempt to
 * reconstruct it from `pool_block.total_reward_sat × share_log_pct`
 * was empirically wrong - share_log_pct is the operator's share at
 * a given tick, which varies as the operator's mining activity
 * varies, so using a fallback share_log for blocks earlier than
 * share_log capture began wildly overcredits past blocks. Operator
 * caught it on the chart and asked for the assumption rolled back.
 * The on-boot cleanup that pairs with this commit (in main.ts)
 * nulls out any reconstructed values that previously got written.
 *
 * Idempotent: subsequent boots see no change and no-op cheaply.
 */

import type { Kysely } from 'kysely';

import { computePoolLuck } from './pool-luck.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database } from '../state/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

export interface PoolLuckRecomputeDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log?: (msg: string) => void;
}

export async function runPoolLuckRecompute(deps: PoolLuckRecomputeDeps): Promise<void> {
  const log = deps.log ?? (() => undefined);

  const earliestBlock = await deps.poolBlocksRepo.earliestTimestampMs().catch(() => null);
  if (earliestBlock === null) {
    log('pool-luck-recompute: pool_blocks empty, nothing to recompute');
    return;
  }

  // Eligible window for REAL polled rows (synthetic = 0): ticks
  // whose 30d window starts at or after the earliest pool_block we
  // have. Below this, the count would be partial-by-pool_blocks-
  // coverage rather than real-pool-find history, and we'd lower
  // the count to a wrong value. Conservative.
  //
  // For SYNTHETIC rows (gap-fill, synthetic = 1) the eligibility
  // gate does NOT apply: their write-time pool_luck is NULL, and
  // a partial-coverage recompute is strictly better than null.
  // #241 root cause: a fresh-install machine (Taliesin) has
  // pool_blocks back only LOOKBACK_FLOOR_DAYS = 30 days, so
  // earliestEligibleTick lands ~today and the gate skipped every
  // gap-synthetic tick - leaving them with null pool_luck_30d and
  // the chart linearly interpolating across the gap. The
  // synthetic-bypass below fixes that.
  const earliestEligibleTick = earliestBlock + 30 * DAY_MS;

  // Pre-load nearest-non-null lookup tables for the formula inputs
  // that older ticks predate. Both are slow-moving (difficulty
  // retargets every ~2 weeks; pool hashrate drifts a few % per day),
  // so a nearest-by-time backfill is a perfectly reasonable
  // reconstruction for the chart.
  const [diffSeries, ph24Series, ph7Series, ph30Series] = await Promise.all([
    loadSeries(deps.db, 'network_difficulty'),
    loadSeries(deps.db, 'pool_hashrate_ph_avg_24h'),
    loadSeries(deps.db, 'pool_hashrate_ph_avg_7d'),
    loadSeries(deps.db, 'pool_hashrate_ph_avg_30d'),
  ]);

  if (diffSeries.length === 0 || ph24Series.length === 0 || ph7Series.length === 0) {
    log(
      `pool-luck-recompute: insufficient input series (diff=${diffSeries.length}, ph24=${ph24Series.length}, ph7=${ph7Series.length}); skipping`,
    );
    return;
  }

  // Pre-build the cumulative-payouts timeline for paid_total_sat.
  // The on-chain ledger is exact - reward_events captures every
  // payout and we just sum value_sat up to each tick.
  const payouts = await loadPayouts(deps.db);

  let totalScanned = 0;
  let totalUpdated = 0;
  let syntheticUpdated = 0;
  // Start the cursor at -1 (i.e., scan from the very first tick)
  // rather than at earliestEligibleTick - 1. The per-row WHERE
  // below enforces the eligibility gate FOR REAL ROWS but lets
  // synthetic rows through unconditionally.
  let cursorTickAt = -1;
  let cumPaidSat = 0;
  let payoutPtr = 0;

  /* eslint-disable no-await-in-loop */
  while (true) {
    const batch = await deps.db
      .selectFrom('tick_metrics')
      .select([
        'id',
        'tick_at',
        'pool_blocks_24h_count',
        'pool_blocks_7d_count',
        'pool_blocks_30d_count',
        'pool_luck_24h',
        'pool_luck_7d',
        'pool_luck_30d',
        'pool_hashrate_ph_avg_24h',
        'pool_hashrate_ph_avg_7d',
        'pool_hashrate_ph_avg_30d',
        'network_difficulty',
        'paid_total_sat',
        'ocean_unpaid_sat',
        'synthetic',
      ])
      .where('tick_at', '>', cursorTickAt)
      // Eligibility gate: real rows must be past earliestEligibleTick
      // so a partial pool_blocks coverage doesn't lower their
      // write-time-correct count. Synthetic rows bypass the gate -
      // they have NULL pool_luck and a partial recompute beats null.
      .where((eb) =>
        eb.or([
          eb('tick_at', '>=', earliestEligibleTick),
          eb('synthetic', '=', 1),
        ]),
      )
      .orderBy('tick_at', 'asc')
      .limit(BATCH_SIZE)
      .execute();

    if (batch.length === 0) break;

    for (const row of batch) {
      cursorTickAt = row.tick_at;
      totalScanned += 1;

      const tickAt = row.tick_at;
      const [count24, count7, count30, ts24, ts7, ts30] = await Promise.all([
        deps.poolBlocksRepo.countInWindow(tickAt - DAY_MS, tickAt),
        deps.poolBlocksRepo.countInWindow(tickAt - 7 * DAY_MS, tickAt),
        deps.poolBlocksRepo.countInWindow(tickAt - 30 * DAY_MS, tickAt),
        deps.poolBlocksRepo.timestampsInWindow(tickAt - DAY_MS, tickAt),
        deps.poolBlocksRepo.timestampsInWindow(tickAt - 7 * DAY_MS, tickAt),
        deps.poolBlocksRepo.timestampsInWindow(tickAt - 30 * DAY_MS, tickAt),
      ]);

      const networkDifficulty = row.network_difficulty ?? nearest(diffSeries, tickAt);
      const ph24 = row.pool_hashrate_ph_avg_24h ?? nearest(ph24Series, tickAt);
      const ph7 = row.pool_hashrate_ph_avg_7d ?? nearest(ph7Series, tickAt);
      const ph30 = row.pool_hashrate_ph_avg_30d ?? nearest(ph30Series, tickAt);

      const luck24 = computePoolLuck({
        tickAt,
        countInWindow: count24,
        poolHashrateAvgPh: ph24,
        networkDifficulty,
        windowMs: DAY_MS,
        recentBlockTimestampsMs: ts24,
      });
      const luck7 = computePoolLuck({
        tickAt,
        countInWindow: count7,
        poolHashrateAvgPh: ph7,
        networkDifficulty,
        windowMs: 7 * DAY_MS,
        recentBlockTimestampsMs: ts7,
      });
      const luck30 = computePoolLuck({
        tickAt,
        countInWindow: count30,
        poolHashrateAvgPh: ph30,
        networkDifficulty,
        windowMs: 30 * DAY_MS,
        recentBlockTimestampsMs: ts30,
      });

      // Advance the payout cursor past anything that happened on or
      // before this tick. Sorted ascending, so amortized O(1) per row.
      while (payoutPtr < payouts.length && payouts[payoutPtr]!.at_ms <= tickAt) {
        cumPaidSat += payouts[payoutPtr]!.value_sat;
        payoutPtr += 1;
      }

      // paid_total_sat: exact - cumulative on-chain payouts. Always
      // reconstructible. Overwriting is safe because the formula
      // matches the original write-side (see RewardEventsRepo).
      const paidTotal = cumPaidSat;

      // Skip if nothing actually changes (idempotent re-runs no-op).
      if (
        row.pool_blocks_24h_count === count24 &&
        row.pool_blocks_7d_count === count7 &&
        row.pool_blocks_30d_count === count30 &&
        approxEq(row.pool_luck_24h, luck24) &&
        approxEq(row.pool_luck_7d, luck7) &&
        approxEq(row.pool_luck_30d, luck30) &&
        row.paid_total_sat === paidTotal
      ) {
        continue;
      }

      await deps.db
        .updateTable('tick_metrics')
        .set({
          pool_blocks_24h_count: count24,
          pool_blocks_7d_count: count7,
          pool_blocks_30d_count: count30,
          pool_luck_24h: luck24,
          pool_luck_7d: luck7,
          pool_luck_30d: luck30,
          paid_total_sat: paidTotal,
        })
        .where('id', '=', row.id)
        .execute();
      totalUpdated += 1;
      if (row.synthetic === 1) syntheticUpdated += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  log(
    `pool-luck-recompute: scanned ${totalScanned}, updated ${totalUpdated} tick_metrics row(s) (${syntheticUpdated} synthetic) using pool_blocks data`,
  );
}

/**
 * Pre-load every non-null (tick_at, value) pair for one column.
 * Sorted by tick_at ascending. Used by `nearest()` for O(log N)
 * lookups during the recompute scan.
 */
async function loadSeries(
  db: Kysely<Database>,
  column:
    | 'network_difficulty'
    | 'pool_hashrate_ph_avg_24h'
    | 'pool_hashrate_ph_avg_7d'
    | 'pool_hashrate_ph_avg_30d',
): Promise<readonly { readonly tick_at: number; readonly value: number }[]> {
  const rows = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', column])
    .where(column, 'is not', null)
    .orderBy('tick_at', 'asc')
    .execute();
  return rows.map((r) => ({ tick_at: r.tick_at, value: (r as Record<string, number>)[column]! }));
}

/**
 * Binary search for the (tick_at, value) entry whose tick_at is
 * closest to the target. Used to fill missing per-tick inputs from
 * the nearest-known sample. Both inputs (difficulty + pool hashrate
 * average) are slow-moving so nearest-by-time is a faithful
 * reconstruction.
 */
function nearest(
  series: readonly { readonly tick_at: number; readonly value: number }[],
  target: number,
): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.tick_at < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is now the smallest index with tick_at >= target. Check the
  // entry just before it for actually-closer time delta.
  const above = series[lo]!;
  if (lo === 0) return above.value;
  const below = series[lo - 1]!;
  return target - below.tick_at <= above.tick_at - target ? below.value : above.value;
}

function approxEq(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Within 1e-6 - the recompute uses the same formula as the
  // original write, so any difference is float jitter.
  return Math.abs(a - b) < 1e-6;
}

/**
 * Cumulative-payouts source for the paid_total recompute. Excludes
 * reorged rows; the on-chain ledger is the ground truth.
 */
async function loadPayouts(
  db: Kysely<Database>,
): Promise<readonly { readonly at_ms: number; readonly value_sat: number }[]> {
  const rows = await db
    .selectFrom('reward_events')
    .select(['detected_at', 'value_sat'])
    .where('reorged', '=', 0)
    .orderBy('detected_at', 'asc')
    .execute();
  return rows.map((r) => ({ at_ms: r.detected_at, value_sat: r.value_sat }));
}
