import type { FastifyInstance } from 'fastify';

import { cheapestAskForDepth } from '../../controller/orderbook.js';
import type { ExecutionResult, GateOutcome, State } from '../../controller/types.js';
import type { HttpServerDeps } from '../server.js';
import type {
  BalanceView,
  BidView,
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
    const avgDeliveredPh3h = await deps.tickMetricsRepo.avgDeliveredPhSince(
      Date.now() - AVG_DELIVERED_WINDOW_MS,
    );

    if (!last) {
      return {
        run_mode: runtime.run_mode,
        action_mode: runtime.action_mode,
        operator_available: runtime.operator_available,
        tick_at: runtime.last_tick_at,
        last_api_ok_at: runtime.last_api_ok_at,
        next_tick_at: nextTickAt,
        tick_interval_ms: tickIntervalMs,
        next_action: {
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
    const liveActionMode = runtime.action_mode;
    const liveOperatorAvailable = runtime.operator_available;

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
      action_mode: liveActionMode,
      operator_available: liveOperatorAvailable,
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
      summary: 'Paused — no bids will be placed or edited until run mode changes.',
      detail: null,
      ...noEvent,
    };
  }

  if (state.unknown_bids.length > 0) {
    return {
      summary: 'Unknown bid(s) detected — next tick will PAUSE the autopilot.',
      detail: `IDs: ${state.unknown_bids.map((b) => b.braiins_order_id.slice(0, 8) + '…').join(', ')}`,
      ...noEvent,
    };
  }

  if (!state.market) {
    return {
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
      summary: 'Waiting for Ocean hashprice — trading is paused until the break-even reference is available.',
      detail: "Ocean hashprice is required to evaluate the dynamic cap you configured. If this persists, check Ocean's reachability in the Ocean panel.",
      ...noEvent,
    };
  }

  const ph = state.config.target_hashrate_ph;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  const fillable = cheapestAskForDepth(state.market.orderbook.asks, ph);
  const cheapestAsk = fillable.price_sat;
  if (cheapestAsk === null) {
    return {
      summary: 'No hashrate available on the market right now.',
      detail: 'Next tick will re-check supply.',
      ...noEvent,
    };
  }
  // Mirror decide.ts: target = min(fillable + overpay, effectiveCap)
  // where effectiveCap = min(fixed max_bid, hashprice + max_overpay).
  // Using the fixed cap alone here would hide the case where the
  // *dynamic* cap is what's blocking the autopilot — the user would
  // see an escalation countdown that can't fire.
  const desiredPriceEH = cheapestAsk + state.config.overpay_sat_per_eh_day;
  const fixedCapEH = state.config.max_bid_sat_per_eh_day;
  const dynamicCapEH =
    state.config.max_overpay_vs_hashprice_sat_per_eh_day !== null &&
    state.hashprice_sat_per_ph_day !== null
      ? state.hashprice_sat_per_ph_day * EH_PER_PH +
        state.config.max_overpay_vs_hashprice_sat_per_eh_day
      : null;
  const effectiveCapEH = dynamicCapEH !== null ? Math.min(fixedCapEH, dynamicCapEH) : fixedCapEH;
  const targetPriceEH = Math.min(desiredPriceEH, effectiveCapEH);
  const targetPricePH = Math.round(targetPriceEH / EH_PER_PH);
  const cappedByMax = desiredPriceEH > effectiveCapEH;
  const bindingCapLabel =
    dynamicCapEH !== null && dynamicCapEH < fixedCapEH
      ? 'dynamic hashprice+max_overpay'
      : 'fixed max_bid';

  if (state.owned_bids.length === 0) {
    const verb = runMode === 'LIVE' ? 'place' : 'log (dry-run)';
    // Mirror the sentinel resolution in decide.ts so the "detail" text
    // reflects what amount_sat will actually be proposed, not the raw
    // config value. 0 means "use full wallet balance" (#40); surface
    // the resolved figure (or "full wallet" when no balance yet).
    let budgetText: string;
    if (state.config.bid_budget_sat === 0) {
      const availableSat =
        state.balance?.accounts?.[0]?.available_balance_sat ?? null;
      budgetText =
        availableSat !== null && availableSat > 0
          ? `${Math.min(availableSat, 100_000_000).toLocaleString('en-US')} sat budget (full wallet)`
          : 'full wallet balance (awaiting balance)';
    } else {
      budgetText = `${state.config.bid_budget_sat.toLocaleString('en-US')} sat budget`;
    }
    return {
      summary: `Will ${verb} a CREATE_BID on the next tick.`,
      detail: `~${targetPricePH.toLocaleString('en-US')} sat/PH/day, ${ph} PH/s target, ${budgetText}.`,
      ...noEvent,
    };
  }

  const primary = state.owned_bids[0]!;
  const currentPricePH = Math.round(primary.price_sat / EH_PER_PH);

  if (primary.status !== 'BID_STATUS_ACTIVE') {
    return {
      summary: `Bid ${primary.braiins_order_id.slice(0, 8)}… is ${primary.status.replace('BID_STATUS_', '').toLowerCase()} — waiting for it to become active.`,
      detail:
        primary.status === 'BID_STATUS_CREATED'
          ? 'Confirm in Telegram (@BraiinsBotOfficial) to activate.'
          : null,
      ...noEvent,
    };
  }

  // Preemptive-raise predictor for `escalation_mode = 'above_market'`.
  // Fires off the below-target timer (not below-floor), so the raise
  // can be scheduled while we're still filling fine — the whole point
  // of the mode. Short-circuits the reactive shortfall path below,
  // which in `above_market` mode is dead code (shouldTriggerEscalation
  // keys off `below_target_since` in that mode).
  if (state.config.escalation_mode === 'above_market') {
    if (primary.price_sat < targetPriceEH) {
      const windowMs = state.config.fill_escalation_after_minutes * 60_000;
      if (cappedByMax) {
        return {
          summary: `Market caught up to bid — no preemptive raise will fire.`,
          detail: `Fillable + overpay (${Math.round(desiredPriceEH / EH_PER_PH).toLocaleString('en-US')} sat/PH/day) exceeds your ${bindingCapLabel} cap (${Math.round(effectiveCapEH / EH_PER_PH).toLocaleString('en-US')} sat/PH/day). Waiting for the market to drop or the cap to relax.`,
          ...noEvent,
        };
      }
      const startMs = state.below_target_since ?? state.tick_at;
      const elapsedMs = state.tick_at - startMs;
      const remainingMs = windowMs - elapsedMs;
      const countdownText =
        remainingMs > 0
          ? `Preemptive raise in ${Math.max(1, Math.ceil(remainingMs / 60_000))} min`
          : `Preemptive raise overdue by ${Math.max(1, Math.ceil(-remainingMs / 60_000))} min`;
      const nextEditPH = Math.round(targetPriceEH / EH_PER_PH);
      return {
        summary: `Market caught up to bid (${currentPricePH.toLocaleString('en-US')} < target ${nextEditPH.toLocaleString('en-US')} sat/PH/day).`,
        detail: `${countdownText} if still below target. above_market mode will jump to ${nextEditPH.toLocaleString('en-US')} sat/PH/day.`,
        eta_ms: startMs + windowMs,
        event_started_ms: startMs,
        event_kind: 'escalation',
      };
    }
    // Bid at-or-above target under above_market: fall through to the
    // overpay/lower branch below; if not overpaying, "on target".
  }

  const shortfall = ph - primary.avg_speed_ph;
  if (shortfall > 0.1 && state.config.escalation_mode !== 'above_market') {
    const windowMs = state.config.fill_escalation_after_minutes * 60_000;
    // If the market is too expensive (fillable + overpay > max_bid),
    // decide.ts returns [] — no escalation, no CREATE. The bid sits
    // at its current price and we wait for the market to drop. Don't
    // predict "will jump to max_bid" — that move would never fire.
    if (cappedByMax) {
      return {
        summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s) — no escalation will fire.`,
        detail: `Fillable + overpay (${Math.round(desiredPriceEH / EH_PER_PH).toLocaleString('en-US')} sat/PH/day) exceeds your ${bindingCapLabel} cap (${Math.round(effectiveCapEH / EH_PER_PH).toLocaleString('en-US')} sat/PH/day). Waiting for the market to drop or for the cap to relax — raise "Max premium over hashprice" in Config to unblock.`,
        ...noEvent,
      };
    }

    // If current price is already at or above the target, escalation
    // won't actually fire (decide.ts checks primary < targetPrice).
    if (primary.price_sat >= targetPriceEH) {
      return {
        summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s).`,
        detail: `Already priced at ${currentPricePH.toLocaleString('en-US')} sat/PH/day (above target ${targetPricePH.toLocaleString('en-US')}). Waiting for hashrate to arrive.`,
        ...noEvent,
      };
    }

    // Escalation only fires when the bid has been continuously BELOW
    // FLOOR (not merely below target) for `fill_escalation_after_minutes`.
    // If we're below target but above floor, decide() won't escalate —
    // no countdown should be shown (issue #29).
    const floorPh = state.config.minimum_floor_hashrate_ph;
    if (primary.avg_speed_ph >= floorPh) {
      return {
        summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s).`,
        detail: `Above floor (${floorPh} PH/s) — no escalation scheduled. Escalation only triggers after ${state.config.fill_escalation_after_minutes} min continuously below floor.`,
        ...noEvent,
      };
    }

    // Below floor. The below_floor_since timer may not have been set
    // yet on the very first tick of this dip (observe() sets it each
    // tick, but the first observed tick uses `previous ?? now` — so
    // reading the state immediately after that tick returns a valid
    // start). Still, if it's somehow null at this point we treat
    // tick_at as the synthetic start so the progress bar + countdown
    // text agree; escalation on the next tick will use the real
    // persisted value.
    const startMs = state.below_floor_since ?? state.tick_at;
    const elapsedMs = state.tick_at - startMs;
    const remainingMs = windowMs - elapsedMs;

    const countdownText =
      remainingMs > 0
        ? `Escalation in ${Math.max(1, Math.ceil(remainingMs / 60_000))} min`
        : `Escalation overdue by ${Math.max(1, Math.ceil(-remainingMs / 60_000))} min`;

    const escalationStep = state.config.fill_escalation_step_sat_per_eh_day;
    const nextEditEH =
      state.config.escalation_mode === 'market'
        ? targetPriceEH
        : Math.min(primary.price_sat + escalationStep, targetPriceEH);
    const nextEditPH = Math.round(nextEditEH / EH_PER_PH);
    const ceilingPH = targetPricePH;
    const modeWord = state.config.escalation_mode === 'market' ? 'market' : 'dampened';
    const capLabel = cappedByMax ? ' (capped by max bid)' : ' (fillable + overpay)';
    const stepDescription =
      state.config.escalation_mode === 'market'
        ? `will jump to ${nextEditPH.toLocaleString('en-US')}${capLabel}.`
        : nextEditPH < ceilingPH
          ? `will step up by ${Math.round(escalationStep / EH_PER_PH).toLocaleString('en-US')} to ${nextEditPH.toLocaleString('en-US')}${capLabel}.`
          : `will reach ${ceilingPH.toLocaleString('en-US')}${capLabel}.`;

    return {
      summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s).`,
      detail: `${countdownText} if still under floor. Current ${currentPricePH.toLocaleString('en-US')} sat/PH/day; ${modeWord} mode ${stepDescription}`,
      eta_ms: startMs + windowMs,
      event_started_ms: startMs,
      event_kind: 'escalation',
    };
  }

  // Over-paying check: if our bid is materially above target (fillable +
  // overpay) — by more than min_lower_delta — the next tick will
  // lower us. Surface that, plus any gate currently holding the move.
  const lowerThreshold = Math.max(tickSize, state.config.min_lower_delta_sat_per_eh_day);
  if (primary.price_sat > targetPriceEH + lowerThreshold) {
    const overpayPH = Math.round((primary.price_sat - targetPriceEH) / EH_PER_PH);
    const overrideUntil = state.manual_override_until_ms;
    const overrideActive = overrideUntil !== null && overrideUntil > state.tick_at;
    const cooldownMs =
      (state.market.settings.min_bid_price_decrease_period_s ?? 600) * 1000;
    const lastDecrease = primary.last_price_decrease_at;
    const cooldownEndsMs = lastDecrease !== null ? lastDecrease + cooldownMs : null;
    const cooldownRemainsMs =
      cooldownEndsMs !== null ? Math.max(0, cooldownEndsMs - state.tick_at) : 0;

    if (overrideActive) {
      const minsLeft = Math.max(1, Math.ceil((overrideUntil! - state.tick_at) / 60_000));
      const windowMs = state.config.fill_escalation_after_minutes * 60_000;
      return {
        summary: `Overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs target — held by override lock.`,
        detail: `Will lower to ${targetPricePH.toLocaleString('en-US')} sat/PH/day after lock expires (~${minsLeft} min).`,
        eta_ms: overrideUntil,
        event_started_ms: overrideUntil! - windowMs,
        event_kind: 'lower_after_override',
      };
    }

    const patienceMs = state.config.lower_patience_minutes * 60_000;
    const lowerReadySince = state.lower_ready_since;
    const patienceRemaining = lowerReadySince !== null
      ? Math.max(0, patienceMs - (state.tick_at - lowerReadySince))
      : patienceMs;
    if (patienceRemaining > 0) {
      const patienceEtaMs = state.tick_at + patienceRemaining;
      const minsLeft = Math.max(1, Math.ceil(patienceRemaining / 60_000));
      return {
        summary: `Overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs target — waiting for the market to settle before lowering.`,
        detail: `Will lower to ${targetPricePH.toLocaleString('en-US')} sat/PH/day after ~${minsLeft} more min of the market staying this cheap.`,
        eta_ms: patienceEtaMs,
        event_started_ms: lowerReadySince,
        event_kind: 'lower_after_override',
      };
    }

    if (cooldownRemainsMs > 0 && cooldownEndsMs !== null && lastDecrease !== null) {
      const minsLeft = Math.max(1, Math.ceil(cooldownRemainsMs / 60_000));
      return {
        summary: `Overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs target — Braiins price-decrease cooldown.`,
        detail: `Will lower to ${targetPricePH.toLocaleString('en-US')} sat/PH/day in ~${minsLeft} min.`,
        eta_ms: cooldownEndsMs,
        event_started_ms: lastDecrease,
        event_kind: 'lower_after_cooldown',
      };
    }
    const verb = runMode === 'LIVE' ? 'lower' : 'log lower (dry-run)';
    return {
      summary: `Will ${verb} bid to ${targetPricePH.toLocaleString('en-US')} sat/PH/day on the next tick.`,
      detail: `Currently overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs fillable + overpay.`,
      ...noEvent,
    };
  }

  return {
    summary: 'On target — no action expected.',
    detail: `Bid filling at ${primary.avg_speed_ph.toFixed(2)} PH/s; re-evaluating every tick.`,
    ...noEvent,
  };
}

