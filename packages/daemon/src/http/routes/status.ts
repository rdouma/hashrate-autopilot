import type { FastifyInstance } from 'fastify';

import { cheapestAskForDepth } from '../../controller/orderbook.js';
import type { ExecutionResult, GateOutcome, State } from '../../controller/types.js';
import type { HttpServerDeps } from '../server.js';
import type {
  BalanceView,
  BidView,
  NextActionDescriptor,
  NextActionView,
  ProposalView,
  StatusResponse,
} from '../types.js';

const EH_PER_PH = 1000;

// 3-hour window for the rolling delivered-hashrate average exposed as
// `avg_delivered_ph_3h`. Matches Ocean's own 3-hour hashrate window
// (which backs their "estimated earnings/day" figure) so the income
// and spend sides of the dashboard P&L panel are on the same cadence.
const AVG_DELIVERED_WINDOW_MS = 3 * 60 * 60 * 1000;

// Trailing window for the hero PRICE card's "live effective rate".
// 30 min is the shortest window where the unfiltered ratio
// Σ Δsat / Σ (delivered_ph × Δt) becomes self-consistent: at 5–20 min,
// `delivered_ph` (a trailing `avg_speed_ph` from Braiins) runs ~5–10%
// below real-time delivery, so the ratio routinely exceeds the bid
// and the cap-at-bid pegs flat. By 30 min the lag bias washes out
// and the metric reads below the bid like the 3 h stats card. Still
// far shorter than the stats card's range so the hero stays "live."
const LIVE_EFFECTIVE_WINDOW_MS = 30 * 60 * 1000;

