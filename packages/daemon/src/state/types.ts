/**
 * Kysely table row types for the SQLite schema in migrations/0001_initial.sql.
 *
 * These types drive compile-time checks on every query. Keep them in sync
 * when adding migrations. Generated<T> marks auto-populated columns (PK
 * autoincrement, defaults) so inserts don't require them.
 */

import type { Generated } from 'kysely';

import type { ActionMode, RunMode } from '@braiins-hashrate/shared';

// ---------------------------------------------------------------------------
// config (single-row pattern)
// ---------------------------------------------------------------------------

export interface ConfigTable {
  id: 1;
  target_hashrate_ph: number;
  minimum_floor_hashrate_ph: number;
  destination_pool_url: string;
  destination_pool_worker_name: string;
  max_bid_sat_per_eh_day: number;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  emergency_max_bid_sat_per_eh_day: number;
  bid_budget_sat: number;
  wallet_runway_alert_days: number;
  below_floor_alert_after_minutes: number;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  below_floor_emergency_cap_after_minutes: number;
  zero_hashrate_loud_alert_after_minutes: number;
  pool_outage_blip_tolerance_seconds: number;
  api_outage_alert_after_minutes: number;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
  confirmation_timeout_minutes: number;
  handover_window_minutes: number;
  btc_payout_address: string;
  telegram_chat_id: string;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  hibernate_on_expensive_market: 0 | 1;
  electrs_host: string | null;
  electrs_port: number | null;
  boot_mode: 'ALWAYS_DRY_RUN' | 'LAST_MODE' | 'ALWAYS_LIVE';
  spent_scope: 'autopilot' | 'account';
  btc_price_source: 'none' | 'coingecko' | 'coinbase' | 'bitstamp' | 'kraken';
  cheap_target_hashrate_ph: number;
  cheap_threshold_pct: number;
  cheap_sustained_window_minutes: number;
  bitcoind_rpc_url: string;
  bitcoind_rpc_user: string;
  bitcoind_rpc_password: string;
  payout_source: 'none' | 'electrs' | 'bitcoind';
  tick_metrics_retention_days: number;
  decisions_uneventful_retention_days: number;
  decisions_eventful_retention_days: number;
  datum_api_url: string | null;
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
  block_explorer_url_template: string;
  braiins_hashrate_smoothing_minutes: number;
  datum_hashrate_smoothing_minutes: number;
  braiins_price_smoothing_minutes: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// runtime_state (single-row pattern)
// ---------------------------------------------------------------------------

export interface RuntimeStateTable {
  id: 1;
  run_mode: RunMode;
  action_mode: ActionMode;
  operator_available: 0 | 1;
  last_tick_at: number | null;
  last_api_ok_at: number | null;
  last_rpc_ok_at: number | null;
  last_pool_ok_at: number | null;
  below_floor_since_ms: number | null;
  /** @deprecated Kept as nullable column; escalation/lowering logic removed. */
  lower_ready_since_ms: number | null;
  /** @deprecated Kept as nullable column; escalation logic removed. */
  below_target_since_ms: number | null;
  above_floor_ticks: number;
}

// ---------------------------------------------------------------------------
// owned_bids
// ---------------------------------------------------------------------------

export interface OwnedBidsTable {
  braiins_order_id: string;
  cl_order_id: string | null;
  created_at: number;
  first_seen_active_at: number | null;
  last_known_status: string | null;
  price_sat: number | null;
  amount_sat: number | null;
  speed_limit_ph: number | null;
  last_price_decrease_at: number | null;
  abandoned: Generated<0 | 1>;
  /**
   * Latest snapshot of `amount_sat - amount_remaining_sat` from
   * Braiins. Updated every observe() while the bid is reachable;
   * frozen once the bid leaves /spot/bid/current. Sum across all rows
   * = lifetime spend (used by the finance panel).
   */
  amount_consumed_sat: Generated<number>;
}

// ---------------------------------------------------------------------------
// deferred_actions
// ---------------------------------------------------------------------------

export type DeferredActionStatus =
  | 'QUEUED'
  | 'IN_FLIGHT'
  | 'CONFIRMED'
  | 'TIMED_OUT'
  | 'REEVALUATED';

export interface DeferredActionsTable {
  id: Generated<number>;
  proposed_at: number;
  action_type: string;
  payload_json: string;
  status: DeferredActionStatus;
  resolved_at: number | null;
}

// ---------------------------------------------------------------------------
// decisions (append-only tick log)
// ---------------------------------------------------------------------------

export interface DecisionsTable {
  id: Generated<number>;
  tick_at: number;
  observed_json: string;
  proposed_json: string;
  gated_json: string;
  executed_json: string;
  run_mode: RunMode;
  action_mode: ActionMode;
}

// ---------------------------------------------------------------------------
// accounting
// ---------------------------------------------------------------------------

export interface SpendEventsTable {
  id: Generated<number>;
  bid_id: string;
  recorded_at: number;
  amount_consumed_sat: number;
  fee_paid_sat: number;
  shares_purchased_m: number | null;
  shares_accepted_m: number | null;
  shares_rejected_m: number | null;
}

export interface RewardEventsTable {
  id: Generated<number>;
  txid: string;
  vout: number;
  block_height: number;
  confirmations: number;
  value_sat: number;
  detected_at: number;
  reorged: Generated<0 | 1>;
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'INFO' | 'WARN' | 'LOUD';
export type AlertStatus = 'BUFFERED' | 'SENT' | 'FAILED';

export interface AlertsTable {
  id: Generated<number>;
  created_at: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  status: AlertStatus;
  sent_at: number | null;
  telegram_message_id: string | null;
}

// ---------------------------------------------------------------------------
// cache tables
// ---------------------------------------------------------------------------

export interface MarketSettingsCacheTable {
  id: 1;
  payload_json: string;
  cached_at: number;
}

export interface FeeScheduleCacheTable {
  id: 1;
  payload_json: string;
  cached_at: number;
}

// ---------------------------------------------------------------------------
// bid_events (append-only log of executed CREATE/EDIT/CANCEL events)
// ---------------------------------------------------------------------------

export type BidEventSource = 'AUTOPILOT' | 'OPERATOR';
export type BidEventKind = 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';

export interface BidEventsTable {
  id: Generated<number>;
  occurred_at: number;
  source: BidEventSource;
  kind: BidEventKind;
  braiins_order_id: string | null;
  old_price_sat: number | null;
  new_price_sat: number | null;
  speed_limit_ph: number | null;
  amount_sat: number | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// tick_metrics (time series for the hashrate chart)
// ---------------------------------------------------------------------------

export interface TickMetricsTable {
  id: Generated<number>;
  tick_at: number;
  delivered_ph: number;
  target_ph: number;
  floor_ph: number;
  owned_bid_count: number;
  unknown_bid_count: number;
  our_primary_price_sat_per_eh_day: number | null;
  best_bid_sat_per_eh_day: number | null;
  best_ask_sat_per_eh_day: number | null;
  fillable_ask_sat_per_eh_day: number | null;
  hashprice_sat_per_eh_day: number | null;
  max_bid_sat_per_eh_day: number | null;
  available_balance_sat: number | null;
  datum_hashrate_ph: number | null;
  ocean_hashrate_ph: number | null;
  spend_sat: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick,
   * in sat. Per-tick deltas give the authoritative actual spend from
   * Braiins (independent of our pay-your-bid `spend_sat` model) — see
   * migration 0041. Null when there was no primary owned bid at this
   * tick, or for pre-0041 rows.
   */
  primary_bid_consumed_sat: number | null;
  run_mode: RunMode;
  action_mode: ActionMode;
}

// ---------------------------------------------------------------------------
// internal: migrations bookkeeping
// ---------------------------------------------------------------------------

export interface MigrationsTable {
  id: Generated<number>;
  name: string;
  applied_at: number;
}

// ---------------------------------------------------------------------------
// closed_bids_cache — persistent sum cache for AccountSpendService.
// Terminal (CANCELED / FULFILLED) Braiins bids' consumed counter is
// immutable, so we store the amount once and never re-fetch it.
// Active bids are NOT cached here — they're always re-read live.
// ---------------------------------------------------------------------------

export interface ClosedBidsCacheTable {
  braiins_order_id: string;
  amount_consumed_sat: number;
  first_seen_at: number;
  last_seen_at: number;
}

// ---------------------------------------------------------------------------
// Kysely database descriptor
// ---------------------------------------------------------------------------

export interface Database {
  config: ConfigTable;
  runtime_state: RuntimeStateTable;
  owned_bids: OwnedBidsTable;
  deferred_actions: DeferredActionsTable;
  decisions: DecisionsTable;
  spend_events: SpendEventsTable;
  reward_events: RewardEventsTable;
  alerts: AlertsTable;
  market_settings_cache: MarketSettingsCacheTable;
  fee_schedule_cache: FeeScheduleCacheTable;
  tick_metrics: TickMetricsTable;
  bid_events: BidEventsTable;
  closed_bids_cache: ClosedBidsCacheTable;
  _migrations: MigrationsTable;
}
