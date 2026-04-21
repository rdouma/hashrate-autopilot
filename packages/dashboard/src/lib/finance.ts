/**
 * Shared finance-math helpers. Lives here so multiple panels can
 * agree on what "projected spend per day" means without drifting
 * into two copies with subtly different rounding or filtering.
 */

interface BidForSpend {
  readonly is_owned: boolean;
  readonly status: string;
  readonly price_sat_per_ph_day: number;
  readonly avg_speed_ph: number;
  readonly speed_limit_ph: number | null;
}

/**
 * Sum of `price × effective_speed` across active owned bids.
 * Effective speed is the min of `avg_speed_ph` and `speed_limit_ph`
 * so a bid whose delivery overshoots the cap doesn't inflate the
 * forecast.
 *
 * Instantaneous — uses whatever `avg_speed_ph` Braiins returned on the
 * current tick, which wobbles noticeably minute-to-minute. The panels
 * that render this figure should prefer `projectedDailySpendSat3h`
 * (which smooths over the last 3 h of delivered hashrate from our own
 * `tick_metrics` series); this inner helper stays exported for tests
 * and for the fallback path when no 3 h window is available yet.
 */
export function projectedDailySpendSat(bids: readonly BidForSpend[]): number {
  return bids
    .filter((b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE')
    .reduce((sum, b) => {
      const effSpeed =
        b.speed_limit_ph !== null
          ? Math.min(b.avg_speed_ph, b.speed_limit_ph)
          : b.avg_speed_ph;
      return sum + b.price_sat_per_ph_day * effSpeed;
    }, 0);
}

/**
 * 3-hour-smoothed version of `projectedDailySpendSat`. Uses a rolling
 * 3 h average of total delivered hashrate (`avg_delivered_ph_3h` from
 * `/api/status`, sourced from `tick_metrics`) instead of the current
 * tick's per-bid `avg_speed_ph`, and spreads it across active owned
 * bids via a capacity-weighted average of their prices.
 *
 * Single-bid case (the common one): collapses to
 *   `price × avg_delivered_ph_3h`
 * which is exactly what the operator expects from a "what am I
 * spending per day at my current rate" number — it tracks 3-hour
 * delivery, not the per-tick wobble.
 *
 * Falls back to the instantaneous figure when no 3 h window is
 * available yet (fresh install, pruned history) or when there are no
 * active owned bids.
 */
export function projectedDailySpendSat3h(
  bids: readonly BidForSpend[],
  avgDeliveredPh3h: number | null,
): number {
  const active = bids.filter((b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE');
  if (active.length === 0) return 0;
  if (avgDeliveredPh3h === null || avgDeliveredPh3h <= 0) {
    return projectedDailySpendSat(active);
  }

  // Capacity-weighted average price across active bids. For a single
  // active bid this is just that bid's price; for multi-bid setups it
  // weights by `speed_limit_ph` so a 1 PH/s bid at 50k doesn't outvote
  // a 4 PH/s bid at 48k. Evenly weighted when no limits are set.
  const limitSum = active.reduce((s, b) => s + (b.speed_limit_ph ?? 0), 0);
  const weightedPrice =
    limitSum > 0
      ? active.reduce((s, b) => s + b.price_sat_per_ph_day * (b.speed_limit_ph ?? 0), 0) /
        limitSum
      : active.reduce((s, b) => s + b.price_sat_per_ph_day, 0) / active.length;

  return weightedPrice * avgDeliveredPh3h;
}
