/**
 * Single source of truth for the pool-luck multiplier rendered on
 * both the chart's right axis and the OCEAN panel rows.
 *
 * Formula:
 *
 *   luck = count_in_window / (pool_share × (window_seconds + elapsed) / 600)
 *
 * Where:
 *   - count_in_window = pool blocks observed in [t - window, t]
 *   - pool_share = pool_hashrate_avg / network_hashrate
 *   - elapsed = (t - last_pool_block_in_window). If no block in
 *     window, treat as window itself (catastrophically unlucky but
 *     bounded).
 *   - 600 = expected seconds per block at unit pool_share.
 *
 * Properties matching the operator's intuition:
 *   - At the moment of a find (elapsed == 0): luck reduces to
 *     `count / expected_for_window` - identical reading to the
 *     OCEAN panel's count-vs-expected number.
 *   - Between finds: denominator grows with elapsed; luck decays
 *     continuously as 1/(constant + elapsed). Captures the "we
 *     were supposed to find something but we didn't" pressure.
 *   - On a find: count jumps +1 AND elapsed resets to 0; luck
 *     takes a visible step up from both effects compounding.
 *
 * Caveat: in steady state with average performance, elapsed
 * averages to ~half the expected gap, so luck oscillates slightly
 * below 1.0× even when the pool is finding exactly its expected
 * share. The "luck = 1.0" reading is achieved at the instant of a
 * find when count == expected for the window.
 */

export interface PoolLuckInputs {
  /**
   * Tick timestamp (ms since epoch) the calc is being computed for.
   */
  readonly tickAt: number;
  /**
   * Pool blocks observed in the trailing window. Counted from the
   * same `recent_blocks` list the daemon reads from Ocean.
   */
  readonly countInWindow: number | null;
  /**
   * Trailing-N average of `pool_hashrate_ph` ending at `tickAt`.
   * Drives the denominator's `pool_share` term.
   */
  readonly poolHashrateAvgPh: number | null;
  /**
   * Network difficulty at the tick. Converts to network_hashrate
   * via the standard `(difficulty × 2^32) / 600` formula.
   */
  readonly networkDifficulty: number | null;
  /**
   * Window length in milliseconds (24h or 7d in our two flavors).
   */
  readonly windowMs: number;
  /**
   * Pool block timestamps (ms since epoch). The most recent one
   * within `[tickAt - windowMs, tickAt]` becomes the "elapsed
   * since last block" anchor. Pass an empty array to fall back
   * to the no-blocks-in-window branch.
   */
  readonly recentBlockTimestampsMs: readonly number[];
}

export function computePoolLuck(inputs: PoolLuckInputs): number | null {
  const {
    tickAt,
    countInWindow,
    poolHashrateAvgPh,
    networkDifficulty,
    windowMs,
    recentBlockTimestampsMs,
  } = inputs;
  if (countInWindow === null) return null;
  if (networkDifficulty === null || networkDifficulty <= 0) return null;
  if (poolHashrateAvgPh === null || !Number.isFinite(poolHashrateAvgPh) || poolHashrateAvgPh <= 0) {
    return null;
  }
  const networkHashratePh = (networkDifficulty * 2 ** 32) / 600 / 1e15;
  if (networkHashratePh <= 0) return null;
  const poolShare = poolHashrateAvgPh / networkHashratePh;
  if (poolShare <= 0) return null;

  const windowStart = tickAt - windowMs;
  let lastBlockMs: number | null = null;
  for (const ts of recentBlockTimestampsMs) {
    if (ts > 0 && ts >= windowStart && ts <= tickAt) {
      if (lastBlockMs === null || ts > lastBlockMs) lastBlockMs = ts;
    }
  }
  // No block in window: treat elapsed as the window itself - reads
  // as catastrophically unlucky but doesn't blow up.
  const elapsedMs = lastBlockMs === null ? windowMs : tickAt - lastBlockMs;
  const effectiveSeconds = (windowMs + elapsedMs) / 1000;
  const expected = (poolShare * effectiveSeconds) / 600;
  if (expected <= 0) return null;
  return countInWindow / expected;
}
