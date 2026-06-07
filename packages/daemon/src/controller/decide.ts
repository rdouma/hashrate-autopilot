/**
 * Pure decision function (pay-your-bid controller, #53).
 *
 * Empirical A/B on 2026-04-23 falsified the CLOB assumption behind
 * #49: effective cost tracks the bid, not the fillable ask. Braiins
 * matches pay-your-bid. Lowering the bid directly lowers spend.
 *
 * The controller now targets `fillable_ask + overpay_sat_per_eh_day`
 * every tick, clamped to the usual safety cap
 * `effective_cap = min(max_bid, hashprice + max_overpay_vs_hashprice)`.
 *
 * What this function does:
 *   1. Compute target_price = min(fillable_ask + overpay, effective_cap).
 *      If fillable_ask is null (orderbook down/empty), skip - we have
 *      no reference to track and pinning to max_bid would burn money.
 *   2. If no owned bids → CREATE_BID at target_price, target speed,
 *      wallet budget.
 *   3. If our bid's price ≠ target_price (to tick_size tolerance) →
 *      EDIT_PRICE to target_price. gate.ts enforces Braiins' 10-min
 *      price-decrease cooldown below this layer.
 *   4. If cheap-mode is active, target PH/s becomes cheap_target_hashrate_ph
 *      → EDIT_SPEED if the active bid doesn't reflect that.
 *   5. If multiple owned bids exist → cancel the extras.
 *   6. Unknown bids → PAUSE (SPEC §9 unambiguity requirement).
 *
 * No escalation timers, no lowering-patience window, no min-lower-delta
 * gate - under direct fillable-tracking each tick already proposes the
 * optimal price, and Braiins' own cooldown is the only pacing rule we
 * care about.
 */

import type { Proposal, State } from './types.js';

/**
 * Braiins hard cap on `amount_sat` per bid (SPEC §13: 1 BTC per bid).
 * Used to clamp the resolved budget when `bid_budget_sat = 0`
 * (sentinel for "use full wallet balance"). See issue #40.
 */
const BRAIINS_MAX_AMOUNT_SAT = 100_000_000;

function fmtPricePH(satPerEhDay: number): string {
  const ph = Math.round(satPerEhDay / 1000);
  return `${ph.toLocaleString('en-US')} sat/PH/day`;
}