export async function registerStatusRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get('/api/status', async (): Promise<StatusResponse> => {
    const last = deps.controller.getLastResult();
    const runtime = await deps.runtimeRepo.get();
    const config = await deps.configRepo.get();
    if (!config || !runtime) {
      throw new Error('daemon not initialised — run setup');
    }

    const tickIntervalMs = deps.tickIntervalMs;
    const nextTickAt =
      runtime.last_tick_at !== null ? runtime.last_tick_at + tickIntervalMs : null;
    const sinceMs3h = Date.now() - AVG_DELIVERED_WINDOW_MS;
    const avgDeliveredPh3h = await deps.tickMetricsRepo.avgDeliveredPhSince(sinceMs3h);
    // Actual spend/day, derived from the last 3h of primary_bid_consumed_sat
    // deltas (same zero-dip filter as /api/stats and /api/finance/range).
    // Runway uses this; the legacy bid × delivered model was lying under
    // CLOB where the bid is a ceiling, not what we pay.
    const spend3hSat = await deps.tickMetricsRepo.actualSpendSatSince(sinceMs3h);
    const actualSpendPerDay3h =
      spend3hSat !== null && spend3hSat > 0
        ? spend3hSat * 8 // 3h → 24h
        : null;
    // Live effective rate — duration-weighted across a short trailing
    // window (LIVE_EFFECTIVE_WINDOW_MS). Powers the hero PRICE card;
    // distinct from the range-averaged figure in the stats row. In
    // sat/PH/day for direct dashboard consumption.
    const liveEffectiveSatEhDay = await deps.tickMetricsRepo.effectiveSatPerEhDayWindow(
      LIVE_EFFECTIVE_WINDOW_MS,
    );
    const liveEffectiveSatPhDay =
      liveEffectiveSatEhDay !== null ? liveEffectiveSatEhDay / EH_PER_PH : null;

    if (!last) {
      return {
        run_mode: runtime.run_mode,
        action_mode: 'NORMAL' as const,
        operator_available: true,
        tick_at: runtime.last_tick_at,
        last_api_ok_at: runtime.last_api_ok_at,
        next_tick_at: nextTickAt,
        tick_interval_ms: tickIntervalMs,
        next_action: {
          descriptor: null,
          summary: 'Waiting for first tick…',
          detail: null,
          eta_ms: null,
          event_started_ms: null,
          event_kind: null,
          last_executed: null,
        },
        balances: [],
        market: null,
        pool: {
          reachable: false,
          last_ok_at: runtime.last_pool_ok_at,
          consecutive_failures: 0,
        },
        datum: null,
        bids: [],
        actual_hashrate_ph: 0,
        avg_delivered_ph_3h: avgDeliveredPh3h,
        actual_spend_per_day_sat_3h: actualSpendPerDay3h,
        live_effective_sat_per_ph_day: liveEffectiveSatPhDay,
        below_floor_since: null,
        last_proposals: [],
        config_summary: summariseConfig(config, deps.hashpriceCache?.getFresh(Infinity) ?? null, null),
      };
    }

    const { state, gated, executed } = last;
    // Always expose the LIVE runtime state for mode / availability — not
    // the snapshot captured at observe() time. Otherwise toggling LIVE via
    // the dashboard keeps showing DRY_RUN until the next tick observes.
    const liveRunMode = runtime.run_mode;

    // Ledger carries our own creation timestamps (insert time on POST).
    const ledger = await deps.ownedBidsRepo.list();
    const createdByOrderId = new Map(
      ledger.map((r) => [r.braiins_order_id, r.created_at] as const),
    );

    const bids: BidView[] = [
      ...state.owned_bids.map((b) => ({
        braiins_order_id: b.braiins_order_id,
        cl_order_id: b.cl_order_id,
        price_sat_per_ph_day: b.price_sat / EH_PER_PH,
        amount_sat: b.amount_sat,
        speed_limit_ph: b.speed_limit_ph,
        avg_speed_ph: b.avg_speed_ph,
        progress_pct: b.progress_pct,
        amount_remaining_sat: b.amount_remaining_sat,
        status: b.status,
        is_owned: true,
        created_at_ms: createdByOrderId.get(b.braiins_order_id) ?? null,
      })),
      ...state.unknown_bids.map((b) => ({
        braiins_order_id: b.braiins_order_id,
        cl_order_id: null,
        price_sat_per_ph_day: b.price_sat / EH_PER_PH,
        amount_sat: b.amount_sat,
        speed_limit_ph: b.speed_limit_ph,
        avg_speed_ph: b.avg_speed_ph,
        progress_pct: null,
        amount_remaining_sat: null,
        status: b.status,
        is_owned: false,
        created_at_ms: null,
      })),
    ];

    const last_proposals: ProposalView[] = gated.map((g, i) =>
      toProposalView(g, executed[i]),
    );

    const balances: BalanceView[] =
      state.balance?.accounts?.map((a) => ({
        subaccount: a.subaccount,
        currency: a.currency,
        total_balance_sat: a.total_balance_sat,
        available_balance_sat: a.available_balance_sat,
        blocked_balance_sat: a.blocked_balance_sat,
      })) ?? [];

    // Compute fillable before the response so we can share it with
    // both the market view and the config summary (cheap-mode check).
    const fillable = state.market
      ? cheapestAskForDepth(state.market.orderbook.asks, config.target_hashrate_ph)
      : null;

    const hashpriceSatPerPhDay = deps.hashpriceCache?.getFresh(Infinity) ?? null;

    return {
      run_mode: liveRunMode,
      action_mode: 'NORMAL' as const,
      operator_available: true,
      tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      next_tick_at: nextTickAt,
      tick_interval_ms: tickIntervalMs,
      next_action: {
        ...describeNextAction(state, liveRunMode),
        last_executed: summariseLastExecuted(state.tick_at, executed),
      },
      balances,
      market: state.market && fillable
        ? {
            best_bid_sat_per_ph_day:
              state.market.best_bid_sat !== null
                ? state.market.best_bid_sat / EH_PER_PH
                : null,
            best_ask_sat_per_ph_day:
              state.market.best_ask_sat !== null
                ? state.market.best_ask_sat / EH_PER_PH
                : null,
            fillable_ask_sat_per_ph_day:
              fillable.price_sat !== null ? fillable.price_sat / EH_PER_PH : null,
            fillable_thin: fillable.thin,
          }
        : null,
      pool: {
        reachable: state.pool.reachable,
        last_ok_at: state.pool.last_ok_at,
        consecutive_failures: state.pool.consecutive_failures,
      },
      datum: state.datum
        ? {
            reachable: state.datum.reachable,
            connections: state.datum.connections,
            hashrate_ph: state.datum.hashrate_ph,
            last_ok_at: state.datum.last_ok_at,
            consecutive_failures: state.datum.consecutive_failures,
          }
        : null,
      bids,
      actual_hashrate_ph: state.actual_hashrate.total_ph,
      avg_delivered_ph_3h: avgDeliveredPh3h,
      actual_spend_per_day_sat_3h: actualSpendPerDay3h,
      live_effective_sat_per_ph_day: liveEffectiveSatPhDay,
      below_floor_since: state.below_floor_since,
      last_proposals,
      config_summary: summariseConfig(
        config,
        hashpriceSatPerPhDay,
        fillable?.price_sat ?? null,
      ),
    };
  });
}

