/**
 * Shared wire types for the daemon → dashboard HTTP API.
 *
 * All prices are in **sat/PH/day** in the response (API-side storage stays
 * in sat/EH/day; the server divides by 1000 on serialisation). Rationale:
 * sat/EH/day numbers are 7-digit; sat/PH/day fit in 5 digits and read
 * naturally for the market scale the operator actually bids at.
 */

import type { ActionMode, RunMode } from '@hashrate-autopilot/shared';

import type { AppConfig } from '../config/schema.js';

export interface BidView {
  readonly braiins_order_id: string;
  readonly cl_order_id: string | null;
  readonly price_sat_per_ph_day: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number | null;
  readonly avg_speed_ph: number;
  readonly progress_pct: number | null;
  readonly amount_remaining_sat: number | null;
  readonly status: string;
  readonly is_owned: boolean;
  /** ms since epoch; null when we haven't recorded a creation timestamp. */
  readonly created_at_ms: number | null;
}

export interface BalanceView {
  readonly subaccount: string;
  readonly currency: string;
  readonly total_balance_sat: number;
  readonly available_balance_sat: number;
  readonly blocked_balance_sat: number;
}

/**
 * Discriminated next-action descriptor. Mirrors the cases that
 * `describeNextAction()` in the status route handles. The dashboard
 * renders this through Lingui catalogs so the message localizes; the
 * `summary` / `detail` strings on `NextActionView` below remain in
 * English as a fallback for older clients that don't know the kind.
 */
export type NextActionDescriptor =
  | { kind: 'paused' }
  | { kind: 'unknown_bids'; ids: readonly string[] }
  | { kind: 'braiins_unreachable' }
  | { kind: 'awaiting_hashprice' }
  | { kind: 'no_market_supply' }
  | {
      /** #373: CREATE hold - churn breaker (manual release) or marketplace blacklist (auto-release at until_ms). */
      kind: 'create_hold';
      hold_kind: 'churn' | 'blacklist';
      until_ms: number | null;
      detail: string;
      since_ms: number;
    }
  | {
      kind: 'will_create_bid';
      run_mode: 'LIVE' | 'DRY_RUN';
      target_ph: number;
      capped: boolean;
      target_ph_label: number;
      target_hashrate_ph: number;
      budget:
        | { kind: 'configured'; sat: number }
        | { kind: 'full_wallet'; available_sat: number }
        | { kind: 'awaiting_balance' };
    }
  | {
      kind: 'bid_pending';
      id_short: string;
      status: string; // e.g. 'created', 'paused', 'frozen'
    }
  | {
      kind: 'cooldown_active';
      target_ph: number;
      current_ph: number;
      mins_left: number;
      direction: 'lower' | 'raise';
    }
  | {
      kind: 'will_edit_bid';
      run_mode: 'LIVE' | 'DRY_RUN';
      target_ph: number;
      current_ph: number;
      clamped: boolean;
    }
  | { kind: 'on_target'; capped: boolean; avg_speed_ph: number };

export interface NextActionView {
  /** Discriminated descriptor for client-side translation. May be null on legacy responses. */
  readonly descriptor: NextActionDescriptor | null;
  readonly summary: string;
  readonly detail: string | null;
  /**
   * When a *concrete event with a known time* is queued (escalation
   * countdown, price-decrease cooldown, override lock), the dashboard
   * renders a progress bar between `event_started_ms` and `eta_ms`.
   * Steady state ("on target, nothing to do") leaves both null and no
   * bar is shown. Issue #4.
   */
  readonly eta_ms: number | null;
  readonly event_started_ms: number | null;
  readonly event_kind:
    | 'escalation'
    | 'lower_after_override'
    | 'lower_after_patience'
    | 'lower_after_cooldown'
    | null;
  /**
   * Breadcrumb of what the *most recent* tick actually executed -
   * "just lowered to X", "just raised to X", "just placed bid", etc.
   * Surfaced for a brief window so the operator sees explicit
   * confirmation that the action they were waiting for fired, instead
   * of the panel jumping silently from "Will lower …" to "On target".
   * `null` if the last tick made no autopilot mutation.
   */
  readonly last_executed: {
    readonly summary: string;
    readonly executed_at_ms: number;
  } | null;
}

export interface StatusResponse {
  readonly run_mode: RunMode;
  readonly action_mode: ActionMode;

  readonly tick_at: number | null;
  readonly last_api_ok_at: number | null;
  readonly next_tick_at: number | null;
  readonly tick_interval_ms: number;
  readonly next_action: NextActionView;
  readonly balances: readonly BalanceView[];

  readonly market: {
    readonly best_bid_sat_per_ph_day: number | null;
    readonly best_ask_sat_per_ph_day: number | null;
    /**
     * Depth-aware "fillable ask" - the cheapest price at which the full
     * `target_hashrate_ph` is fillable by walking asks cumulatively. This
     * is what the autopilot actually targets (plus `overpay`).
     * `null` when the market has no supply at all.
     */
    readonly fillable_ask_sat_per_ph_day: number | null;
    /** True when cumulative supply across the whole book is under target. */
    readonly fillable_thin: boolean;
  } | null;

  readonly pool: {
    readonly reachable: boolean;
    readonly last_ok_at: number | null;
    readonly consecutive_failures: number;
    readonly error: string | null;
    readonly latency_ms: number | null;
  };

