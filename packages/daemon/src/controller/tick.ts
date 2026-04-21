/**
 * One control-loop tick: observe → decide → gate → execute + persist.
 *
 * Pure-ish orchestration layer; hosts no business logic itself.
 *
 * Controller state (`belowFloorSince`, `lowerReadySince`, `aboveFloorTicks`)
 * is mirrored to `runtime_state` on every tick and seeded from there via
 * `hydrate()` on boot, so the escalation timer and the lower-patience
 * timer both survive restarts (issue #11). The `manualOverrideUntilMs`
 * lock is intentionally *not* persisted — it exists to bound a single
 * operator/escalation interaction and a restart is a clean reset point
 * for that.
 *
 * `lowerReadySince` tracks "time since the market has been continuously
 * cheap enough that lowering would save at least `min_lower_delta`".
 * The older heuristic (time since hashrate came back above floor) fired
 * too readily on bids that were filling but only marginally overpriced;
 * operators reported lowering kicking in after just a few minutes when
 * they'd set `lower_patience_minutes` to 30. The timer resets the
 * instant the condition becomes false, so a short market dip that
 * reverses inside the patience window can't trigger a lower.
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
  /** Sync read of the latest hashprice from Ocean stats (sat/PH/day). */
  readonly getHashprice?: () => number | null;
}

export interface TickResult {
  readonly state: State;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly GateOutcome[];
  readonly executed: readonly ExecutionResult[];
}

export class Controller {
  private belowFloorSince: number | null = null;
  private lowerReadySince: number | null = null;
  private belowTargetSince: number | null = null;
  private aboveFloorTicks: number = 0;
  private manualOverrideUntilMs: number | null = null;
  /**
   * One-shot flag set by `bypassPacingOnce()` — consumed by the next
   * tick() and cleared immediately, so a manual "Run decision now"
   * override doesn't leak into the following automatic tick.
   */
  private bypassPacingNextTick = false;
  private lastResult: TickResult | null = null;

  constructor(private readonly deps: TickDeps) {}

  /**
   * Arm a one-shot pacing bypass for the next tick — decide() will
   * skip its self-imposed patience and escalation timers. Called by
   * the "Run decision now" route (`/api/actions/tick-now`) so the
   * operator can realise a pending decision without waiting out the
   * full patience window. No effect on server-side gates (Braiins
   * cooldown, run_mode).
   */
  bypassPacingOnce(): void {
    this.bypassPacingNextTick = true;
  }