/**
 * Summarise the last tick's executed mutation as a one-liner the
 * dashboard can display as a fading "just did this" breadcrumb. We
 * pick the first EXECUTED proposal from the last tick — there's
 * usually at most one anyway. DRY_RUN / BLOCKED / FAILED outcomes
 * intentionally don't surface here; those are visible in the
 * decisions log and the proposals list lower on the page.
 */
function summariseLastExecuted(
  tickAt: number,
  executed: readonly ExecutionResult[],
): NextActionView['last_executed'] {
  const fired = executed.find((e) => e.outcome === 'EXECUTED');
  if (!fired) return null;
  const p = fired.proposal;
  let summary: string;
  switch (p.kind) {
    case 'CREATE_BID':
      summary = `Just placed a new bid at ${Math.round(p.price_sat / EH_PER_PH).toLocaleString('en-US')} sat/PH/day.`;
      break;
    case 'EDIT_PRICE': {
      const oldPH = Math.round(p.old_price_sat / EH_PER_PH);
      const newPH = Math.round(p.new_price_sat / EH_PER_PH);
      const verb = p.new_price_sat < p.old_price_sat ? 'lowered' : 'raised';
      summary = `Just ${verb} bid: ${oldPH.toLocaleString('en-US')} → ${newPH.toLocaleString('en-US')} sat/PH/day.`;
      break;
    }
    case 'EDIT_SPEED': {
      const verb = p.new_speed_limit_ph < p.old_speed_limit_ph ? 'shrunk' : 'grew';
      summary = `Just ${verb} bid capacity: ${p.old_speed_limit_ph} → ${p.new_speed_limit_ph} PH/s.`;
      break;
    }
    case 'CANCEL_BID':
      summary = `Just cancelled bid ${p.braiins_order_id.slice(0, 8)}…`;
      break;
    case 'PAUSE':
      // PAUSE isn't a mutation in the Braiins sense — skip the breadcrumb.
      return null;
  }
  return { summary, executed_at_ms: tickAt };
}

function toProposalView(g: GateOutcome, executionResult: ExecutionResult | undefined): ProposalView {
  const proposal = g.proposal;
  const summary = describeProposal(proposal);
  const reason = 'reason' in proposal ? proposal.reason : '';
  return {
    kind: proposal.kind,
    summary,
    reason,
    allowed: g.allowed,
    gate_reason: g.allowed ? null : g.reason,
    executed: executionResult?.outcome ?? 'DRY_RUN',
  };
}

function describeProposal(p: GateOutcome['proposal']): string {
  switch (p.kind) {
    case 'CREATE_BID':
      return `CREATE bid at ${(p.price_sat / EH_PER_PH).toLocaleString('en-US')} sat/PH/day, ${p.speed_limit_ph} PH/s, ${p.amount_sat.toLocaleString('en-US')} sat budget`;
    case 'EDIT_PRICE':
      return `EDIT ${p.braiins_order_id.slice(0, 8)}… ${(p.old_price_sat / EH_PER_PH).toLocaleString('en-US')} → ${(p.new_price_sat / EH_PER_PH).toLocaleString('en-US')} sat/PH/day`;
    case 'EDIT_SPEED':
      return `EDIT ${p.braiins_order_id.slice(0, 8)}… speed ${p.old_speed_limit_ph} → ${p.new_speed_limit_ph} PH/s`;
    case 'CANCEL_BID':
      return `CANCEL ${p.braiins_order_id.slice(0, 8)}…`;
    case 'PAUSE':
      return `PAUSE (${p.reason})`;
  }
}