  /**
   * Datum Gateway stats. `null` means the integration is disabled
   * (no `datum_api_url` set). When present, the dashboard shows a
   * Datum panel; `reachable: false` means the API is configured but
   * the last poll failed.
   */
  readonly datum: {
    readonly reachable: boolean;
    readonly connections: number | null;
    readonly hashrate_ph: number | null;
    readonly last_ok_at: number | null;
    readonly consecutive_failures: number;
  } | null;

  readonly bids: readonly BidView[];
  readonly actual_hashrate_ph: number;
  /**
   * Rolling 3-hour average of `delivered_ph` from `tick_metrics`.
   * Used by the dashboard to stabilise the projected-spend-per-day and
   * runway forecasts (matches Ocean's 3-hour-hashrate window, so the
   * income and spend sides of the P&L panel are on the same cadence).
   * `null` until at least one tick exists inside the window.
   */
  readonly avg_delivered_ph_3h: number | null;
  /**
   * Actual sat spent per day over the last 3 h, derived from
   * `primary_bid_consumed_sat` deltas (what Braiins charged, not a
   * model of `bid × delivered`). Drives the runway forecast. Null
   * until at least ~5 min of matched data exists in the window.
   */
  readonly actual_spend_per_day_sat_3h: number | null;
  /**
   * Live effective rate in sat/PH/day, derived as the duration-weighted
   * average of valid inter-tick `primary_bid_consumed_sat` deltas over
   * a 30-min trailing window, capped at the duration-weighted average
   * bid (since under pay-your-bid the bid is a hard ceiling - anything
   * above is a computation artefact of `avg_speed_ph` lag). Powers the
   * hero PRICE card on the Status page; distinct from the range-
   * averaged `avg cost / PH delivered` in the stats row, which uses
   * the same formula over the chart-selected range. Null until at
   * least one valid sample exists in the window.
   */
  readonly live_effective_sat_per_ph_day: number | null;
  readonly below_floor_since: number | null;

  readonly last_proposals: readonly ProposalView[];
  readonly config_summary: {
    readonly target_hashrate_ph: number;
    readonly minimum_floor_hashrate_ph: number;
    readonly max_bid_sat_per_ph_day: number;
    /** Hashprice-relative cap (null when disabled). */
    readonly max_overpay_vs_hashprice_sat_per_ph_day: number | null;
    /** Tighter of the two caps for this tick, shown to the operator so
     *  they can see which one is actually binding. Falls back to the
     *  fixed cap when the dynamic cap is disabled or hashprice is
     *  unavailable. */
    readonly effective_cap_sat_per_ph_day: number;
    readonly binding_cap: 'fixed' | 'dynamic';
    readonly bid_budget_sat: number;
    readonly pool_url: string;
    readonly effective_target_hashrate_ph: number;
    readonly cheap_mode_active: boolean;
  };

  /**
   * #293: live snapshot for the bid-vs-hashprice tile.
   * `bid_vs_hashprice_pct` is `(fillable + overpay) / hashprice` as a
   * percent - the exact quantity cheap mode checks against
   * `threshold_pct`. `window` carries sustained-window progress when
   * `cheap_sustained_window_minutes > 0`. null when cheap mode isn't
   * configured or hashprice/fillable is unavailable this tick.
   */
  readonly cheap_status: {
    readonly enabled: boolean;
    readonly bid_vs_hashprice_pct: number | null;
    readonly threshold_pct: number;
    readonly engaged: boolean;
    readonly target_hashrate_ph: number;
    readonly cheap_target_hashrate_ph: number;
    readonly window: {
      readonly ticks_below: number;
      readonly ticks_required: number;
      readonly minutes: number;
    } | null;
  } | null;
  /**
   * #335: current Bitcoin chain tip, for the "block height" tile. Null
   * when no bitcoind RPC is configured (the tile hides in that case).
   */
  readonly chain_tip: {
    readonly height: number;
    readonly hash: string;
    readonly found_by_ocean: boolean;
    readonly signals_bip110: boolean;
    /** Coinbase pool tag ("Ocean", "Foundry USA Pool", ...) or null. */
    readonly pool_tag: string | null;
    /** Inner miner tag (mainly Ocean's per-miner identity) or null. */
    readonly miner_tag: string | null;
  } | null;
}

export interface ProposalView {
  readonly kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID' | 'PAUSE';
  readonly summary: string;
  readonly reason: string;
  readonly allowed: boolean;
  readonly gate_reason: string | null;
  readonly executed: 'DRY_RUN' | 'EXECUTED' | 'BLOCKED' | 'FAILED';
  /**
   * #372: the raw execution error, verbatim from the marketplace API,
   * when `executed === 'FAILED'`. Null for every other outcome. The
   * dashboard renders it under the FAILED badge; it is server data and
   * is deliberately NOT translated.
   */
  readonly error: string | null;
}

export interface DecisionSummary {
  readonly id: number;
  readonly tick_at: number;
  readonly run_mode: string;
  readonly action_mode: string;
  readonly proposal_count: number;
}

export interface DecisionDetail extends DecisionSummary {
  readonly observed: unknown;
  readonly proposed: unknown;
  readonly gated: unknown;
  readonly executed: unknown;
}

export interface ConfigResponse {
  readonly config: AppConfig;
  /**
   * #331: which credential fields are configured. Their values are
   * blanked in `config` (write-only over the API); this tells the UI to
   * show "configured / leave blank to keep" instead of an empty field.
   */
  readonly credentials_set?: Record<string, boolean>;
}

export interface UpdateRunModeBody {
  readonly run_mode: RunMode;
}
