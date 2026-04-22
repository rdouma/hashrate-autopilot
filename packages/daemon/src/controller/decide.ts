/**
 * Pure decision function.
 *
 * Pricing strategy (SPEC §9; M4.7):
 *
 *   1. Find the **cheapest ask at which our full `target_hashrate_ph`
 *      is fillable** by walking asks cumulatively (see
 *      `cheapestAskForDepth`). The naive "topmost ask with any non-zero
 *      supply" approach strands us when the cheapest ask offers only
 *      a sliver of hashrate.
 *   2. `target_price = min(fillable + overpay, max_bid)`.
 *   3. If fillable + overpay > max_bid: skip this tick silently.
 *   4. Escalation (upward adjustments): when below floor too long:
 *      - 'market' mode: jump directly to target_price (track market)
 *      - 'dampened' mode: step from current_bid + escalation_step
 *        (capped at target_price, avoids chasing spikes)
 *   5. Lowering (downward adjustments): when primary > target, jump
 *      directly to target. No dampening downward — trust the operator's
 *      overpay setting.
 *
 * Unknown bids → PAUSE (SPEC §9 unknown-order detection).
 * Duplicate owned bids → cancel the extras.
 */

import { cheapestAskForDepth } from './orderbook.js';
import type { Proposal, State } from './types.js';

/**
 * Tolerance band for an EDIT_PRICE proposal. We want to avoid thrashing on
 * sub-tick noise; only act when the target has moved by more than 0.5% of
 * the target price.
 */
const EDIT_PRICE_TOLERANCE_PCT = 0.005;

/**
 * Braiins hard cap on `amount_sat` per bid (SPEC §13: 1 BTC per bid).
 * Used to clamp the resolved budget when `bid_budget_sat = 0`
 * (sentinel for "use full wallet balance"). See issue #40.
 */
const BRAIINS_MAX_AMOUNT_SAT = 100_000_000;

/**
 * Format a sat/EH/day value as `12,345 sat/PH/day` for human-readable
 * `reason` strings. The dashboard surfaces these verbatim — keeping the
 * unit consistent with the rest of the UI (which is sat/PH/day) avoids
 * the operator having to convert in their head.
 */
function fmtPricePH(satPerEhDay: number): string {
  const ph = Math.round(satPerEhDay / 1000);
  return `${ph.toLocaleString('en-US')} sat/PH/day`;
}

