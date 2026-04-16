/**
 * One control-loop tick: observe → decide → gate → execute + persist.
 *
 * Pure-ish orchestration layer; hosts no business logic itself.
 *
 * Controller state (`belowFloorSince`, `aboveFloorTicks`) is mirrored to
 * `runtime_state` on every tick and seeded from there via `hydrate()` on
 * boot, so the escalation timer survives restarts (issue #11). The
 * `manualOverrideUntilMs` lock is intentionally *not* persisted — it
 * exists to bound a single operator/escalation interaction and a
 * restart is a clean reset point for that.
 */

import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';

import { decide } from './decide.js';
import { execute, type ExecuteDeps } from './execute.js';
import { gate } from './gate.js';
import { observe, type ObserveDeps } from './observe.js';
import { cheapestAskForDepth } from './orderbook.js';
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
  private aboveFloorTicks: number = 0;
  private manualOverrideUntilMs: number | null = null;
  private lastResult: TickResult | null = null;

  constructor(private readonly deps: TickDeps) {}

  /**
   * Seed in-memory floor-state from the persisted `runtime_state` row.
   * Call once at boot, after the migration runner. Idempotent — safe to
   * call multiple times if needed.
   */
  async hydrate(): Promise<void> {
    const row = await this.deps.runtimeRepo.get();
    if (!row) return;
    this.belowFloorSince = row.below_floor_since_ms;
    this.aboveFloorTicks = row.above_floor_ticks;
  }

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

  /**
   * Drop the post-edit lock without waiting for it to expire. Used by
   * the "Run decision now" route — when the operator manually invokes
   * the controller, they're overriding their own autopilot's
   * self-imposed pacing, so suppressing the next decision because of a
   * stale lock is unhelpful. Returns the previous value so the caller
   * can report what (if anything) was cleared.
   */
  clearManualOverride(): number | null {
    const prev = this.manualOverrideUntilMs;
    this.manualOverrideUntilMs = null;
    return prev;
  }

  async tick(): Promise<TickResult> {
    if (this.manualOverrideUntilMs !== null && this.manualOverrideUntilMs <= this.deps.now()) {
      this.manualOverrideUntilMs = null;
    }
    let state = await observe(this.deps, {
      previousBelowFloorSince: this.belowFloorSince,
      previousAboveFloorTicks: this.aboveFloorTicks,
      manualOverrideUntilMs: this.manualOverrideUntilMs,
    });
    this.belowFloorSince = state.below_floor_since;
    this.aboveFloorTicks = state.above_floor_ticks;

    const proposals = decide(state);
    const gated = gate(proposals, state);
    const executed = await execute(this.deps, state, gated);

    // observe() ran *before* execute(), so `state.owned_bids` still
    // reflects the pre-execute world. Patch it in-memory so anything
    // downstream this tick (metrics row, lastResult consumed by
    // /api/status) sees the post-execute reality. Without this the
    // dashboard shows a stale hero price + a "will lower" prediction
    // for ~30s after a tick that just lowered, even though the chart's
    // bid-event marker is already visible. Next observe() picks up the
    // same data on its own a tick later, so this is a freshness-only
    // patch — no source-of-truth shift.
    const patchedOwnedBids = state.owned_bids
      .map((b) => {
        let next = b;
        const priceEdit = executed.find(
          (e) =>
            e.outcome === 'EXECUTED' &&
            e.proposal.kind === 'EDIT_PRICE' &&
            e.proposal.braiins_order_id === b.braiins_order_id,
        );
        if (priceEdit && priceEdit.proposal.kind === 'EDIT_PRICE') {
          next = { ...next, price_sat: priceEdit.proposal.new_price_sat };
        }
        const speedEdit = executed.find(
          (e) =>
            e.outcome === 'EXECUTED' &&
            e.proposal.kind === 'EDIT_SPEED' &&
            e.proposal.braiins_order_id === b.braiins_order_id,
        );
        if (speedEdit && speedEdit.proposal.kind === 'EDIT_SPEED') {
          next = { ...next, speed_limit_ph: speedEdit.proposal.new_speed_limit_ph };
        }
        return next;
      })
      .filter(
        (b) =>
          !executed.some(
            (e) =>
              e.outcome === 'EXECUTED' &&
              e.proposal.kind === 'CANCEL_BID' &&
              e.proposal.braiins_order_id === b.braiins_order_id,
          ),
      );
    state = { ...state, owned_bids: patchedOwnedBids };

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

    // Also bump runtime_state diagnostics + persist floor-tracking
    // state so the escalation timer survives daemon restarts (#11).
    await this.deps.runtimeRepo.patch({
      last_tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      last_pool_ok_at: state.pool.last_ok_at,
      below_floor_since_ms: this.belowFloorSince,
      above_floor_ticks: this.aboveFloorTicks,
    });

    // Metrics snapshot — one row per tick, used by the Hashrate chart.
    try {
      const primary = [...state.owned_bids].sort((a, b) =>
        a.braiins_order_id.localeCompare(b.braiins_order_id),
      )[0];
      const primaryBalance = state.balance?.accounts?.[0];
      const fillable = state.market
        ? cheapestAskForDepth(
            state.market.orderbook.asks ?? [],
            state.config.target_hashrate_ph,
          )
        : null;
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
        fillable_ask_sat_per_eh_day: fillable?.price_sat ?? null,
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
