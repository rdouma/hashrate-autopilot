/**
 * In-memory cache holding the latest hashprice from Ocean stats.
 *
 * Read by the controller each tick via `getFresh(maxAgeMs)` — values
 * older than `maxAgeMs` are treated as unknown so a silent Ocean
 * outage can't leave decide() pricing against a stale break-even
 * reference (issue #28).
 *
 * Written from two paths:
 *   - main.ts boot: one fetch before the tick loop starts, so the
 *     controller has a hashprice available on tick 1 without waiting
 *     for the dashboard to open.
 *   - finance.ts route: warm-path refresh piggybacking on the
 *     dashboard's existing Ocean poll. No dedicated background
 *     poller — the operator explicitly didn't want minute-by-minute
 *     Ocean calls.
 *
 * Stores internally in sat/PH/day — the same unit used by the rest
 * of the daemon's config and display layer.
 */

export interface HashpriceSnapshot {
  readonly value: number;
  readonly fetchedAtMs: number;
}

export class HashpriceCache {
  private snapshot: HashpriceSnapshot | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Store a hashprice in sat/PH/day with a fetch timestamp. */
  set(satPerPhDay: number | null): void {
    if (satPerPhDay === null) {
      this.snapshot = null;
      return;
    }
    this.snapshot = { value: satPerPhDay, fetchedAtMs: this.now() };
  }

  /**
   * Read the latest hashprice, but only if it's been refreshed within
   * `maxAgeMs`. Older readings return null so decide() falls through
   * to the not-ready gate. `maxAgeMs = Infinity` disables the check
   * and always returns the latest value (used by status routes that
   * want to display whatever we've got).
   */
  getFresh(maxAgeMs: number): number | null {
    if (!this.snapshot) return null;
    if (maxAgeMs === Infinity) return this.snapshot.value;
    const age = this.now() - this.snapshot.fetchedAtMs;
    return age <= maxAgeMs ? this.snapshot.value : null;
  }

  /** Latest snapshot for diagnostics / UI (age computed by caller). */
  peek(): HashpriceSnapshot | null {
    return this.snapshot;
  }
}