  /**
   * Seed in-memory floor-state from the persisted `runtime_state` row.
   * Call once at boot, after the migration runner. Idempotent — safe to
   * call multiple times if needed.
   */
  async hydrate(): Promise<void> {
    const row = await this.deps.runtimeRepo.get();
    if (!row) return;
    this.belowFloorSince = row.below_floor_since_ms;
    this.lowerReadySince = row.lower_ready_since_ms;
    this.belowTargetSince = row.below_target_since_ms;
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
    const bypassPacing = this.bypassPacingNextTick;
    this.bypassPacingNextTick = false;
    let state = await observe(this.deps, {
      previousBelowFloorSince: this.belowFloorSince,
      previousAboveFloorTicks: this.aboveFloorTicks,
      manualOverrideUntilMs: this.manualOverrideUntilMs,
      hashpriceSatPerPhDay: this.deps.getHashprice?.() ?? null,
      bypassPacing,
    });
    this.belowFloorSince = state.below_floor_since;
    this.aboveFloorTicks = state.above_floor_ticks;

    // Lower-ready timer: continuously true when our primary bid is
    // priced high enough above (fillable + overpay) that lowering
    // would save at least `min_lower_delta_sat_per_eh_day`. When the
    // condition flips false the timer resets — so a brief market dip
    // that reverses inside `lower_patience_minutes` can't trigger a
    // lower and burn the Braiins 10-min decrease cooldown. This
    // mirrors the lowering condition in decide() exactly (modulo the
    // capped-target edge case: when the market is too expensive
    // decide() returns [] without touching the bid, so the timer's
    // value is irrelevant).
    const lowerReadyNow = computeLowerReady(state);
    if (lowerReadyNow) {
      if (this.lowerReadySince === null) this.lowerReadySince = state.tick_at;
    } else {
      this.lowerReadySince = null;
    }

    // Below-target timer for `escalation_mode = 'above_market'`.
    // Condition: we have a primary bid, the market has a fillable ask,
    // and our bid sits strictly under `fillable + overpay` (i.e., the
    // market has closed the overpay gap we paid for). Same continuous-
    // truth semantics as `lower_ready_since`: any tick where the
    // condition flips false resets the timer, so a one-tick market
    // spike that retreats within a minute can't fire the preemptive
    // raise.
    const belowTargetNow = computeBelowTarget(state);
    if (belowTargetNow) {
      if (this.belowTargetSince === null) this.belowTargetSince = state.tick_at;
    } else {
      this.belowTargetSince = null;
    }

    state = {
      ...state,
      lower_ready_since: this.lowerReadySince,
      below_target_since: this.belowTargetSince,
    };

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

    // After any CREATE or EDIT_PRICE that actually fired, lock the
    // price for one full escalation window. Prevents:
    // - same-window re-escalation after an upward EDIT
    // - immediate lowering after a CREATE at a high price (the fill
    //   needs time to establish before we start chasing the market
    //   back down and burning the Braiins 10-min decrease cooldown)
    const windowMs = state.config.fill_escalation_after_minutes * 60_000;
    for (const e of executed) {
      if (
        (e.proposal.kind === 'EDIT_PRICE' || e.proposal.kind === 'CREATE_BID') &&
        e.outcome === 'EXECUTED'
      ) {
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
      lower_ready_since_ms: this.lowerReadySince,
      below_target_since_ms: this.belowTargetSince,
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
        hashprice_sat_per_eh_day: state.hashprice_sat_per_ph_day !== null
          ? state.hashprice_sat_per_ph_day * 1000
          : null,
        max_bid_sat_per_eh_day: state.config.max_bid_sat_per_eh_day,
        available_balance_sat: primaryBalance?.available_balance_sat ?? null,
        datum_hashrate_ph: state.datum?.hashrate_ph ?? null,
        ocean_hashrate_ph: state.ocean_hashrate_ph,
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

/**
 * Mirror of decide()'s lowering condition, used to drive the
 * `lower_ready_since` patience timer. Returns true when lowering the
 * primary bid to (fillable + overpay) would save more than
 * `min_lower_delta_sat_per_eh_day`. Kept close to decide.ts so the
 * two stay in lockstep — any change to the lowering gate there should
 * update this predicate too.
 *
 * Returns false when: no market snapshot, no asks, no primary bid, or
 * the saving is under the deadband. Does NOT consult the effective
 * cap — on ticks where the market is too expensive decide() returns
 * [] without lowering anyway, so the timer's value is unused there;
 * keeping this predicate simple means `lower_ready_since` has a
 * straightforward "market is genuinely cheaper than my bid" meaning.
 */
function computeLowerReady(state: State): boolean {
  if (!state.market) return false;
  const asks = state.market.orderbook.asks ?? [];
  if (asks.length === 0) return false;
  if (state.owned_bids.length === 0) return false;
  const fillable = cheapestAskForDepth(asks, state.config.target_hashrate_ph);
  if (fillable.price_sat === null) return false;
  const desiredPrice = fillable.price_sat + state.config.overpay_sat_per_eh_day;
  const primary = [...state.owned_bids].sort((a, b) =>
    a.braiins_order_id.localeCompare(b.braiins_order_id),
  )[0];
  if (!primary || primary.price_sat === null) return false;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  const lowerThreshold = Math.max(tickSize, state.config.min_lower_delta_sat_per_eh_day);
  return primary.price_sat > desiredPrice + lowerThreshold;
}

/**
 * Mirror of `computeLowerReady` for the upward direction — drives the
 * `below_target_since` timer used under `escalation_mode =
 * 'above_market'`. Returns true when our primary bid sits strictly
 * below the `fillable + overpay` target, i.e., the market has closed
 * the overpay gap. Does NOT consult the effective cap, matching the
 * `computeLowerReady` simplification: on ticks where decide() can't
 * escalate (market too expensive vs. cap) the timer's value is
 * harmlessly unused because decide() returns [] up-front. Keeping
 * this predicate simple means the timer has a straightforward "market
 * has caught up to my bid" meaning.
 */
function computeBelowTarget(state: State): boolean {
  if (!state.market) return false;
  const asks = state.market.orderbook.asks ?? [];
  if (asks.length === 0) return false;
  if (state.owned_bids.length === 0) return false;
  const fillable = cheapestAskForDepth(asks, state.config.target_hashrate_ph);
  if (fillable.price_sat === null) return false;
  const desiredPrice = fillable.price_sat + state.config.overpay_sat_per_eh_day;
  const primary = [...state.owned_bids].sort((a, b) =>
    a.braiins_order_id.localeCompare(b.braiins_order_id),
  )[0];
  if (!primary || primary.price_sat === null) return false;
  return primary.price_sat < desiredPrice;
}
