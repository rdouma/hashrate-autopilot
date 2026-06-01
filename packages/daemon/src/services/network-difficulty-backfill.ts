/**
 * #230: boot-time backfill of `tick_metrics.network_difficulty` from
 * bitcoind.
 *
 * Why: the `network_difficulty` column was added by a later migration
 * (and the source observation by a later daemon version), so any tick
 * row recorded before that point sits at `NULL`. The chart honors
 * the gap, so the difficulty line shows up mid-history. Network
 * difficulty IS fully reconstructible from any Bitcoin block header
 * (every header carries the difficulty target), and the operator
 * already runs bitcoind for payout observation. This service walks
 * the gap on boot and fills what it can.
 *
 * Idempotent: second boot finds zero (or fewer) NULL ticks and either
 * skips or backfills only the remainder. **Never overwrites** -
 * `updateDifficultyForNullRange()` has an `IS NULL` guard on every
 * write so a live observation that landed after the backfill is
 * never clobbered.
 *
 * Bounded: at the worst (a year of NULL ticks) this does ~26
 * epoch-boundary queries against bitcoind plus a handful of UPDATEs.
 * Sub-second on a healthy node. Caps the height range at the tip
 * to avoid asking bitcoind for non-existent future blocks; clips
 * pre-genesis estimates at 0.
 *
 * Graceful failure: bitcoind not configured, unreachable, or
 * returning errors → log a one-line note and skip. The next boot
 * re-tries.
 */

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';

const SECS_PER_BLOCK_TARGET = 600;
const BLOCKS_PER_EPOCH = 2016;
/**
 * Safety margin on the estimated block heights. Block-time variance
 * (a couple of slow / fast weeks) can push the tip ↔ tick mapping off
 * by ~100 blocks across a year. Pad both ends so we never miss a
 * relevant epoch boundary.
 */
const HEIGHT_SAFETY_BUFFER = 200;

export interface NetworkDifficultyBackfillDeps {
  readonly bitcoindClient: BitcoindClient;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly log?: (msg: string) => void;
}

export async function runNetworkDifficultyBackfill(
  deps: NetworkDifficultyBackfillDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);

  // 1. Range scan. Skip when there's nothing to do.
  const range = await deps.tickMetricsRepo.nullDifficultyRange().catch((e) => {
    log(`network_difficulty backfill: range scan failed: ${(e as Error).message}`);
    return null;
  });
  if (!range || range.count === 0 || range.earliest_tick_at === null || range.latest_tick_at === null) {
    return;
  }

  // 2. Tip info from bitcoind. This is the first network call -
  // failures here are how we detect "bitcoind not reachable" and
  // bail silently.
  let tipHeight: number;
  let tipTimeSecs: number;
  try {
    const info = await deps.bitcoindClient.getBlockchainInfo();
    tipHeight = info.blocks;
    const tipHeader = await deps.bitcoindClient.getBlockHeader(info.bestblockhash);
    tipTimeSecs = tipHeader.time;
  } catch (e) {
    log(`network_difficulty backfill: bitcoind unreachable, skipping (${(e as Error).message})`);
    return;
  }

  // 3. Estimate the height range that bounds the NULL ticks. Block
  // time is target 600s but actual is noisy; the safety buffer
  // absorbs the noise. Clamp at the tip height (can't query
  // future blocks) and at 0 (can't query pre-genesis).
  const earliestSecs = Math.floor(range.earliest_tick_at / 1000);
  const latestSecs = Math.floor(range.latest_tick_at / 1000);
  const rawEarliestHeight =
    tipHeight - Math.ceil((tipTimeSecs - earliestSecs) / SECS_PER_BLOCK_TARGET) - HEIGHT_SAFETY_BUFFER;
  const rawLatestHeight =
    tipHeight - Math.floor((tipTimeSecs - latestSecs) / SECS_PER_BLOCK_TARGET) + HEIGHT_SAFETY_BUFFER;
  const earliestHeight = Math.max(0, rawEarliestHeight);
  const latestHeight = Math.min(tipHeight, Math.max(earliestHeight, rawLatestHeight));

  // 4. Identify the epoch boundaries to query. We need one boundary
  // before the earliest NULL tick (to know which difficulty applied
  // at that time) and one boundary after the latest (to know where
  // the last applicable epoch ends). Walk in 2016-block strides.
  const firstEpoch = Math.floor(earliestHeight / BLOCKS_PER_EPOCH);
  const lastEpoch = Math.floor(latestHeight / BLOCKS_PER_EPOCH);
  const epochStarts: number[] = [];
  for (let e = firstEpoch; e <= lastEpoch + 1; e += 1) {
    const h = e * BLOCKS_PER_EPOCH;
    if (h > tipHeight) break;
    if (h < 0) continue;
    epochStarts.push(h);
  }
  if (epochStarts.length === 0) {
    log(`network_difficulty backfill: estimated height range had no valid epoch starts; skipping`);
    return;
  }

  // 5. Two-batch fetch of (hash → header) for every boundary. Same
  // pattern as payout-observer's BIP-110 / reward-event paths.
  let boundaries: Array<{ height: number; time_ms: number; difficulty: number }>;
  try {
    const hashes = await deps.bitcoindClient.batch<string>(
      epochStarts.map((h) => ({ method: 'getblockhash', params: [h] })),
    );
    const headers = await deps.bitcoindClient.batch<{ difficulty: number; time: number }>(
      hashes.map((h) => ({ method: 'getblockheader', params: [h, true] })),
    );
    boundaries = epochStarts.map((height, i) => ({
      height,
      time_ms: headers[i]!.time * 1000,
      difficulty: headers[i]!.difficulty,
    }));
  } catch (e) {
    log(`network_difficulty backfill: epoch-boundary fetch failed (${(e as Error).message})`);
    return;
  }

  // Each boundary entry `i` corresponds to the FIRST block of an
  // epoch and carries that epoch's difficulty. So ticks with
  // `time_ms` ∈ [boundaries[i].time_ms, boundaries[i+1].time_ms) get
  // `boundaries[i].difficulty`. Ticks before boundaries[0].time_ms
  // need the *previous* epoch's difficulty, which we didn't query;
  // gate those out (they fall outside our coverage window and stay
  // NULL on this pass).
  let totalUpdated = 0;
  for (let i = 0; i < boundaries.length; i += 1) {
    const fromMs = boundaries[i]!.time_ms;
    const toMs = i + 1 < boundaries.length ? boundaries[i + 1]!.time_ms : Number.MAX_SAFE_INTEGER;
    const difficulty = boundaries[i]!.difficulty;
    const updated = await deps.tickMetricsRepo
      .updateDifficultyForNullRange(fromMs, toMs, difficulty)
      .catch((e) => {
        log(`network_difficulty backfill: UPDATE for epoch starting ${boundaries[i]!.height} failed (${(e as Error).message})`);
        return 0;
      });
    totalUpdated += updated;
  }

  log(
    `network_difficulty backfill: filled ${totalUpdated} of ${range.count} NULL ticks across ${boundaries.length} epoch boundary lookup(s)`,
  );
}
