/**
 * Orderbook helpers — pure functions for inspecting ask-side supply.
 *
 * `cheapestAskForDepth` is the depth-aware pricing primitive the
 * controller uses when deciding where to bid. It walks asks in ascending
 * price order, accumulating the **unmatched** supply per level, and
 * returns the price of the first ask whose running total meets or
 * exceeds the requested depth.
 *
 * Critical Braiins-API semantic gotcha (discovered empirically
 * 2026-04-16): the `hr_available_ph` field is the *aggregated capacity*
 * at that price level, not what's open for a new bid. Existing matched
 * orders at the same level compete with yours, so the real supply a new
 * bid can claim is `hr_available_ph − hr_matched_ph`. Observed concrete
 * example: the topmost four asks each had `available == matched` → zero
 * actually open; real unmatched supply only appeared a few ticks up the
 * book. Ignoring `hr_matched_ph` made the daemon bid below a solid
 * matched-level wall and never fill.
 */

export interface OrderbookAsk {
  readonly price_sat: number;
  /** Aggregated capacity offered at this price level (PH/s). */
  readonly hr_available_ph?: number | undefined;
  /** Capacity already matched by existing bids at this level (PH/s). */
  readonly hr_matched_ph?: number | undefined;
}

/**
 * Per-level supply genuinely open for a new bid:
 * `max(0, hr_available_ph − hr_matched_ph)`.
 */
export function unmatchedPh(ask: OrderbookAsk): number {
  const available = Math.max(0, ask.hr_available_ph ?? 0);
  const matched = Math.max(0, ask.hr_matched_ph ?? 0);
  return Math.max(0, available - matched);
}

export interface DepthLookupResult {
  /**
   * Cheapest price at which cumulative `hr_available_ph` ≥ `neededPh`.
   * `null` when the ask side is empty.
   */
  readonly price_sat: number | null;
  /**
   * `true` when the cumulative supply across the whole book is less
   * than `neededPh`. In that case the returned `price_sat` is the
   * highest-priced ask with non-zero supply (best we can do) — bidding
   * at this price captures all the thin supply that exists.
   */
  readonly thin: boolean;
  /**
   * Cumulative PH available up to and including `price_sat` — useful
   * for diagnostics / display.
   */
  readonly cumulative_ph: number;
}

export function cheapestAskForDepth(
  asks: readonly OrderbookAsk[] | undefined,
  neededPh: number,
): DepthLookupResult {
  if (!asks || asks.length === 0) {
    return { price_sat: null, thin: true, cumulative_ph: 0 };
  }

  // Only asks with a positive `hr_available_ph` contribute. A
  // hypothetical negative value is treated as 0.
  const sorted = [...asks]
    .filter((a) => Number.isFinite(a.price_sat))
    .sort((a, b) => a.price_sat - b.price_sat);

  let cumulative = 0;
  let lastNonZeroPrice: number | null = null;
  for (const ask of sorted) {
    const openSupply = unmatchedPh(ask);
    if (openSupply <= 0) continue;
    cumulative += openSupply;
    lastNonZeroPrice = ask.price_sat;
    if (cumulative >= neededPh) {
      return { price_sat: ask.price_sat, thin: false, cumulative_ph: cumulative };
    }
  }

  // Ran out of supply before hitting the target. Fall back to the
  // highest-priced ask with any supply — that's as deep as the book
  // goes and bidding there captures every fillable share.
  return {
    price_sat: lastNonZeroPrice,
    thin: true,
    cumulative_ph: cumulative,
  };
}
