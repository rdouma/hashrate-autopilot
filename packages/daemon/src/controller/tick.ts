/**
 * One control-loop tick: observe → decide → gate → execute + persist.
 *
 * Pure-ish orchestration layer; hosts no business logic itself. Keeps a
 * small piece of in-memory controller state (below_floor_since) that
 * survives across ticks but not across process restarts. M4 may promote
 * this to SQLite if we want it to survive crashes.
 */

import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';

import { decide } from './decide.js';
import { execute, type ExecuteDeps } from './execute.js';
import { gate } from './gate.js';
import { observe, type ObserveDeps } from './observe.js';
import type { ExecutionResult, GateOutcome, Proposal, State } from './types.js';

export interface TickDeps extends ObserveDeps, ExecuteDeps {
  readonly tickMetricsRepo: TickMetricsRepo;
}

export interface TickResult {
  readonly state: State;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly GateOutcome[];
  readonly executed: readonly ExecutionResult[];
}

export class Controller {
  private belowFloorSince: number | null = null;
  private manualOverrideUntilMs: number | null = null;
  private lastResult: TickResult | null = null;

  constructor(private readonly deps: TickDeps) {}

  /**
   * Record a manual operator override — autopilot EDIT_PRICE proposals
   * on the primary bid will be suppressed until `until`.
   */
  setManualOverrideUntil(until: number): void {
    this.manualOverrideUntilMs = until;
  }

  getManualOverrideUntil(): number | null {
    return this.manualOverrideUntilMs;
  }

  async tick(): Promise<TickResult> {
    if (this.manualOverrideUntilMs !== null && this.manualOverrideUntilMs <= this.deps.now()) {
      this.manualOverrideUntilMs = null;
    }
    const state = await observe(this.deps, {
      previousBelowFloorSince: this.belowFloorSince,
      manualOverrideUntilMs: this.manualOverrideUntilMs,
    });
    this.belowFloorSince = state.below_floor_since;

    const proposals = decide(state);
    const gated = gate(proposals, state);
    const executed = await execute(this.deps, state, gated);

    // After any EDIT_PRICE that actually fired, lock the new price in
    // for one full escalation window. Prevents same-window re-escalation
    // and blocks any automatic revert. Manual bumps already set this
    // via the actions route.
    const windowMs = state.config.fill_escalation_after_minutes * 60_000;
    for (const e of executed) {
      if (e.proposal.kind === 'EDIT_PRICE' && e.outcome === 'EXECUTED') {
        this.manualOverrideUntilMs = state.tick_at + windowMs;
        break;
      }
    }

    // Also bump runtime_state diagnostics.
    await this.deps.runtimeRepo.patch({
      last_tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      last_pool_ok_at: state.pool.last_ok_at,
    });

    // Metrics snapshot — one row per tick, used by the Hashrate chart.
    try {
      const primary = [...state.owned_bids].sort((a, b) =>
        a.braiins_order_id.localeCompare(b.braiins_order_id),
      )[0];
      const primaryBalance = state.balance?.accounts?.[0];
      await this.deps.tickMetricsRepo.insert({
        tick_at: state.tick_at,
        delivered_ph: state.actual_hashrate.total_ph,
        target_ph: state.config.target_hashrate_ph,
        floor_ph: state.config.minimum_floor_hashrate_ph,
        owned_bid_count: state.owned_bids.length,
        unknown_bid_count: state.unknown_bids.length,
        our_primary_price_sat_per_eh_day: primary?.price_sat ?? null,
        best_bid_sat_per_eh_day: state.market?.best_bid_sat ?? null,
        best_ask_sat_per_eh_day: state.market?.best_ask_sat ?? null,
        available_balance_sat: primaryBalance?.available_balance_sat ?? null,
        run_mode: state.run_mode,
        action_mode: state.action_mode,
      });
    } catch (err) {
      console.warn(`[tick] metrics insert failed: ${(err as Error).message}`);
    }

    const result: TickResult = { state, proposals, gated, executed };
    this.lastResult = result;
    return result;
  }

  /**
   * Latest tick result, or null if the first tick hasn't completed yet.
   * Consumed by the HTTP /api/status handler.
   */
  getLastResult(): TickResult | null {
    return this.lastResult;
  }
}