/**
 * Plain-English forecast of what the autopilot is waiting for / what the
 * next tick is likely to do. Not a re-run of decide() — just a readable
 * posture summary so the operator doesn't have to reverse-engineer state.
 */
// describeNextAction is concerned only with the prediction; the route
// merges in `last_executed` after the fact, so the function returns
// the prediction shape without that field.
type NextActionPrediction = Omit<NextActionView, 'last_executed'>;

function describeNextAction(state: State, runMode: State['run_mode']): NextActionPrediction {
  // Steady-state / non-timed cases share this shape (no progress bar).
  const noEvent = { eta_ms: null, event_started_ms: null, event_kind: null } as const;

  if (runMode === 'PAUSED') {
    return {
      descriptor: { kind: 'paused' },
      summary: 'Paused — no bids will be placed or edited until run mode changes.',
      detail: null,
      ...noEvent,
    };
  }

  if (state.unknown_bids.length > 0) {
    const ids = state.unknown_bids.map((b) => b.braiins_order_id.slice(0, 8) + '…');
    return {
      descriptor: { kind: 'unknown_bids', ids },
      summary: 'Unknown bid(s) detected — next tick will PAUSE the autopilot.',
      detail: `IDs: ${ids.join(', ')}`,
      ...noEvent,
    };
  }

  if (!state.market) {
    return {
      descriptor: { kind: 'braiins_unreachable' },
      summary: 'Braiins API unreachable — waiting for connectivity.',
      detail: null,
      ...noEvent,
    };
  }

  // Dynamic-cap hashprice gate (issue #28). When the operator
  // configured max_overpay_vs_hashprice but Ocean hashprice is
  // unknown/stale, decide() refuses to trade. Surface that up front
  // so the operator doesn't wonder why nothing is happening.
  if (
    state.config.max_overpay_vs_hashprice_sat_per_eh_day !== null &&
    state.hashprice_sat_per_ph_day === null
  ) {
    return {
      descriptor: { kind: 'awaiting_hashprice' },
      summary: 'Waiting for Ocean hashprice — trading is paused until the break-even reference is available.',
      detail: "Ocean hashprice is required to evaluate the dynamic cap you configured. If this persists, check Ocean's reachability in the Ocean panel.",
      ...noEvent,
    };
  }

  const ph = state.config.target_hashrate_ph;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  // Mirror the deadband decide() actually applies. Without this the
  // panel predicts "Will edit" for any delta >= tickSize, but decide()
  // only fires when delta >= max(tickSize, overpay/5) - so panels with
  // a 60 sat/PH/day deadband (overpay=300) confidently promised an
  // edit at delta=1 that never fired. Issue #71.
  const editDeadband = Math.max(
    tickSize,
    Math.floor(state.config.overpay_sat_per_eh_day / 5),
  );
  const fillable = cheapestAskForDepth(state.market.orderbook.asks, ph);
  const cheapestAsk = fillable.price_sat;
  if (cheapestAsk === null) {
    return {
      descriptor: { kind: 'no_market_supply' },
      summary: 'No hashrate available on the market right now.',
      detail: 'Next tick will re-check supply.',
      ...noEvent,
    };
  }

  // Target price under the #53 pay-your-bid controller:
  //   target = min(fillable_ask + overpay, effective_cap)
  // where effective_cap = min(max_bid, hashprice + max_overpay_vs_hashprice).
  const fixedCapEH = state.config.max_bid_sat_per_eh_day;
  const dynamicCapEH =
    state.config.max_overpay_vs_hashprice_sat_per_eh_day !== null &&
    state.hashprice_sat_per_ph_day !== null
      ? state.hashprice_sat_per_ph_day * EH_PER_PH +
        state.config.max_overpay_vs_hashprice_sat_per_eh_day
      : null;
  const effectiveCapEH = dynamicCapEH !== null ? Math.min(fixedCapEH, dynamicCapEH) : fixedCapEH;
  const desiredEH = cheapestAsk + state.config.overpay_sat_per_eh_day;
  const targetEH = Math.min(desiredEH, effectiveCapEH);
  const targetPH = Math.round(targetEH / EH_PER_PH);
  const cappedByCeiling = desiredEH > effectiveCapEH;
  const targetLabel = cappedByCeiling
    ? `effective cap ${targetPH.toLocaleString('en-US')} sat/PH/day (desired fillable + overpay exceeds cap)`
    : `${targetPH.toLocaleString('en-US')} sat/PH/day (fillable + overpay)`;

  if (state.owned_bids.length === 0) {
    const verb = runMode === 'LIVE' ? 'place' : 'log (dry-run)';
    let budgetText: string;
    type CreateBidBudget = Extract<NextActionDescriptor, { kind: 'will_create_bid' }>['budget'];
    let budgetDescriptor: CreateBidBudget;
    if (state.config.bid_budget_sat === 0) {
      const availableSat =
        state.balance?.accounts?.[0]?.available_balance_sat ?? null;
      if (availableSat !== null && availableSat > 0) {
        budgetText = `${Math.min(availableSat, 100_000_000).toLocaleString('en-US')} sat budget (full wallet)`;
        budgetDescriptor = { kind: 'full_wallet', available_sat: Math.min(availableSat, 100_000_000) };
      } else {
        budgetText = 'full wallet balance (awaiting balance)';
        budgetDescriptor = { kind: 'awaiting_balance' };
      }
    } else {
      budgetText = `${state.config.bid_budget_sat.toLocaleString('en-US')} sat budget`;
      budgetDescriptor = { kind: 'configured', sat: state.config.bid_budget_sat };
    }
    return {
      descriptor: {
        kind: 'will_create_bid',
        run_mode: runMode === 'LIVE' ? 'LIVE' : 'DRY_RUN',
        target_ph: targetPH,
        capped: cappedByCeiling,
        target_ph_label: targetPH,
        target_hashrate_ph: ph,
        budget: budgetDescriptor,
      },
      summary: `Will ${verb} a CREATE_BID at ${targetLabel} on the next tick.`,
      detail: `${ph} PH/s target, ${budgetText}.`,
      ...noEvent,
    };
  }

  const primary = state.owned_bids[0]!;
  const currentPricePH = Math.round(primary.price_sat / EH_PER_PH);

  if (primary.status !== 'BID_STATUS_ACTIVE') {
    const idShort = primary.braiins_order_id.slice(0, 8) + '…';
    const statusLower = primary.status.replace('BID_STATUS_', '').toLowerCase();
    return {
      descriptor: { kind: 'bid_pending', id_short: idShort, status: statusLower },
      summary: `Bid ${idShort} is ${statusLower} — waiting for it to become active.`,
      detail:
        primary.status === 'BID_STATUS_CREATED'
          ? 'Confirm in Telegram (@BraiinsBotOfficial) to activate.'
          : null,
      ...noEvent,
    };
  }

  // Bid diverges from target: decide() will EDIT_PRICE next tick
  // (subject to Braiins' 10-min decrease cooldown on lowers).
  const priceDelta = Math.abs(primary.price_sat - targetEH);
  if (priceDelta >= editDeadband) {
    const verb = runMode === 'LIVE' ? 'edit' : 'log edit (dry-run)';
    const direction = primary.price_sat > targetEH ? 'lower' : 'raise';
    const cooldownMs =
      (state.market.settings.min_bid_price_decrease_period_s ?? 600) * 1000;
    const lastDecrease = primary.last_price_decrease_at;
    const cooldownEndsMs = lastDecrease !== null ? lastDecrease + cooldownMs : null;
    const cooldownRemainsMs =
      direction === 'lower' && cooldownEndsMs !== null
        ? Math.max(0, cooldownEndsMs - state.tick_at)
        : 0;
    if (cooldownRemainsMs > 0 && cooldownEndsMs !== null && lastDecrease !== null) {
      const minsLeft = Math.max(1, Math.ceil(cooldownRemainsMs / 60_000));
      return {
        descriptor: {
          kind: 'cooldown_active',
          target_ph: targetPH,
          current_ph: currentPricePH,
          mins_left: minsLeft,
          direction,
        },
        summary: `Bid above target — Braiins price-decrease cooldown active.`,
        detail: `Will ${direction} to ${targetPH.toLocaleString('en-US')} sat/PH/day in ~${minsLeft} min (current ${currentPricePH.toLocaleString('en-US')}).`,
        eta_ms: cooldownEndsMs,
        event_started_ms: lastDecrease,
        event_kind: 'lower_after_cooldown',
      };
    }
    return {
      descriptor: {
        kind: 'will_edit_bid',
        run_mode: runMode === 'LIVE' ? 'LIVE' : 'DRY_RUN',
        target_ph: targetPH,
        current_ph: currentPricePH,
        clamped: cappedByCeiling,
      },
      summary: `Will ${verb} bid to ${targetPH.toLocaleString('en-US')} sat/PH/day on the next tick.`,
      detail: `Current ${currentPricePH.toLocaleString('en-US')} sat/PH/day — tracking fillable + overpay${cappedByCeiling ? ' (clamped)' : ''}.`,
      ...noEvent,
    };
  }

  return {
    descriptor: { kind: 'on_target', capped: cappedByCeiling, avg_speed_ph: primary.avg_speed_ph },
    summary: cappedByCeiling
      ? 'At effective cap — desired fillable + overpay exceeds the ceiling.'
      : 'On target — bid at fillable + overpay.',
    detail: `Bid filling at ${primary.avg_speed_ph.toFixed(2)} PH/s.`,
    ...noEvent,
  };
}

