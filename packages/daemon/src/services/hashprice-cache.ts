/**
 * Tiny in-memory cache holding the latest hashprice from Ocean stats.
 *
 * Updated by the finance route (which already fetches Ocean stats on
 * every poll) and read by the controller's decide() function to
 * evaluate the cheap-hashrate threshold.
 *
 * Stores internally in sat/PH/day — the same unit used by the rest
 * of the daemon's config and display layer.
 */
export class HashpriceCache {
  private value: number | null = null;

  /** Store a hashprice in sat/PH/day (the unit Ocean already returns). */
  set(satPerPhDay: number | null): void {
    this.value = satPerPhDay;
  }

  /** Read the latest hashprice in sat/PH/day, or null if unknown. */
  get(): number | null {
    return this.value;
  }
}
