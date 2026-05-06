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
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  quiet_hours_start: string;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  quiet_hours_end: string;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  quiet_hours_timezone: string;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
  confirmation_timeout_minutes: number;
  handover_window_minutes: number;
  btc_payout_address: string;
  /** @deprecated Legacy column — kept for NOT NULL; ignored by the app. */
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
  overpay_sat_per_eh_day: number;
  block_explorer_url_template: string;
  braiins_hashrate_smoothing_minutes: number;
  datum_hashrate_smoothing_minutes: number;
  braiins_price_smoothing_minutes: number;
  show_effective_rate_on_price_chart: 0 | 1;
  show_share_log_on_hashrate_chart: 0 | 1;
  /** #88: 'off' | one of four bundled MP3 names | 'custom'. */
  block_found_sound: string;
  /** Custom-uploaded MP3 bytes; written via POST /api/config/block-found-sound. Capped at ~200 KB. */
  block_found_sound_custom_blob: Buffer | null;
  /** MIME type of the custom blob (sniffed at upload). */
  block_found_sound_custom_mime: string | null;
  /** #88: original filename of the uploaded custom blob, for the Config UI's "currently: X" display. */
  block_found_sound_custom_filename: string | null;
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
  /**
   * Ocean `share_log` percentage at this tick (e.g. 0.0182 for
   * 0.0182%). Derived from Ocean's `/statsnap.shares_in_tides ÷
   * pool_stat.current_tides_shares × 100`, sampled from the same
   * cached fetch that supplies `hashprice_sat_per_eh_day`. Display-only
   * — opt-in fourth series on the Hashrate chart via the
   * `show_share_log_on_hashrate_chart` config toggle. Null when Ocean
   * isn't configured, the poll failed, or for ticks predating
   * migration 0048.
   */
  share_log_pct: number | null;
  spend_sat: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick,
   * in sat. Per-tick deltas give the authoritative actual spend from
   * Braiins (independent of our pay-your-bid `spend_sat` model) — see
   * migration 0041. Null when there was no primary owned bid at this
   * tick, or for pre-0041 rows.
   */
  primary_bid_consumed_sat: number | null;
  // #89: extended capture from existing data sources.
  /** Network difficulty at tick (Ocean /pool_stat). */
  network_difficulty: number | null;
  /** Current block reward incl. fees, sat (Ocean /pool_stat). */
  estimated_block_reward_sat: number | null;
  /** Ocean's total pool hashrate in PH/s at tick. */
  pool_hashrate_ph: number | null;
  /** Ocean's active worker count at tick. */
  pool_active_workers: number | null;
  /** Braiins lifetime deposits, sat. Spike marks a top-up. */
  braiins_total_deposited_sat: number | null;
  /** Braiins lifetime settled spend, sat. */
  braiins_total_spent_sat: number | null;
  /** Ocean unpaid earnings at tick, sat. Sharp drop = TIDES payout. */
  ocean_unpaid_sat: number | null;
  /** BTC/USD oracle reading at tick, $. */
  btc_usd_price: number | null;
  /** Which oracle the reading came from ('coingecko' / 'coinbase' / etc), null when no reading. */
  btc_usd_price_source: string | null;
  /** Primary owned bid's last_pause_reason (Braiins). */
  primary_bid_last_pause_reason: string | null;
  /** Primary owned bid's cumulative fees paid, sat. */
  primary_bid_fee_paid_sat: number | null;
  /** Primary owned bid's fee rate at creation, percent. */
  primary_bid_fee_rate_pct: number | null;
  /** #92: pool blocks observed in the last 24h at tick time. */
  pool_blocks_24h_count: number | null;
  /** #92: pool blocks observed in the last 7d at tick time. */
  pool_blocks_7d_count: number | null;
  /**
   * Trailing 24h mean of `pool_hashrate_ph` ending at this tick.
   * Used as the denominator of the 24h luck multiplier so the
   * window of the numerator (block count over 24h) matches the
   * window of the denominator. Null on rows older than migration
   * 0056 and on ticks where the trailing window has no samples.
   */
  pool_hashrate_ph_avg_24h: number | null;
  /**
   * Trailing 7d mean of `pool_hashrate_ph` ending at this tick.
   * Same role as the 24h average but for the 7d luck multiplier.
   */
  pool_hashrate_ph_avg_7d: number | null;
  /**
   * Per-tick pool luck values (gap-based).
   * `luck = (600 / pool_share) / (tick_at - last_pool_block_time_in_window)`
   * where `pool_share = pool_hashrate_avg / network_hashrate`. Decays
   * continuously between finds, jumps on each find. 24h variant uses
   * the 24h trailing window for "most recent block"; 7d variant looks
   * back 7d. Null when any input is unavailable.
   */
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
  /**
   * #90: per-tick bid acceptance counters from Braiins's
   * `/spot/bid/delivery/{order_id}`. Cumulative shares (in millions)
   * snapshotted at this tick for the primary owned bid. Per-tick
   * deltas drive the dashboard's 1h-rolling acceptance ratio stat
   * card. Null on ticks where the bid did not exist yet, the call
   * failed, or there was no primary owned bid.
   */
  primary_bid_shares_purchased_m: number | null;
  primary_bid_shares_accepted_m: number | null;
  primary_bid_shares_rejected_m: number | null;
  /**
   * #91 — Datum gateway-side rejected-shares counter, opportunistically
   * scraped from `/umbrel-api` if the operator's build exposes it.
   * Cumulative count. Null on every tick when DATUM does not expose
   * the tile (the common case as of May 2026).
   */
  datum_rejected_shares_total: number | null;
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

// ---------------------------------------------------------------------------
// secrets — single-row table mirroring SecretsSchema, populated by the
// first-run web wizard (#57) so appliance installs that can't carry a
// SOPS-encrypted file have a persistent home for token + password.
// ---------------------------------------------------------------------------

export interface SecretsTable {
  id: Generated<number>;
  braiins_owner_token: string;
  braiins_read_only_token: string | null;
  dashboard_password: string;
  bitcoind_rpc_url: string | null;
  bitcoind_rpc_user: string | null;
  bitcoind_rpc_password: string | null;
  telegram_bot_token: string | null;
  telegram_webhook_secret: string | null;
  updated_at: number;
}

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
  secrets: SecretsTable;
  block_version_cache: BlockVersionCacheTable;
  _migrations: MigrationsTable;
}

/**
 * #94: persistent cache of block-header version values keyed by
 * block hash. Read by `/api/ocean` to mark BIP-110-signaling blocks
 * with a crown on the chart. Block headers are immutable so the
 * cache never needs invalidation; old rows just sit harmlessly.
 */
export interface BlockVersionCacheTable {
  block_hash: string;
  block_version: number;
  fetched_at: number;
}
