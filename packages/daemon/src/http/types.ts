/**
 * Shared wire types for the daemon → dashboard HTTP API.
 *
 * All prices are in **sat/PH/day** in the response (API-side storage stays
 * in sat/EH/day; the server divides by 1000 on serialisation). Rationale:
 * sat/EH/day numbers are 7-digit; sat/PH/day fit in 5 digits and read
 * naturally for the market scale the operator actually bids at.
 */

import type { ActionMode, RunMode } from '@braiins-hashrate/shared';

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

export interface NextActionView {
  readonly summary: string;
  readonly detail: string | null;
}

export interface StatusResponse {
  readonly run_mode: RunMode;
  readonly action_mode: ActionMode;
  readonly operator_available: boolean;

  readonly tick_at: number | null;
  readonly last_api_ok_at: number | null;
  readonly next_tick_at: number | null;
  readonly tick_interval_ms: number;
  readonly next_action: NextActionView;
  readonly balances: readonly BalanceView[];

  readonly market: {
    readonly best_bid_sat_per_ph_day: number | null;
    readonly best_ask_sat_per_ph_day: number | null;
  } | null;

  readonly pool: {
    readonly reachable: boolean;
    readonly last_ok_at: number | null;
    readonly consecutive_failures: number;
  };

  readonly bids: readonly BidView[];
  readonly actual_hashrate_ph: number;
  readonly below_floor_since: number | null;

  readonly last_proposals: readonly ProposalView[];
  readonly config_summary: {
    readonly target_hashrate_ph: number;
    readonly minimum_floor_hashrate_ph: number;
    readonly max_price_sat_per_ph_day: number;
    readonly emergency_max_price_sat_per_ph_day: number;
    readonly fill_escalation_step_sat_per_ph_day: number;
    readonly bid_budget_sat: number;
    readonly pool_url: string;
    readonly quiet_hours_start: string;
    readonly quiet_hours_end: string;
    readonly quiet_hours_timezone: string;
  };
}

export interface ProposalView {
  readonly kind: 'CREATE_BID' | 'EDIT_PRICE' | 'CANCEL_BID' | 'PAUSE';
  readonly summary: string;
  readonly reason: string;
  readonly allowed: boolean;
  readonly gate_reason: string | null;
  readonly executed: 'DRY_RUN' | 'EXECUTED' | 'BLOCKED' | 'FAILED';
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
}

export interface UpdateRunModeBody {
  readonly run_mode: RunMode;
}
