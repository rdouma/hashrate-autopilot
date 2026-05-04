/**
 * One control-loop tick: observe → decide → gate → execute + persist.
 *
 * Pure-ish orchestration layer; hosts no business logic itself.
 *
 * Controller state is minimal after the #49 redesign: only
 * `belowFloorSince` and `aboveFloorTicks` (both drive the below-floor
 * alerting in main.ts, nothing to do with fill strategy). The old
 * escalation/lowering-patience timers (`lowerReadySince`,
 * `belowTargetSince`) and the manual-override lock have been retired
 * along with the fill-strategy subsystem. Their runtime_state columns
 * are kept for backwards compatibility but always written as null.
 */


import { decide } from './decide.js';
import { execute, type ExecuteDeps } from './execute.js';
import { gate } from './gate.js';
import { observe, type ObserveDeps } from './observe.js';
import type { ExecutionResult, GateOutcome, Proposal, State } from './types.js';

export interface TickDeps extends ObserveDeps, ExecuteDeps {
  // `tickMetricsRepo` is inherited from ObserveDeps (#50).
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
  private aboveFloorTicks: number = 0;
  private lastResult: TickResult | null = null;

  constructor(private readonly deps: TickDeps) {}

  /**
   * Seed in-memory floor-state from the persisted `runtime_state` row.
   * Call once at boot, after the migration runner. Idempotent.
   */
  async hydrate(): Promise<void> {
    const row = await this.deps.runtimeRepo.get();
    if (!row) return;
    this.belowFloorSince = row.below_floor_since_ms;
    this.aboveFloorTicks = row.above_floor_ticks;
  }

  async tick(): Promise<TickResult> {
    let state = await observe(this.deps, {
      previousBelowFloorSince: this.belowFloorSince,
      previousAboveFloorTicks: this.aboveFloorTicks,
      manualOverrideUntilMs: null,
      hashpriceSatPerPhDay: this.deps.getHashprice?.() ?? null,
      bypassPacing: false,
    });
    this.belowFloorSince = state.below_floor_since;
    this.aboveFloorTicks = state.above_floor_ticks;

    const proposals = decide(state);
    const gated = gate(proposals, state);
    const executed = await execute(this.deps, state, gated);

    // observe() ran *before* execute(), so `state.owned_bids` still
    // reflects the pre-execute world. Patch it in-memory so anything
    // downstream this tick (metrics row, lastResult consumed by
    // /api/status) sees the post-execute reality.
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

    // Persist runtime diagnostics. The retired timers are nulled out
    // on every tick — their columns are kept only for backwards-compat
    // with the runtime_state table shape.
    await this.deps.runtimeRepo.patch({
      last_tick_at: state.tick_at,
      last_api_ok_at: state.last_api_ok_at,
      last_pool_ok_at: state.pool.last_ok_at,
      below_floor_since_ms: this.belowFloorSince,
      lower_ready_since_ms: null,
      below_target_since_ms: null,
      above_floor_ticks: this.aboveFloorTicks,
    });

    // Metrics snapshot — one row per tick, used by the Hashrate chart.
    try {
      const primary = [...state.owned_bids].sort((a, b) =>
        a.braiins_order_id.localeCompare(b.braiins_order_id),
      )[0];
      const primaryBalance = state.balance?.accounts?.[0];
      // Under pay-your-bid (#53) the authoritative actual spend comes
      // from `primary_bid_consumed_sat` deltas — keep the legacy
      // `spend_sat` column null so downstream readers don't confuse it
      // with the real figure.
      const spendSat: number | null = null;
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
        fillable_ask_sat_per_eh_day: state.fillable_ask_sat_per_eh_day,
        hashprice_sat_per_eh_day: state.hashprice_sat_per_ph_day !== null
          ? state.hashprice_sat_per_ph_day * 1000
          : null,
        max_bid_sat_per_eh_day: state.config.max_bid_sat_per_eh_day,
        available_balance_sat: primaryBalance?.available_balance_sat ?? null,
        datum_hashrate_ph: state.datum?.hashrate_ph ?? null,
        ocean_hashrate_ph: state.ocean_hashrate_ph,
        share_log_pct: state.share_log_pct,
        spend_sat: spendSat,
        primary_bid_consumed_sat: primary ? primary.amount_consumed_sat : null,
        // #89: extended capture from sources we already poll.
        // observe() collects them onto State; tick.ts forwards.
        // primary_bid_fee_paid_sat is left null here - that field
        // lives on the per-bid detail counters, not the bids list,
        // and adding the per-bid /spot/bid/detail call is in scope
        // for #90 (bid acceptance ratio capture). Until then it
        // remains null.
        network_difficulty: state.network_difficulty,
        estimated_block_reward_sat: state.estimated_block_reward_sat,
        pool_hashrate_ph: state.pool_hashrate_ph,
        pool_active_workers: state.pool_active_workers,
        braiins_total_deposited_sat: state.braiins_total_deposited_sat,
        braiins_total_spent_sat: state.braiins_total_spent_sat,
        ocean_unpaid_sat: state.ocean_unpaid_sat,
        btc_usd_price: state.btc_usd_price,
        btc_usd_price_source: state.btc_usd_price_source,
        primary_bid_last_pause_reason: primary?.last_pause_reason ?? null,
        primary_bid_fee_paid_sat: null,
        primary_bid_fee_rate_pct: primary?.fee_rate_pct ?? null,
        pool_blocks_24h_count: state.pool_blocks_24h_count,
        pool_blocks_7d_count: state.pool_blocks_7d_count,
        pool_hashrate_ph_avg_24h: state.pool_hashrate_ph_avg_24h,
        pool_hashrate_ph_avg_7d: state.pool_hashrate_ph_avg_7d,
        pool_luck_24h: state.pool_luck_24h,
        pool_luck_7d: state.pool_luck_7d,
        run_mode: state.run_mode,
        action_mode: 'NORMAL' as const,
      });
    } catch (err) {
      console.warn(`[tick] metrics insert failed: ${(err as Error).message}`);
    }

    const result: TickResult = { state, proposals, gated, executed };
    this.lastResult = result;
    return result;
  }

  getLastResult(): TickResult | null {
    return this.lastResult;
  }
}