function summariseConfig(
  config: {
    target_hashrate_ph: number;
    minimum_floor_hashrate_ph: number;
    max_bid_sat_per_eh_day: number;
    max_overpay_vs_hashprice_sat_per_eh_day: number | null;
    bid_budget_sat: number;
    destination_pool_url: string;
    cheap_target_hashrate_ph: number;
    cheap_threshold_pct: number;
  },
  hashpriceSatPerPhDay: number | null,
  cheapestAskSatEhDay: number | null,
): StatusResponse['config_summary'] {
  // Mirror the cheap-mode logic from decide.ts to expose which
  // target is active in the status summary.
  const hashpriceSatEh =
    hashpriceSatPerPhDay !== null ? hashpriceSatPerPhDay * EH_PER_PH : null;
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph &&
    hashpriceSatEh !== null &&
    hashpriceSatEh > 0;
  let cheapModeActive = false;
  let effectiveTargetPh = config.target_hashrate_ph;
  if (cheapEnabled && cheapestAskSatEhDay !== null) {
    const threshold = hashpriceSatEh! * (config.cheap_threshold_pct / 100);
    if (cheapestAskSatEhDay < threshold) {
      cheapModeActive = true;
      effectiveTargetPh = config.cheap_target_hashrate_ph;
    }
  }

  // Mirror the effective-cap logic from decide.ts so the dashboard
  // can show which of the two caps (fixed max_bid vs hashprice +
  // max_overpay) is binding right now.
  const fixedCapEh = config.max_bid_sat_per_eh_day;
  const dynamicCapEh =
    config.max_overpay_vs_hashprice_sat_per_eh_day !== null && hashpriceSatEh !== null
      ? hashpriceSatEh + config.max_overpay_vs_hashprice_sat_per_eh_day
      : null;
  const effectiveCapEh =
    dynamicCapEh !== null ? Math.min(fixedCapEh, dynamicCapEh) : fixedCapEh;
  const bindingCap: 'fixed' | 'dynamic' =
    dynamicCapEh !== null && dynamicCapEh < fixedCapEh ? 'dynamic' : 'fixed';

  return {
    target_hashrate_ph: config.target_hashrate_ph,
    minimum_floor_hashrate_ph: config.minimum_floor_hashrate_ph,
    max_bid_sat_per_ph_day: fixedCapEh / EH_PER_PH,
    max_overpay_vs_hashprice_sat_per_ph_day:
      config.max_overpay_vs_hashprice_sat_per_eh_day !== null
        ? config.max_overpay_vs_hashprice_sat_per_eh_day / EH_PER_PH
        : null,
    effective_cap_sat_per_ph_day: effectiveCapEh / EH_PER_PH,
    binding_cap: bindingCap,
    bid_budget_sat: config.bid_budget_sat,
    pool_url: config.destination_pool_url,
    effective_target_hashrate_ph: effectiveTargetPh,
    cheap_mode_active: cheapModeActive,
  };
}
