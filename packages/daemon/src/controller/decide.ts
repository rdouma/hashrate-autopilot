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
 *   3. If fillable + overpay > max_bid:
 *      - if `hibernate_on_expensive_market`: propose PAUSE.
 *      - else: don't propose CREATE this tick.
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
  const fillable = cheapestAskForDepth(asks, config.target_hashrate_ph);
  const cheapestAvailable = fillable.price_sat;
  if (cheapestAvailable === null) return []; // nothing for sale

  // 3. Target = min(fillable + overpay, max_bid). Simple and direct.
  const effectiveCap = computeEffectiveCap(state);
  const overpayAllowance = config.overpay_sat_per_eh_day;
  const desiredPrice = cheapestAvailable + overpayAllowance;
  const targetPrice = Math.min(desiredPrice, effectiveCap);
  const isMarketTooExpensive = desiredPrice > effectiveCap;

  if (isMarketTooExpensive) {
    if (state.config.hibernate_on_expensive_market) {
      return [
        {
          kind: 'PAUSE',
          reason: `market_too_expensive: needed ${fmtPricePH(desiredPrice)} > cap ${fmtPricePH(effectiveCap)} (cheapest ask ${fmtPricePH(cheapestAvailable)})`,
        },
      ];
    }
    // No PAUSE configured → just don't bid this tick. Next tick re-evaluates.
    return [];
  }

  const tickSize = market.settings.tick_size_sat ?? 1000;
  const minBidSpeed = Math.max(1.0, market.settings.min_bid_speed_limit_ph ?? 1.0);
  const speedLimitPh = Math.max(minBidSpeed, config.target_hashrate_ph);

  // Case: no owned bids → CREATE.
  if (owned_bids.length === 0) {
    return [
      {
        kind: 'CREATE_BID',
        price_sat: targetPrice,
        amount_sat: config.bid_budget_sat,
        speed_limit_ph: speedLimitPh,
        dest_pool_url: config.destination_pool_url,
        dest_worker_name: config.destination_pool_worker_name,
        reason: `cheapest_available_ask=${fmtPricePH(cheapestAvailable)}; target=${fmtPricePH(targetPrice)}`,
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

  // (a) Escalate UP when we've been stuck below floor.
  // Mode determines escalation behavior:
  // - 'market': jump directly to targetPrice (track market)
  // - 'dampened': step from current_bid + escalation_step (avoid chasing)
  const shouldEscalate = shouldTriggerEscalation(state);
  if (!overrideActive && shouldEscalate && primary.price_sat < targetPrice) {
    const escalatedPrice =
      config.escalation_mode === 'market'
        ? targetPrice
        : Math.min(
            primary.price_sat + config.fill_escalation_step_sat_per_eh_day,
            targetPrice,
          );
    if (escalatedPrice > primary.price_sat + tickSize) {
      proposals.push({
        kind: 'EDIT_PRICE',
        braiins_order_id: primary.braiins_order_id,
        new_price_sat: escalatedPrice,
        old_price_sat: primary.price_sat,
        reason:
          config.escalation_mode === 'market'
            ? `escalation[market]: stuck below floor — jumping to target ${fmtPricePH(escalatedPrice)}`
            : `escalation[dampened]: stuck below floor — stepping up to ${fmtPricePH(escalatedPrice)}`,
      });
    }
  }

  // (b) Lower when we're paying more than target (fillable + overpay).
  // Threshold gate: only bother if the saving exceeds
  // `min_lower_delta_sat_per_eh_day` — avoids burning the 10-min Braiins
  // price-decrease cooldown for a few sat. tickSize is the absolute floor
  // (Braiins rejects sub-tick prices anyway).
  const alreadyProposingEdit = proposals.some((p) => p.kind === 'EDIT_PRICE');
  const lowerThreshold = Math.max(tickSize, config.min_lower_delta_sat_per_eh_day);
  if (
    !overrideActive &&
    primary.price_sat > targetPrice + lowerThreshold &&
    !alreadyProposingEdit
  ) {
    proposals.push({
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: targetPrice,
      old_price_sat: primary.price_sat,
      reason: `market_drop: paying ${fmtPricePH(primary.price_sat)} > target ${fmtPricePH(targetPrice)} (delta > ${fmtPricePH(lowerThreshold)}) — lowering to target`,
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
      reason: `target_hashrate change: speed ${primary.speed_limit_ph} → ${desiredSpeed} PH/s`,
    });
  }

  return proposals;
}

/**
 * Effective price cap. Rises to emergency_max once we've been below floor
 * longer than `below_floor_emergency_cap_after_minutes` (SPEC §9).
 */
function computeEffectiveCap(state: State): number {
  const normal = state.config.max_bid_sat_per_eh_day;
  const emergency = state.config.emergency_max_bid_sat_per_eh_day;
  if (state.below_floor_since === null) return normal;
  const elapsedMinutes = (state.tick_at - state.below_floor_since) / 60_000;
  if (elapsedMinutes >= state.config.below_floor_emergency_cap_after_minutes) {
    return emergency;
  }
  return normal;
}

/**
 * Returns true when escalation should trigger: we've been stuck below
 * floor for longer than `fill_escalation_after_minutes`. The actual
 * escalation price is computed in the caller based on `escalation_mode`.
 */
function shouldTriggerEscalation(state: State): boolean {
  if (state.below_floor_since === null) return false;
  const elapsedMinutes = (state.tick_at - state.below_floor_since) / 60_000;
  return elapsedMinutes >= state.config.fill_escalation_after_minutes;
}

// Re-export a type the tick driver consumes alongside decide():
export type { Proposal, State };
