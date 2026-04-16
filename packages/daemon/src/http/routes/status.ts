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
        },
        balances: [],
        market: null,
        pool: {
          reachable: false,
          last_ok_at: runtime.last_pool_ok_at,
          consecutive_failures: 0,
        },
        bids: [],
        actual_hashrate_ph: 0,
        below_floor_since: null,
        last_proposals: [],
        config_summary: summariseConfig(config),
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

    return {
      run_mode: liveRunMode,
      action_mode: liveActionMode,
      operator_available: liveOperatorAvailable,
      tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      next_tick_at: nextTickAt,
      tick_interval_ms: tickIntervalMs,
      next_action: describeNextAction(state, liveRunMode),
      balances,
      market: state.market
        ? (() => {
            const fillable = cheapestAskForDepth(
              state.market.orderbook.asks,
              config.target_hashrate_ph,
            );
            return {
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
            };
          })()
        : null,
      pool: {
        reachable: state.pool.reachable,
        last_ok_at: state.pool.last_ok_at,
        consecutive_failures: state.pool.consecutive_failures,
      },
      bids,
      actual_hashrate_ph: state.actual_hashrate.total_ph,
      below_floor_since: state.below_floor_since,
      last_proposals,
      config_summary: summariseConfig(config),
    };
  });
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
function describeNextAction(state: State, runMode: State['run_mode']): NextActionView {
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
  const targetPriceEH = cheapestAsk + state.config.max_overpay_sat_per_eh_day;
  const targetPricePH = Math.round(targetPriceEH / EH_PER_PH);

  if (state.owned_bids.length === 0) {
    const verb = runMode === 'LIVE' ? 'place' : 'log (dry-run)';
    return {
      summary: `Will ${verb} a CREATE_BID on the next tick.`,
      detail: `~${targetPricePH.toLocaleString('en-US')} sat/PH/day, ${ph} PH/s target, ${state.config.bid_budget_sat.toLocaleString('en-US')} sat budget.`,
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

  const shortfall = ph - primary.avg_speed_ph;
  if (shortfall > 0.1) {
    const windowMs = state.config.fill_escalation_after_minutes * 60_000;
    const startMs = state.below_floor_since;
    const elapsedMs = startMs ? state.tick_at - startMs : 0;
    const remainingMs = windowMs - elapsedMs;
    const countdownText =
      remainingMs > 0
        ? `Escalation in ${Math.max(1, Math.ceil(remainingMs / 60_000))} min`
        : `Escalation overdue by ${Math.max(1, Math.ceil(-remainingMs / 60_000))} min`;
    return {
      summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s).`,
      detail: `${countdownText} if still under floor. Current price ${currentPricePH.toLocaleString('en-US')} sat/PH/day; target ${targetPricePH.toLocaleString('en-US')}.`,
      // Only emit a progress bar when we know when the timer started —
      // otherwise the bar has no meaningful start anchor.
      eta_ms: startMs !== null ? startMs + windowMs : null,
      event_started_ms: startMs,
      event_kind: startMs !== null ? 'escalation' : null,
    };
  }

  // Over-paying check: if our bid is materially above target (fillable +
  // max_overpay) — by more than min_lower_delta — the next tick will
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
      // Approx: bar fills from one escalation window before the unlock
      // (when the override was set) to the unlock time.
      const windowMs = state.config.fill_escalation_after_minutes * 60_000;
      return {
        summary: `Overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs target — held by override lock.`,
        detail: `Will lower to ${targetPricePH.toLocaleString('en-US')} sat/PH/day after lock expires (~${minsLeft} min).`,
        eta_ms: overrideUntil,
        event_started_ms: overrideUntil! - windowMs,
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
      detail: `Currently overpaying by ${overpayPH.toLocaleString('en-US')} sat/PH/day vs fillable + max overpay.`,
      ...noEvent,
    };
  }

  return {
    summary: 'On target — no action expected.',
    detail: `Bid filling at ${primary.avg_speed_ph.toFixed(2)} PH/s; re-evaluating every tick.`,
    ...noEvent,
  };
}

function summariseConfig(config: {
  target_hashrate_ph: number;
  minimum_floor_hashrate_ph: number;
  max_bid_sat_per_eh_day: number;
  emergency_max_bid_sat_per_eh_day: number;
  fill_escalation_step_sat_per_eh_day: number;
  bid_budget_sat: number;
  destination_pool_url: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
}): StatusResponse['config_summary'] {
  return {
    target_hashrate_ph: config.target_hashrate_ph,
    minimum_floor_hashrate_ph: config.minimum_floor_hashrate_ph,
    max_bid_sat_per_ph_day: config.max_bid_sat_per_eh_day / EH_PER_PH,
    emergency_max_bid_sat_per_ph_day: config.emergency_max_bid_sat_per_eh_day / EH_PER_PH,
    fill_escalation_step_sat_per_ph_day: config.fill_escalation_step_sat_per_eh_day / EH_PER_PH,
    bid_budget_sat: config.bid_budget_sat,
    pool_url: config.destination_pool_url,
    quiet_hours_start: config.quiet_hours_start,
    quiet_hours_end: config.quiet_hours_end,
    quiet_hours_timezone: config.quiet_hours_timezone,
  };
}
