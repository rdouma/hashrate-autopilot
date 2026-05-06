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
        reason: `unknown_bids_present: ${state.unknown_bids.map((b) => b.braiins_order_id).join(', ')}`,
      },
    ];
  }

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

  // Cheap-mode check (#13 / #50): opportunistic scale-up when the
  // market is cheap relative to hashprice. Rolling-average window when
  // configured (`cheap_sustained_window_minutes > 0`), spot fallback
  // otherwise. Controls target_hashrate_ph only - pricing stays on
  // the fillable-tracking path.
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph;
  let effectiveTargetPh = config.target_hashrate_ph;
  let cheapModeActive = false;
  if (cheapEnabled) {
    const win = state.cheap_mode_window;
    if (win !== null) {
      const threshold =
        win.avg_hashprice_sat_per_eh_day * (config.cheap_threshold_pct / 100);
      if (win.avg_best_ask_sat_per_eh_day < threshold) {
        effectiveTargetPh = config.cheap_target_hashrate_ph;
        cheapModeActive = true;
      }
    } else if (hashpriceSatEh !== null && hashpriceSatEh > 0) {
      const bestAskSatEh = market.best_ask_sat;
      if (bestAskSatEh !== null) {
        const threshold = hashpriceSatEh * (config.cheap_threshold_pct / 100);
        if (bestAskSatEh < threshold) {
          effectiveTargetPh = config.cheap_target_hashrate_ph;
          cheapModeActive = true;
        }
      }
    }
  }

  const minBidSpeed = Math.max(1.0, market.settings.min_bid_speed_limit_ph ?? 1.0);
  const speedLimitPh = Math.max(minBidSpeed, effectiveTargetPh);
  const tickSize = market.settings.tick_size_sat ?? 1000;
  // Deadband on EDIT_PRICE (#53 fix). fillable_ask jitters ±1-5 sat/PH/day
  // (~1,000-5,000 sat/EH/day) tick-to-tick as distant supply levels
  // reshuffle. With the naive tick_size tolerance, every jitter triggers
  // a mutation - dense trade storm on the chart, API noise, and each
  // lower burns the 10-min cooldown. Scale the deadband to 1/5 of
  // overpay: if fillable has moved by less than 20 % of our overpay
  // cushion, the current bid still sits comfortably above fillable and
  // delivery stays healthy. At the 1,000 sat/PH/day default overpay this
  // gives a ~200 sat/PH/day deadband. Never below tick_size - Braiins
  // would reject a smaller edit.
  const editDeadband = Math.max(
    tickSize,
    Math.floor(config.overpay_sat_per_eh_day / 5),
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

  // Keep one owned bid - cancel any extras.
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