export function decide(state: State): readonly Proposal[] {
  // 1. Unknown-order ambiguity trumps all other rules (SPEC §9).
  if (state.unknown_bids.length > 0) {
    return [
      {
        kind: 'PAUSE',
        reason: `unknown_bids_present: ${state.unknown_bids.map((b) => b.braiins_order_id).join(', ')}`,
      },
    ];
  }

  // Without a market snapshot we can't compute target_price.
  if (!state.market) return [];

  const { market, config, owned_bids } = state;
  const asks = market.orderbook.asks ?? [];
  if (asks.length === 0) return [];

  // 2. Depth-aware target: cheapest price at which our full target
  //    hashrate is fillable. Replaces the old "first ask with any
  //    non-zero supply" lookup, which was fooled by slivers of supply
  //    at the top of the book.
  const baseFillable = cheapestAskForDepth(asks, config.target_hashrate_ph);
  const cheapestAvailable = baseFillable.price_sat;
  if (cheapestAvailable === null) return []; // nothing for sale

  // Opportunistic scaling (issue #13): when the market price is cheap
  // relative to the break-even hashprice, scale up to a larger target.
  // The comparison uses the cheapest ask for the *normal* target — if
  // that's below the threshold, the market is genuinely cheap.
  const hashpriceSatPerPhDay = state.hashprice_sat_per_ph_day;
  // Convert hashprice from sat/PH/day to sat/EH/day for comparison
  // with ask prices (which are in sat/EH/day internally).
  const hashpriceSatEh =
    hashpriceSatPerPhDay !== null ? hashpriceSatPerPhDay * 1000 : null;
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph &&
    hashpriceSatEh !== null &&
    hashpriceSatEh > 0;

  let effectiveTargetPh = config.target_hashrate_ph;
  let cheapModeActive = false;
  if (cheapEnabled) {
    const threshold = hashpriceSatEh! * (config.cheap_threshold_pct / 100);
    if (cheapestAvailable < threshold) {
      effectiveTargetPh = config.cheap_target_hashrate_ph;
      cheapModeActive = true;
    }
  }

  // If cheap mode activated, re-lookup fillable with the larger target
  // so pricing accounts for the deeper depth needed.
  const fillable = cheapModeActive
    ? cheapestAskForDepth(asks, effectiveTargetPh)
    : baseFillable;
  const effectiveCheapestAvailable = fillable.price_sat ?? cheapestAvailable;

  // 3. Target = min(fillable + overpay, effective cap).
  //
  // Effective cap is the tighter of two ceilings (issue #27):
  //   - Fixed: config.max_bid_sat_per_eh_day (always present)
  //   - Dynamic: hashprice + config.max_overpay_vs_hashprice (when the
  //     operator set the second cap AND hashprice is available for this
  //     tick). Protects against paying far above break-even when
  //     hashprice drops — a fixed cap alone can still allow that.
  //
  // Hashprice-gate (issue #28): when the operator configured the
  // dynamic cap but hashprice is unknown (boot-time fetch failed or
  // the cache has gone stale past the freshness window), we refuse
  // to trade rather than silently falling back to the fixed cap. The
  // dynamic cap was set precisely to bound overpayment during
  // hashprice dips — quietly using max_bid alone defeats the purpose.
  const dynamicCapConfigured =
    config.max_overpay_vs_hashprice_sat_per_eh_day !== null;
  if (dynamicCapConfigured && hashpriceSatEh === null) {
    return [];
  }

  const fixedCap = config.max_bid_sat_per_eh_day;
  const dynamicCap =
    dynamicCapConfigured && hashpriceSatEh !== null
      ? hashpriceSatEh + config.max_overpay_vs_hashprice_sat_per_eh_day!
      : null;
  const effectiveCap = dynamicCap !== null ? Math.min(fixedCap, dynamicCap) : fixedCap;
  const overpayAllowance = config.overpay_sat_per_eh_day;
  const desiredPrice = effectiveCheapestAvailable + overpayAllowance;
  const targetPrice = Math.min(desiredPrice, effectiveCap);
  const isMarketTooExpensive = desiredPrice > effectiveCap;

  // Market too expensive → silently skip this tick. Next tick re-evaluates.
  if (isMarketTooExpensive) return [];

  const tickSize = market.settings.tick_size_sat ?? 1000;
  const minBidSpeed = Math.max(1.0, market.settings.min_bid_speed_limit_ph ?? 1.0);
  const speedLimitPh = Math.max(minBidSpeed, effectiveTargetPh);

  // Case: no owned bids → CREATE.
  if (owned_bids.length === 0) {
    // Resolve effective budget. bid_budget_sat = 0 is a sentinel
    // meaning "use the full available wallet balance" (#40). Clamp to
    // Braiins' 1-BTC-per-bid hard cap; skip the tick silently when the
    // wallet signal is missing or empty — same behaviour as today when
    // a create would fail, without burning a failing API call.
    let effectiveBudgetSat: number;
    if (config.bid_budget_sat === 0) {
      const availableSat = state.balance?.accounts?.[0]?.available_balance_sat ?? null;
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
        reason: `cheapest_available_ask=${fmtPricePH(effectiveCheapestAvailable)}; target=${fmtPricePH(targetPrice)}${cheapModeActive ? ` (cheap mode: ${effectiveTargetPh} PH/s)` : ''}`,
      },
    ];
  }

  const proposals: Proposal[] = [];

  // Case: multiple owned bids → keep the lexicographically first, cancel
  // the rest. Handover logic arrives in a later milestone.
  const [primary, ...extras] = [...owned_bids].sort((a, b) =>
    a.braiins_order_id.localeCompare(b.braiins_order_id),
  );
  if (!primary) return [];

  for (const extra of extras) {
    proposals.push({
      kind: 'CANCEL_BID',
      braiins_order_id: extra.braiins_order_id,
      reason: 'multiple_owned_bids; keeping primary only',
    });
  }

  const overrideUntil = state.manual_override_until_ms;
  const overrideActive = overrideUntil !== null && overrideUntil > state.tick_at;

  // (a) Escalate UP when the mode's trigger condition has held long enough.
  // Mode determines both the trigger and the target price:
  // - 'market':       trigger = below floor for N min; jump to targetPrice.
  // - 'dampened':     trigger = below floor for N min; step from
  //                   current_bid + escalation_step (avoid chasing).
  // - 'above_market': trigger = below (fillable + overpay) for N min —
  //                   preemptive, fires before delivery drops. Jump to
  //                   targetPrice like 'market'.
  // Min-delta semantics (asymmetric vs. the lowering path):
  //   - Raising: when the natural next price would be less than
  //     `min_delta` above current, round UP to current + min_delta
  //     instead of skipping. The operator still wants hashrate; they
  //     just don't want to sit one sat above the previous bid every
  //     tick. `min_delta` is the minimum step, not a veto.
  //   - Lowering (block b below): deadband semantics — skip entirely
  //     unless the saving exceeds `min_delta`. Lowering burns the
  //     10-min Braiins cooldown, so a tiny move isn't worth it.
  // The raise is still clamped at effectiveCap so the floor doesn't
  // push us above the configured ceiling.
  const shouldEscalate = shouldTriggerEscalation(state) || state.bypass_pacing;
  const minDeltaThreshold = Math.max(tickSize, config.min_lower_delta_sat_per_eh_day);
  if (!overrideActive && shouldEscalate && primary.price_sat < targetPrice) {
    const naiveEscalation =
      config.escalation_mode === 'dampened'
        ? Math.min(
            primary.price_sat + config.fill_escalation_step_sat_per_eh_day,
            targetPrice,
          )
        : targetPrice; // 'market' and 'above_market' both jump to target
    const minDeltaFloor = primary.price_sat + minDeltaThreshold;
    const escalatedPrice = Math.min(
      Math.max(naiveEscalation, minDeltaFloor),
      effectiveCap,
    );
    if (escalatedPrice > primary.price_sat + tickSize) {
      const reasonByMode: Record<typeof config.escalation_mode, string> = {
        market: `escalation[market]: stuck below floor — jumping to target ${fmtPricePH(escalatedPrice)}`,
        dampened: `escalation[dampened]: stuck below floor — stepping up to ${fmtPricePH(escalatedPrice)}`,
        above_market: `escalation[above_market]: market closed the overpay gap — preemptively raising to ${fmtPricePH(escalatedPrice)}`,
      };
      proposals.push({
        kind: 'EDIT_PRICE',
        braiins_order_id: primary.braiins_order_id,
        new_price_sat: escalatedPrice,
        old_price_sat: primary.price_sat,
        reason: reasonByMode[config.escalation_mode],
      });
    }
  }

  // (b) Lower when we're paying more than target (fillable + overpay).
  // Threshold gate: only bother if the saving exceeds the symmetric
  // `min_lower_delta_sat_per_eh_day` — avoids burning the 10-min
  // Braiins price-decrease cooldown for a few sat. Same `minDeltaThreshold`
  // as the escalation path above so both directions share one deadband.
  // Patience gate: don't lower until the lowering-ready condition
  // (same overpay-vs-target check) has been continuously true for
  // `lower_patience_minutes`. Prevents chasing short market dips that
  // reverse within minutes. The controller populates
  // `state.lower_ready_since` each tick based on exactly this condition,
  // so the gate just reads the elapsed time.
  const alreadyProposingEdit = proposals.some((p) => p.kind === 'EDIT_PRICE');
  const lowerReadyLongEnough =
    state.lower_ready_since !== null &&
    (state.tick_at - state.lower_ready_since) >= config.lower_patience_minutes * 60_000;
  if (
    !overrideActive &&
    primary.price_sat >= targetPrice + minDeltaThreshold &&
    !alreadyProposingEdit &&
    (lowerReadyLongEnough || state.bypass_pacing)
  ) {
    proposals.push({
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: targetPrice,
      old_price_sat: primary.price_sat,
      reason: `market_drop: paying ${fmtPricePH(primary.price_sat)} > target ${fmtPricePH(targetPrice)} (delta >= ${fmtPricePH(minDeltaThreshold)}) — lowering to target`,
    });
  }
  void EDIT_PRICE_TOLERANCE_PCT;

  // (c) Resize the bid in-place when the configured target_hashrate_ph
  // no longer matches the bid's speed_limit_ph. Confirmed empirically
  // 2026-04-16 that PUT /spot/bid accepts new_speed_limit_ph on an
  // ACTIVE bid — id and matched fills are preserved, no cancel/recreate
  // gap. Speed-only edits intentionally don't trigger the post-EDIT_PRICE
  // override lock (that exists to bound price escalation rhythm, which
  // capacity changes don't participate in).
  const desiredSpeed = speedLimitPh; // already capped at min_bid_speed_limit_ph
  if (
    primary.speed_limit_ph !== null &&
    Math.abs(primary.speed_limit_ph - desiredSpeed) > 0.001
  ) {
    proposals.push({
      kind: 'EDIT_SPEED',
      braiins_order_id: primary.braiins_order_id,
      new_speed_limit_ph: desiredSpeed,
      old_speed_limit_ph: primary.speed_limit_ph,
      reason: `target_hashrate change: speed ${primary.speed_limit_ph} → ${desiredSpeed} PH/s${cheapModeActive ? ' (cheap mode)' : ''}`,
    });
  }

  return proposals;
}

/**
 * Returns true when escalation should trigger, based on the configured
 * `escalation_mode`:
 *
 * - `market` / `dampened` (reactive): key off `below_floor_since` — we've
 *   been delivering under the floor for `fill_escalation_after_minutes`
 *   already, so the fill has genuinely collapsed.
 * - `above_market` (preemptive): key off `below_target_since` — the
 *   market has closed the overpay gap (`current_bid < fillable + overpay`)
 *   for `fill_escalation_after_minutes`, so raise before delivery drops.
 *
 * The actual escalation price is computed in the caller.
 */
function shouldTriggerEscalation(state: State): boolean {
  const windowMinutes = state.config.fill_escalation_after_minutes;
  const since =
    state.config.escalation_mode === 'above_market'
      ? state.below_target_since
      : state.below_floor_since;
  if (since === null) return false;
  const elapsedMinutes = (state.tick_at - since) / 60_000;
  return elapsedMinutes >= windowMinutes;
}

// Re-export a type the tick driver consumes alongside decide():
export type { Proposal, State };