function summariseConfig(
  config: {
    target_hashrate_ph: number;
    minimum_floor_hashrate_ph: number;
    overpay_sat_per_eh_day: number;
    max_bid_sat_per_eh_day: number;
    max_overpay_vs_hashprice_sat_per_eh_day: number | null;
    fill_escalation_step_sat_per_eh_day: number;
    bid_budget_sat: number;
    destination_pool_url: string;
    quiet_hours_start: string;
    quiet_hours_end: string;
    quiet_hours_timezone: string;
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
    overpay_sat_per_ph_day: config.overpay_sat_per_eh_day / EH_PER_PH,
    max_bid_sat_per_ph_day: fixedCapEh / EH_PER_PH,
    max_overpay_vs_hashprice_sat_per_ph_day:
      config.max_overpay_vs_hashprice_sat_per_eh_day !== null
        ? config.max_overpay_vs_hashprice_sat_per_eh_day / EH_PER_PH
        : null,
    effective_cap_sat_per_ph_day: effectiveCapEh / EH_PER_PH,
    binding_cap: bindingCap,
    fill_escalation_step_sat_per_ph_day: config.fill_escalation_step_sat_per_eh_day / EH_PER_PH,
    bid_budget_sat: config.bid_budget_sat,
    pool_url: config.destination_pool_url,
    quiet_hours_start: config.quiet_hours_start,
    quiet_hours_end: config.quiet_hours_end,
    quiet_hours_timezone: config.quiet_hours_timezone,
    effective_target_hashrate_ph: effectiveTargetPh,
    cheap_mode_active: cheapModeActive,
  };
}