export function decide(state: State): readonly Proposal[] {
  // Unknown-order ambiguity trumps all other rules (SPEC §9).
  if (state.unknown_bids.length > 0) {
    return [
      {
        kind: 'PAUSE',
        reason: `Unknown bids detected: ${state.unknown_bids.map((b) => b.braiins_order_id).join(', ')}`,
      },
    ];
  }

  // #276: bids Braiins is already unwinding. DELETE /spot/bid is
  // accepted asynchronously - the order lingers in the bids list as
  // BID_STATUS_PENDING_CANCEL (observed for ~3 minutes on 2026-06-06
  // while the seller side couldn't deliver). Treat them as
  // already-gone for mutation purposes: never re-cancel (duplicate
  // markers + wasted mutations), never price/speed-edit a dying
  // order. They still count for the CREATE gate below so a
  // replacement bid is not posted until the old order has actually
  // left the list - two live bids must never overlap.
  const isPendingCancel = (b: { status: string }): boolean =>
    b.status === 'BID_STATUS_PENDING_CANCEL';

  // Cancel all owned bids when Datum stratum has been down for 3+
  // consecutive ticks (#199). No point paying for hashrate that
  // cannot reach the pool.
  const DATUM_DOWN_CANCEL_THRESHOLD = 3;
  if (
    state.datum !== null &&
    state.datum.consecutive_failures >= DATUM_DOWN_CANCEL_THRESHOLD
  ) {
    const cancellable = state.owned_bids.filter((b) => !isPendingCancel(b));
    if (cancellable.length === 0) return [];
    return cancellable.map((bid) => ({
      kind: 'CANCEL_BID' as const,
      braiins_order_id: bid.braiins_order_id,
      reason: `Datum stratum down: ${state.datum!.consecutive_failures} consecutive failures - cancelling to stop spend`,
    }));
  }

  // No pool URL configured - can't create or maintain bids.
  if (!state.config.destination_pool_url) return [];

  // Without a market snapshot we can't price anything.
  if (!state.market) return [];

  const { market, config, owned_bids } = state;

  // Hashprice is needed for the dynamic cap. When the dynamic cap is
  // configured but hashprice is unknown (boot fetch failed, stale
  // cache), refuse to trade rather than silently fall back to the
  // fixed cap - that defeats the whole point of configuring the
  // dynamic cap (#28).
  const hashpriceSatPerPhDay = state.hashprice_sat_per_ph_day;
  const hashpriceSatEh =
    hashpriceSatPerPhDay !== null ? hashpriceSatPerPhDay * 1000 : null;
  const dynamicCapConfigured =
    config.max_overpay_vs_hashprice_sat_per_eh_day !== null;
  if (dynamicCapConfigured && hashpriceSatEh === null) return [];

  const fixedCap = config.max_bid_sat_per_eh_day;
  const dynamicCap =
    dynamicCapConfigured && hashpriceSatEh !== null
      ? hashpriceSatEh + config.max_overpay_vs_hashprice_sat_per_eh_day!
      : null;
  const effectiveCap =
    dynamicCap !== null ? Math.min(fixedCap, dynamicCap) : fixedCap;

  // Pay-your-bid tracking anchor (#53). cheapestAskForDepth is
  // precomputed in observe(). Null = orderbook unavailable; skip
  // rather than default to the cap (that's the exact money-burn this
  // redesign is unwinding).
  const fillable = state.fillable_ask_sat_per_eh_day;
  if (fillable === null) return [];

  const desiredBid = fillable + config.overpay_sat_per_eh_day;
  const targetPrice = Math.min(desiredBid, effectiveCap);
  const cappedByCeiling = desiredBid > effectiveCap;

  // Cheap-mode check (#13 / #50 / #160): opportunistic scale-up when our
  // bid is sustainedly below `cheap_threshold_pct`% of hashprice. Controls
  // target_hashrate_ph only - pricing stays on the fillable-tracking path.
  //
  // Two paths:
  // - `cheap_sustained_window_minutes > 0` (sustained): observe() has done
  //   the full per-tick check for us; we just read `engage`. Every tick in
  //   the window had (fillable + overpay) < threshold% × hashprice AND
  //   the window has enough samples.
  // - `cheap_sustained_window_minutes == 0` (legacy spot): single-tick
  //   check against the CURRENT tick's fillable + overpay vs hashprice.
  //   Same quantity as the sustained path - operator's bid, not best_ask.
  //   The spot path is documented as best-effort and the operator-facing
  //   UI nudges sustained.
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph;
  let effectiveTargetPh = config.target_hashrate_ph;
  let cheapModeActive = false;
  if (cheapEnabled) {
    if (config.cheap_sustained_window_minutes > 0) {
      // Sustained path. observe() has done the work; trust `engage`.
      cheapModeActive = state.cheap_mode_window?.engage === true;
    } else if (
      hashpriceSatEh !== null &&
      hashpriceSatEh > 0 &&
      fillable !== null
    ) {
      // Legacy spot path. Check the price we'd actually post under the
      // current pay-your-bid controller: fillable + overpay.
      const ourBid = fillable + config.overpay_sat_per_eh_day;
      const threshold = hashpriceSatEh * (config.cheap_threshold_pct / 100);
      if (ourBid < threshold) {
        cheapModeActive = true;
      }
    }
    if (cheapModeActive) {
      effectiveTargetPh = config.cheap_target_hashrate_ph;
    }
  }

  const minBidSpeed = Math.max(1.0, market.settings.min_bid_speed_limit_ph ?? 1.0);
  const speedLimitPh = Math.max(minBidSpeed, effectiveTargetPh);
  const tickSize = market.settings.tick_size_sat ?? 1000;
  // Deadband on EDIT_PRICE (#53 fix). fillable_ask jitters ±1-5 sat/PH/day
  // (~1,000-5,000 sat/EH/day) tick-to-tick as distant supply levels
  // reshuffle. With the naive tick_size tolerance, every jitter triggers
  // a mutation - dense trade storm on the chart, API noise, and each
  // lower burns the 10-min cooldown. Scale the deadband to a percentage
  // of overpay: if fillable has moved by less than `pct%` of our overpay
  // cushion, the current bid still sits comfortably above fillable and
  // delivery stays healthy.
  //
  // #222: `bid_edit_deadband_pct` (default 20, preserving the legacy
  // hard-coded `/ 5`). Operator can raise to e.g. 50 to halve edit
  // frequency and tolerate ~2x more price jitter before re-pricing.
  // Useful as a chart-noise reducer today and as a per-edit-fee
  // mitigation if Braiins ever introduces an EDIT_PRICE fee. At the
  // 1,000 sat/PH/day default overpay × 20%, the deadband is
  // ~200 sat/PH/day. Never below tick_size - Braiins would reject a
  // smaller edit anyway.
  const editDeadband = Math.max(
    tickSize,
    Math.floor((config.overpay_sat_per_eh_day * config.bid_edit_deadband_pct) / 100),
  );

  const priceSuffix = cappedByCeiling
    ? ` (clamped to effective cap ${fmtPricePH(effectiveCap)})`
    : ` (fillable ${fmtPricePH(fillable)} + overpay ${fmtPricePH(config.overpay_sat_per_eh_day)})`;

  // Case: no owned bids → CREATE at the target price.
  if (owned_bids.length === 0) {
    // Budget resolution (#40). 0 = use full wallet balance, clamped to
    // 1 BTC. Skip the tick silently when balance is missing or empty.
    let effectiveBudgetSat: number;
    if (config.bid_budget_sat === 0) {
      const availableSat =
        state.balance?.accounts?.[0]?.available_balance_sat ?? null;
      if (availableSat === null || availableSat <= 0) return [];
      effectiveBudgetSat = Math.min(availableSat, BRAIINS_MAX_AMOUNT_SAT);
    } else {
      effectiveBudgetSat = config.bid_budget_sat;
    }

    return [
      {
        kind: 'CREATE_BID',
        price_sat: targetPrice,
        amount_sat: effectiveBudgetSat,
        speed_limit_ph: speedLimitPh,
        dest_pool_url: config.destination_pool_url,
        dest_worker_name: config.destination_pool_worker_name,
        reason: `create at ${fmtPricePH(targetPrice)}${priceSuffix}${cheapModeActive ? ` · cheap mode ${effectiveTargetPh} PH/s` : ''}`,
      },
    ];
  }

  const proposals: Proposal[] = [];

  // Keep one owned bid - cancel any extras. PENDING_CANCEL bids are
  // excluded on both sides (#276): they must not be re-cancelled as
  // extras, and a dying order must not be selected as primary and
  // receive price/speed edits. When every owned bid is pending
  // cancel, do nothing this tick - the CREATE branch above stays
  // gated on the full owned_bids list, so the replacement waits for
  // Braiins to actually drop the old order.
  const actionable = owned_bids.filter((b) => !isPendingCancel(b));
  const [primary, ...extras] = [...actionable].sort((a, b) =>
    a.braiins_order_id.localeCompare(b.braiins_order_id),
  );
  if (!primary) return [];
  for (const extra of extras) {
    proposals.push({
      kind: 'CANCEL_BID',
      braiins_order_id: extra.braiins_order_id,
      reason: 'Multiple owned bids; keeping primary only',
    });
  }

  // Price edit: move the live bid to target_price when it has drifted
  // by more than `editDeadband`. Below the deadband we sit tight - the
  // current bid is still a good approximation of fillable + overpay
  // and each mutation is noise (chart + API). gate.ts enforces
  // Braiins' 10-min price-decrease cooldown below this layer.
  const priceDelta = Math.abs(primary.price_sat - targetPrice);
  if (priceDelta >= editDeadband) {
    proposals.push({
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: targetPrice,
      old_price_sat: primary.price_sat,
      reason: `track fillable: ${fmtPricePH(primary.price_sat)} → ${fmtPricePH(targetPrice)}${priceSuffix}`,
    });
  }

  // Speed edit: when cheap-mode flips in/out, target hashrate changes
  // and the bid's speed_limit needs to match.
  if (
    primary.speed_limit_ph !== null &&
    Math.abs(primary.speed_limit_ph - speedLimitPh) > 0.001
  ) {
    proposals.push({
      kind: 'EDIT_SPEED',
      braiins_order_id: primary.braiins_order_id,
      new_speed_limit_ph: speedLimitPh,
      old_speed_limit_ph: primary.speed_limit_ph,
      reason: `target_hashrate change: speed ${primary.speed_limit_ph} → ${speedLimitPh} PH/s${cheapModeActive ? ' (cheap mode)' : ''}`,
    });
  }

  return proposals;
}

export type { Proposal, State };
