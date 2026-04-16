/**
 * Domain types for the control loop. Everything here is JSON-serialisable —
 * full ticks get written to the `decisions` table for post-hoc debugging
 * (SPEC §9: "All autopilot decisions are logged with the input state").
 */

import type {
  AccountBalances,
  FeeSchedule,
  MarketSettings,
  MarketStats,
  OrderbookSnapshot,
} from '@braiins-hashrate/braiins-client';
import type { ActionMode, RunMode } from '@braiins-hashrate/shared';

import type { AppConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Observed state
// ---------------------------------------------------------------------------

export interface MarketSnapshot {
  readonly stats: MarketStats;
  readonly orderbook: OrderbookSnapshot;
  readonly settings: MarketSettings;
  readonly fee: FeeSchedule;
  readonly best_ask_sat: number | null;
  readonly best_bid_sat: number | null;
}

export interface PoolHealth {
  readonly reachable: boolean;
  readonly last_ok_at: number | null;
  readonly consecutive_failures: number;
}

/**
 * A bid we consider our own. Reconciled from the Braiins `/spot/bid/current`
 * response against the `owned_bids` ledger. See SPEC §10.
 */
export interface OwnedBidSnapshot {
  readonly braiins_order_id: string;
  readonly cl_order_id: string | null;
  readonly price_sat: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number | null;
  readonly avg_speed_ph: number;
  readonly progress_pct: number;
  readonly amount_remaining_sat: number;
  readonly status: string;
  readonly last_price_decrease_at: number | null;
}

/**
 * A bid in the account that is NOT in our local ledger. Per SPEC §9
 * "unknown-order detection", their presence pushes us to PAUSED.
 */
export interface UnknownBidSnapshot {
  readonly braiins_order_id: string;
  readonly price_sat: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number | null;
  readonly avg_speed_ph: number;
  readonly status: string;
}

export interface ActualHashrate {
  readonly owned_ph: number;
  readonly unknown_ph: number;
  readonly total_ph: number;
}

export interface State {
  readonly tick_at: number;
  readonly run_mode: RunMode;
  readonly action_mode: ActionMode;
  readonly operator_available: boolean;
  /**
   * If set, EDIT_PRICE is suppressed until this wall-clock time. Set by
   * manual operator actions (bump-price) so the autopilot doesn't revert
   * the operator's override on the very next tick.
   */
  readonly manual_override_until_ms: number | null;

  readonly config: AppConfig;

  /** null if the Braiins API was unreachable this tick. */
  readonly market: MarketSnapshot | null;
  /** null if account/balance failed. */
  readonly balance: AccountBalances | null;

  readonly owned_bids: readonly OwnedBidSnapshot[];
  readonly unknown_bids: readonly UnknownBidSnapshot[];

  readonly actual_hashrate: ActualHashrate;
  /** When we first observed hashrate below floor, or null if currently OK. */
  readonly below_floor_since: number | null;

  readonly pool: PoolHealth;

  /** Last successful API read timestamp (ms). */
  readonly last_api_ok_at: number | null;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalKind = 'CREATE_BID' | 'EDIT_PRICE' | 'CANCEL_BID' | 'PAUSE';

export interface CreateBidProposal {
  readonly kind: 'CREATE_BID';
  readonly price_sat: number;
  readonly amount_sat: number;
  readonly speed_limit_ph: number;
  readonly dest_pool_url: string;
  readonly dest_worker_name: string;
  readonly reason: string;
}

export interface EditPriceProposal {
  readonly kind: 'EDIT_PRICE';
  readonly braiins_order_id: string;
  readonly new_price_sat: number;
  readonly old_price_sat: number;
  readonly reason: string;
}

export interface CancelBidProposal {
  readonly kind: 'CANCEL_BID';
  readonly braiins_order_id: string;
  readonly reason: string;
}

export interface PauseProposal {
  readonly kind: 'PAUSE';
  readonly reason: string;
}

export type Proposal = CreateBidProposal | EditPriceProposal | CancelBidProposal | PauseProposal;

// ---------------------------------------------------------------------------
// Gate outcomes
// ---------------------------------------------------------------------------

export type GateDenialReason =
  | 'RUN_MODE_NOT_LIVE'
  | 'RUN_MODE_PAUSED'
  | 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT'
  | 'PRICE_DECREASE_COOLDOWN';

export type GateOutcome =
  | { readonly proposal: Proposal; readonly allowed: true }
  | { readonly proposal: Proposal; readonly allowed: false; readonly reason: GateDenialReason };

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionResult =
  | { readonly proposal: Proposal; readonly outcome: 'DRY_RUN'; readonly note: string }
  | { readonly proposal: Proposal; readonly outcome: 'EXECUTED'; readonly note: string }
  | { readonly proposal: Proposal; readonly outcome: 'BLOCKED'; readonly reason: GateDenialReason }
  | { readonly proposal: Proposal; readonly outcome: 'FAILED'; readonly error: string };

export interface TickRecord {
  readonly state: State;
  readonly proposals: readonly Proposal[];
  readonly gated: readonly GateOutcome[];
  readonly executed: readonly ExecutionResult[];
}
