import type { FastifyInstance } from 'fastify';

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
        next_action: { summary: 'Waiting for first tick…', detail: null },
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
        ? {
            best_bid_sat_per_ph_day:
              state.market.best_bid_sat !== null ? state.market.best_bid_sat / EH_PER_PH : null,
            best_ask_sat_per_ph_day:
              state.market.best_ask_sat !== null ? state.market.best_ask_sat / EH_PER_PH : null,
          }
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
  if (runMode === 'PAUSED') {
    return {
      summary: 'Paused — no bids will be placed or edited until run mode changes.',
      detail: null,
    };
  }

  if (state.unknown_bids.length > 0) {
    return {
      summary: 'Unknown bid(s) detected — next tick will PAUSE the autopilot.',
      detail: `IDs: ${state.unknown_bids.map((b) => b.braiins_order_id.slice(0, 8) + '…').join(', ')}`,
    };
  }

  if (!state.market) {
    return {
      summary: 'Braiins API unreachable — waiting for connectivity.',
      detail: null,
    };
  }

  const ph = state.config.target_hashrate_ph;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  const cheapestAsk = findCheapestAvailable(state.market.orderbook.asks);
  if (cheapestAsk === null) {
    return {
      summary: 'No hashrate available on the market right now.',
      detail: 'Next tick will re-check supply.',
    };
  }
  const targetPriceEH = cheapestAsk + state.config.max_overpay_vs_ask_sat_per_eh_day;
  const targetPricePH = Math.round(targetPriceEH / EH_PER_PH);

  if (state.owned_bids.length === 0) {
    const verb = runMode === 'LIVE' ? 'place' : 'log (dry-run)';
    return {
      summary: `Will ${verb} a CREATE_BID on the next tick.`,
      detail: `~${targetPricePH.toLocaleString('en-US')} sat/PH/day, ${ph} PH/s target, ${state.config.bid_budget_sat.toLocaleString('en-US')} sat budget.`,
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
    };
  }

  const shortfall = ph - primary.avg_speed_ph;
  if (shortfall > 0.1) {
    // Minute-precision elapsed/remaining. Ceil on remaining so we never
    // claim "in 30 min" when it's actually 29m59s away.
    const windowMs = state.config.fill_escalation_after_minutes * 60_000;
    const elapsedMs = state.below_floor_since
      ? state.tick_at - state.below_floor_since
      : 0;
    const remainingMs = windowMs - (elapsedMs % windowMs);
    const remainingMin = Math.ceil(remainingMs / 60_000);
    return {
      summary: `Bid filling below target (${primary.avg_speed_ph.toFixed(2)}/${ph} PH/s).`,
      detail: `Escalation in ${remainingMin} min if still under floor. Current price ${currentPricePH.toLocaleString('en-US')} sat/PH/day; target ${targetPricePH.toLocaleString('en-US')}.`,
    };
  }

  return {
    summary: 'On target — no action expected.',
    detail: `Bid filling at ${primary.avg_speed_ph.toFixed(2)} PH/s; re-evaluating every tick.`,
  };
}

function findCheapestAvailable(
  asks: ReadonlyArray<{ price_sat?: number; hr_available_ph?: number }> | undefined,
): number | null {
  if (!asks) return null;
  const sorted = [...asks]
    .filter((a) => typeof a.price_sat === 'number')
    .sort((a, b) => (a.price_sat ?? 0) - (b.price_sat ?? 0));
  for (const a of sorted) {
    if ((a.hr_available_ph ?? 0) > 0 && a.price_sat) return a.price_sat;
  }
  return null;
}

function summariseConfig(config: {
  target_hashrate_ph: number;
  minimum_floor_hashrate_ph: number;
  max_price_sat_per_eh_day: number;
  emergency_max_price_sat_per_eh_day: number;
  bid_budget_sat: number;
  destination_pool_url: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
}): StatusResponse['config_summary'] {
  return {
    target_hashrate_ph: config.target_hashrate_ph,
    minimum_floor_hashrate_ph: config.minimum_floor_hashrate_ph,
    max_price_sat_per_ph_day: config.max_price_sat_per_eh_day / EH_PER_PH,
    emergency_max_price_sat_per_ph_day: config.emergency_max_price_sat_per_eh_day / EH_PER_PH,
    bid_budget_sat: config.bid_budget_sat,
    pool_url: config.destination_pool_url,
    quiet_hours_start: config.quiet_hours_start,
    quiet_hours_end: config.quiet_hours_end,
    quiet_hours_timezone: config.quiet_hours_timezone,
  };
}
