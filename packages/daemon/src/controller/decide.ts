/**
 * Pure decision function (post-CLOB redesign, #49).
 *
 * Under Braiins' CLOB matching (empirically verified — actual spend ≈
 * 15-20% below bid while bidding at fillable), the bid price is just
 * a matching-access ceiling. The actual price paid comes from the
 * matched asks. The elaborate fill-strategy machinery that used to
 * live here (overpay-above-fillable, escalation modes, lowering
 * patience, min-delta gates) has been retired: lowering the bid only
 * gates *which sellers we can reach*, it doesn't save money, and
 * raising is near-free.
 *
 * What this function does now:
 *   1. Compute effective_cap = min(max_bid, hashprice + max_overpay_vs_hashprice).
 *   2. If no owned bids → CREATE_BID at effective_cap, target speed, wallet budget.
 *   3. If our bid's price ≠ effective_cap → EDIT_PRICE to effective_cap.
 *   4. If cheap-mode is active, target PH/s becomes cheap_target_hashrate_ph
 *      → EDIT_SPEED if the active bid doesn't reflect that.
 *   5. If multiple owned bids exist → cancel the extras.
 *   6. Unknown bids → PAUSE (same as before; unambiguity requirement).
 *
 * Everything else (below-floor timers, lower-ready patience, escalation
 * modes) has been removed.
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
        reason: `unknown_bids_present: ${state.unknown_bids.map((b) => b.braiins_order_id).join(', ')}`,
      },
    ];
  }

  // Without a market snapshot we can't compute the effective cap.
  if (!state.market) return [];

  const { market, config, owned_bids } = state;

  // Hashprice is needed for the dynamic cap. When the dynamic cap is
  // configured but hashprice is unknown (boot fetch failed, stale
  // cache), refuse to trade rather than silently fall back to the
  // fixed cap — that defeats the whole point of configuring the
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

  // Cheap-mode check (#13): opportunistic scale-up when the market is
  // cheap relative to hashprice. Under CLOB the bid is a ceiling and
  // we pay matched ask prices, so "cheap" = the best ask is below a
  // threshold of hashprice. best_ask is the cheapest price at which
  // any supply exists — exactly the CLOB-native analogue of fillable.
  const bestAskSatEh = market.best_ask_sat;
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph &&
    hashpriceSatEh !== null &&
    hashpriceSatEh > 0;
  let effectiveTargetPh = config.target_hashrate_ph;
  let cheapModeActive = false;
  if (cheapEnabled && bestAskSatEh !== null) {
    const threshold = hashpriceSatEh! * (config.cheap_threshold_pct / 100);
    if (bestAskSatEh < threshold) {
      effectiveTargetPh = config.cheap_target_hashrate_ph;
      cheapModeActive = true;
    }
  }

  const minBidSpeed = Math.max(1.0, market.settings.min_bid_speed_limit_ph ?? 1.0);
  const speedLimitPh = Math.max(minBidSpeed, effectiveTargetPh);
  const tickSize = market.settings.tick_size_sat ?? 1000;

  // Case: no owned bids → CREATE at the effective cap.
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
        price_sat: effectiveCap,
        amount_sat: effectiveBudgetSat,
        speed_limit_ph: speedLimitPh,
        dest_pool_url: config.destination_pool_url,
        dest_worker_name: config.destination_pool_worker_name,
        reason: `create at effective cap ${fmtPricePH(effectiveCap)}${cheapModeActive ? ` (cheap mode: ${effectiveTargetPh} PH/s)` : ''}`,
      },
    ];
  }

  const proposals: Proposal[] = [];

  // Keep one owned bid — cancel any extras.
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

  // Price edit: move the live bid to the effective cap. Braiins' 10-min
  // price-decrease cooldown is enforced by gate.ts (below the decide
  // boundary), so we don't need to care here — if a decrease is
  // refused, the next tick proposes it again and eventually succeeds.
  // Tolerance: tick_size to avoid emitting EDIT_PRICE proposals that
  // round-trip to the same on-wire value.
  const priceDelta = Math.abs(primary.price_sat - effectiveCap);
  if (priceDelta >= tickSize) {
    proposals.push({
      kind: 'EDIT_PRICE',
      braiins_order_id: primary.braiins_order_id,
      new_price_sat: effectiveCap,
      old_price_sat: primary.price_sat,
      reason: `converge to effective cap: ${fmtPricePH(primary.price_sat)} → ${fmtPricePH(effectiveCap)}`,
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
