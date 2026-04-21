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
 * forecast. Used by both the P&L panel's "projected spend/day" and
 * the Braiins panel's runway calculation.
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
