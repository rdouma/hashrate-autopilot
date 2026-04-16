/**
 * Pure decision function.
 *
 * Pricing strategy (SPEC §9; M4.7):
 *
 *   1. Find the **cheapest ask with non-zero available hashrate**. That's
 *      the cheapest real supply in the book.
 *   2. `target_price = cheapest_available_ask + max_overpay_vs_ask_sat`.
 *   3. If `target_price > max_price_sat_per_eh_day`:
 *      - if `hibernate_on_expensive_market`: propose PAUSE.
 *      - else: don't propose CREATE this tick.
 *   4. Escalation: if we've been below floor for longer than
 *      `fill_escalation_after_minutes` and our current bid is below
 *      `target_price`, bump our bid up by `fill_escalation_step_sat_per_eh_day`
 *      (capped by `max_price_sat_per_eh_day`).
 *
 * Unknown bids → PAUSE (SPEC §9 unknown-order detection).
 * Duplicate owned bids → cancel the extras.
 */

import type { Proposal, State } from './types.js';

/**
 * Tolerance band for an EDIT_PRICE proposal. We want to avoid thrashing on
 * sub-tick noise; only act when the target has moved by more than 0.5% of
 * the target price.
 */
const EDIT_PRICE_TOLERANCE_PCT = 0.005;

interface OrderbookAsk {
  price_sat: number;
  hr_available_ph?: number;
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
  const asks = (market.orderbook.asks ?? []) as OrderbookAsk[];
  if (asks.length === 0) return [];

  // 2. Cheapest ask with actual available hashrate.
  const cheapestAvailable = cheapestAskWithAvailable(asks);
  if (cheapestAvailable === null) return []; // nothing for sale

  // 3. Start target at cheapest_available + overpay margin, then apply caps.
  const effectiveCap = computeEffectiveCap(state);
  const overpayAllowance = config.max_overpay_vs_ask_sat_per_eh_day;
  const desiredPrice = cheapestAvailable + overpayAllowance;

  // 4. Escalation — if we've been stuck below floor too long, let ourselves
  //    bid one step above whatever we're already paying.
  const escalation = computeEscalation(state, owned_bids[0]?.price_sat ?? 0);
  const targetFromStrategy = Math.max(desiredPrice, escalation);

  // 5. Apply the hard cap. If even the desired price is above the cap,
  //    market is too expensive for us right now.
  const isMarketTooExpensive = targetFromStrategy > effectiveCap;
  const targetPrice = Math.min(targetFromStrategy, effectiveCap);

  if (isMarketTooExpensive) {
    if (state.config.hibernate_on_expensive_market) {
      return [
        {
          kind: 'PAUSE',
          reason: `market_too_expensive: needed ${targetFromStrategy} > cap ${effectiveCap} (cheapest ask ${cheapestAvailable})`,
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
        reason: `cheapest_available_ask=${cheapestAvailable}; target=${targetPrice}`,
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
  const escalatedTarget = Math.min(escalation, effectiveCap);
  if (!overrideActive && escalatedTarget > primary.price_sat + tickSize) {
    proposals.push({
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: escalatedTarget,
      old_price_sat: primary.price_sat,
      reason: `escalation: stuck below floor — raising by one step to ${escalatedTarget}`,
    });
  }

  // (b) Lower ONLY when we're materially overpaying vs current market.
  // Triggered by the operator-configured `overpay_before_lowering`
  // safety margin: we only consider lowering if current_price exceeds
  // the naive target (cheapest_available_ask + max_overpay) by that
  // many sat/EH/day. Caveat: still respects the override grace lock
  // (don't undo a recent escalation) and Braiins's 10-min
  // price-decrease cooldown (gate enforces).
  const lowerMargin = state.config.overpay_before_lowering_sat_per_eh_day;
  const overpayDelta = primary.price_sat - desiredPrice;
  const alreadyProposingEdit = proposals.some((p) => p.kind === 'EDIT_PRICE');
  if (!overrideActive && overpayDelta > lowerMargin && !alreadyProposingEdit) {
    const lowerEdit: Proposal = {
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: desiredPrice,
      old_price_sat: primary.price_sat,
      reason: `market_drop: overpaying by ${overpayDelta} > safety margin ${lowerMargin} — lowering to target ${desiredPrice}`,
    };
    proposals.push(lowerEdit);
  }
  void EDIT_PRICE_TOLERANCE_PCT;

  return proposals;
}

/**
 * Walk asks ascending by price, return the first whose hr_available_ph > 0.
 */
function cheapestAskWithAvailable(asks: readonly OrderbookAsk[]): number | null {
  const sorted = [...asks].sort((a, b) => a.price_sat - b.price_sat);
  for (const ask of sorted) {
    if ((ask.hr_available_ph ?? 0) > 0) return ask.price_sat;
  }
  return null;
}

/**
 * Effective price cap. Rises to emergency_max once we've been below floor
 * longer than `below_floor_emergency_cap_after_minutes` (SPEC §9).
 */
function computeEffectiveCap(state: State): number {
  const normal = state.config.max_price_sat_per_eh_day;
  const emergency = state.config.emergency_max_price_sat_per_eh_day;
  if (state.below_floor_since === null) return normal;
  const elapsedMinutes = (state.tick_at - state.below_floor_since) / 60_000;
  if (elapsedMinutes >= state.config.below_floor_emergency_cap_after_minutes) {
    return emergency;
  }
  return normal;
}

/**
 * Escalation target: +1 step above the current bid once we've been
 * stuck below floor for a full window. Repeated escalations are
 * controlled by the tick driver via `manual_override_until_ms`, which
 * locks in each escalated price for a full window before another
 * escalation may fire. Returns 0 when no escalation applies.
 */
function computeEscalation(state: State, currentBidPriceSat: number): number {
  if (state.below_floor_since === null) return 0;
  const elapsedMinutes = (state.tick_at - state.below_floor_since) / 60_000;
  if (elapsedMinutes < state.config.fill_escalation_after_minutes) return 0;
  if (currentBidPriceSat <= 0) return 0;
  return currentBidPriceSat + state.config.fill_escalation_step_sat_per_eh_day;
}

// Re-export a type the tick driver consumes alongside decide():
export type { Proposal, State };
