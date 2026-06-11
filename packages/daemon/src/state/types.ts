/**
 * Kysely table row types for the SQLite schema in migrations/0001_initial.sql.
 *
 * These types drive compile-time checks on every query. Keep them in sync
 * when adding migrations. Generated<T> marks auto-populated columns (PK
 * autoincrement, defaults) so inserts don't require them.
 */

import type { Generated } from 'kysely';

import type { ActionMode, RunMode } from '@hashrate-autopilot/shared';

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
  /** @deprecated Legacy column - kept for NOT NULL; ignored by the app. */
  emergency_max_bid_sat_per_eh_day: number;
  bid_budget_sat: number;
  wallet_runway_alert_days: number;
  below_floor_alert_after_minutes: number;
  /** @deprecated Legacy column - kept for NOT NULL; ignored by the app. */
  below_floor_emergency_cap_after_minutes: number;
  zero_hashrate_loud_alert_after_minutes: number;
  pool_outage_blip_tolerance_seconds: number;
  /** #135: dedicated minute threshold for the datum_unreachable alert (was pool_outage_blip_tolerance_seconds × 5). */
  datum_unreachable_alert_after_minutes: number;
  /** #135: dedicated minute threshold for the sustained_paused alert (was pool_outage_blip_tolerance_seconds × 5). */
  sustained_paused_alert_after_minutes: number;
  api_outage_alert_after_minutes: number;
  handover_window_minutes: number;
  btc_payout_address: string;
  /** #100: Telegram chat id the notifier POSTs into. Empty string = unconfigured. */
  telegram_chat_id: string;
  /** #100: live-editable Telegram bot token. Mirrors the secrets fallback for bitcoind RPC creds. */
  telegram_bot_token: string;
  /** Optional per-instance source label; when non-empty, the TelegramSink prefixes messages with `[<label>] `. */
  telegram_instance_label: string;
  /** #100: global mute toggle for the Telegram notifier. */
  notifications_muted: 0 | 1;
  /** #100: cadence between retry attempts when state stays bad. Default 30. */
  notification_retry_interval_minutes: number;
  /** #106: comma-separated event_class names the operator has opted out of. */
  notification_disabled_event_classes: string;
  /** #117: opt-in INFO message at every Ocean pool-block credit (TIDES). Off by default. */
  notify_on_pool_block_credit: 0 | 1;
  /** #130: opt-in messages on Braiins deposit lifecycle (Detected / Available / Returned). Off by default. */
  notify_on_braiins_deposit: 0 | 1;
  /** #226: opt-in INFO message when Ocean debits unpaid_sat (payout committed to next coinbase). Off by default. */
  notify_on_payout_initiated: 0 | 1;
  /** #226: opt-in INFO message when an on-chain coinbase to the payout address confirms. Off by default. */
  notify_on_payout_confirmed: 0 | 1;
  /** #131: locale for Telegram message rendering. 'en' (default) | 'nl' | 'es'. */
  notification_locale: string;
  /** #227 follow-up: number-format preference (mirrors dashboard's `braiins.numberLocale`). Default 'system'. */
  display_number_locale: string;
  /** #227 follow-up: date-layout preference (mirrors dashboard's `braiins.dateLayout`). Default 'system'. */
  display_date_layout: string;
  /** #238: per-series chart color overrides as a JSON string. Empty `{}` means defaults. */
  chart_color_overrides: string;
  /** #266: StatsBar tile order/selection as a JSON string array of catalogue ids. Empty `[]` means defaults. */
  dashboard_tiles: string;
  /** #244: dashboard block order as a JSON string array of block IDs. Empty `[]` means default order. */
  dashboard_card_order: string;
  /** @deprecated Legacy column - kept for NOT NULL; ignored by the app. */
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
  alerts_retention_days: number;
  chart_max_markers: number;
  datum_api_url: string | null;
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
  overpay_sat_per_eh_day: number;
  /** #222: EDIT_PRICE deadband as a percentage of overpay. Default 20 = legacy `overpay/5`. */
  bid_edit_deadband_pct: number;
  /** #222: operator-acceptable max Braiins fee_rate_pct before mutation gate halts CREATE/EDIT. Default 0. */
  max_acceptable_fee_pct: number;
  block_explorer_url_template: string;
  /** Transaction counterpart to block_explorer_url_template; supports `{txid}` / `{hash}` placeholders. */
  block_explorer_tx_url_template: string;
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
  /** #111: DDNS updater - provider name (e.g. 'noip') or empty string to disable. */
  ddns_provider: string;
  /** #111: DDNS hostname being maintained (e.g. 'myrig.duckdns.org' for DuckDNS, or 'all.ddnskey.com' when using a No-IP DDNS Key group). */
  ddns_hostname: string;
  /** #111: DDNS provider username (or No-IP DDNS Key username). */
  ddns_username: string;
  /** #111: DDNS provider credential (password / DDNS Key credential / token). */
  ddns_credential: string;
  /** #111: dyndns2 update endpoint URL (only used when provider = 'dyndns2'). */
  ddns_update_url: string;
  /** #149: master toggle for solo-mining monitoring (Bitaxe / AxeOS). 0 = feature dormant (no polling, hidden UI surface). */
  solo_mining_enabled: 0 | 1;
  /** #149: global override for the overheating ceiling. 0 = use per-ASIC-model lookup; non-zero = override wins for every device. */
  solo_overheating_threshold_celsius: number;
  /** #149: zero-hashrate / unreachable alert threshold (consecutive bad minutes). */
  solo_zero_hashrate_alert_after_minutes: number;
  /** #149: share-rejection alert threshold (%). */
  solo_share_rejection_threshold_pct: number;
  /** #149: rolling window in minutes over which share-rejection rate is computed. */
  solo_share_rejection_window_minutes: number;
  /** #167: marketplace_empty alert threshold (consecutive minutes the orderbook is empty for our target AND delivery is ~0). */
  marketplace_empty_alert_after_minutes: number;
  /** #170: when 1 (default), payout-observer's electrs path backfills ALL historical coinbase receipts at btc_payout_address into reward_events; when 0, only currently-unspent outputs are counted. */
  include_historical_payouts: 0 | 1;
  /** #170 follow-up: operator-entered offset for pre-installation / off-chain earnings; added to lifetime-earnings chart and net P&L. Always >= 0. */
  historical_payouts_offset_sat: number;
  /** #179: opt-in diagnostics endpoint toggle. */
  debug_api_enabled: 0 | 1;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// runtime_state (single-row pattern)
// ---------------------------------------------------------------------------

export interface RuntimeStateTable {
  id: 1;
  run_mode: RunMode;
  action_mode: ActionMode;
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
  /** #204: fleet-wide all-time best difficulty high-water mark. */
  solo_best_difficulty_all_time: number | null;
  /**
   * #240 follow-up: the `btc_payout_address` value that was last
   * processed through `runHistoricalBackfill`. Compared against
   * `cfg.btc_payout_address` on boot; mismatch triggers a
   * `DELETE FROM reward_events` + re-backfill so the operator
   * doesn't end up with stale old-address payout history after
   * changing the address mid-run. Null = never backfilled (fresh
   * install or pre-migration-0105).
   */
  last_backfilled_payout_address: string | null;
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
  /**
   * #113: stratum URL the bid was created with. Used by the
   * stale-URL banner to flag bids whose dest_upstream drifts from
   * current config (Braiins's API does not allow editing dest_upstream
   * post-creation, so only cancel-and-recreate fixes a mismatch).
   * Nullable - legacy rows from before the column landed have no value.
   */
  dest_url: string | null;
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

// #250: append-only log of public-IP rotations (old -> new). old_ip is
// nullable for defensiveness, though the detection hook only fires on a
// non-null -> different-non-null change so it is populated in practice.
export interface IpChangeEventsTable {
  id: Generated<number>;
  occurred_at: number;
  old_ip: string | null;
  new_ip: string;
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export type AlertSeverity = 'INFO' | 'WARNING' | 'IMPORTANT';
export type AlertStatus = 'BUFFERED' | 'SENT' | 'FAILED';
/** #100: per-alert delivery state, channel-agnostic. */
export type AlertDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'muted'
  | 'gave_up';

export interface AlertsTable {
  id: Generated<number>;
  created_at: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  status: AlertStatus;
  sent_at: number | null;
  /** #100: which event class triggered this alert (e.g. 'datum_unreachable'). Null on rows pre-0062. */
  event_class: string | null;
  /** #100: pending | sent | failed | muted | gave_up. */
  delivery_status: AlertDeliveryStatus;
  /** #100: how many times the notifier has tried to POST this alert. */
  delivery_attempts: number;
  /** #100: ms-epoch of the last delivery attempt. Null if never attempted. */
  last_attempt_at_ms: number | null;
  /** #100: ms-epoch when the next retry is scheduled. Null = no retry due. */
  next_retry_at_ms: number | null;
  /** #100: FK back to the alert this row recovers from. Null on the original alert. */
  paired_alert_id: number | null;
  /** #100: JSON payload with channel-specific identifiers (Telegram message_id, etc). */
  delivery_meta_json: string | null;
  /** #100: ms-epoch when the operator clicked acknowledge. Null = unacknowledged. */
  acknowledged_at_ms: number | null;
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
export type BidEventKind = 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID' | 'MODE_CHANGE' | 'BID_PAUSED' | 'BID_RESUMED';

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
  /** #120: overpay-above-fillable in effect at the moment of the event. */
  overpay_sat_per_eh_day: number | null;
  /** #120: hashprice-relative cap in effect at the moment of the event. */
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
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
  total_balance_sat: number | null;
  datum_hashrate_ph: number | null;
  ocean_hashrate_ph: number | null;
  /**
   * Ocean `share_log` percentage at this tick (e.g. 0.0182 for
   * 0.0182%). Derived from Ocean's `/statsnap.shares_in_tides ÷
   * pool_stat.current_tides_shares × 100`, sampled from the same
   * cached fetch that supplies `hashprice_sat_per_eh_day`. Display-only
   * - opt-in fourth series on the Hashrate chart via the
   * `show_share_log_on_hashrate_chart` config toggle. Null when Ocean
   * isn't configured, the poll failed, or for ticks predating
   * migration 0048.
   */
  share_log_pct: number | null;
  spend_sat: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick,
   * in sat. Per-tick deltas give the authoritative actual spend from
   * Braiins (independent of our pay-your-bid `spend_sat` model) - see
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
  /** #102: cumulative on-chain payout total at tick, sat. Monotonically
   * non-decreasing (sum of reward_events.value_sat, reorged=0, detected_at <= tick_at).
   * Pair with ocean_unpaid_sat for the lifetime-earnings derivation. */
  paid_total_sat: number | null;
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
  /**
   * #224 (#222): config.bid_edit_deadband_pct at this tick. Snapshot,
   * not derived - the operator can change this knob mid-run, so the
   * tooltip on a historical EDIT_PRICE event needs to know which
   * value was in effect. Migration 0100 backfills 20 (the legacy
   * hard-coded `/5` default) so historical rows render the right
   * number.
   */
  bid_edit_deadband_pct: number;
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
  pool_luck_30d: number | null;
  pool_blocks_30d_count: number | null;
  pool_hashrate_ph_avg_30d: number | null;
  /** #173: 1 = Braiins API was reachable this tick, 0 = unreachable.
   * NULL for rows predating migration 0091. */
  braiins_reachable: number | null;
  /**
   * #243: per-tick cumulative-since-bid-creation share counters
   * snapshotted from the primary owned bid's
   * `counters_committed.shares_*_m` (Braiins `/spot/bid/detail`).
   * Stored cumulative; the chart + Braiins card derive the
   * instantaneous rejection rate from per-tick deltas (rejected_m
   * delta / purchased_m delta * 100). NULL on a tick where
   * `getBidDetail` failed or there was no primary owned bid.
   */
  primary_bid_shares_purchased_m: number | null;
  primary_bid_shares_accepted_m: number | null;
  primary_bid_shares_rejected_m: number | null;
  run_mode: RunMode;
  action_mode: ActionMode;
  /**
   * #241: 1 = synthetic row inserted by `runGapBackfill` to fill an
   * offline gap (per-tick fill at 5-min cadence when bitcoindClient
   * is wired so each tick carries the correct epoch difficulty; one
   * tick at the latest retarget's nearest-pool-block estimate as a
   * pre-bitcoind fallback). 0 = real polled row. Gap-detection
   * queries filter `synthetic = 0` so a previous run's wrong-time
   * synthetic doesn't poison the "previous tick" lookup and block
   * re-correction on the next boot. Added by migration 0104; rows
   * predating it carry the default 0.
   */
  synthetic: Generated<number>;
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
// closed_bids_cache - persistent sum cache for AccountSpendService.
// Terminal (CANCELED / FULFILLED) Braiins bids' consumed counter is
// immutable, so we store the amount once and never re-fetch it.
// Active bids are NOT cached here - they're always re-read live.
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
// secrets - single-row table mirroring SecretsSchema, populated by the
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
  updated_at: number;
}

/** #108: persisted Ocean pool blocks. See migration 0065. */
export interface PoolBlocksTable {
  height: number;
  block_hash: string;
  timestamp_ms: number;
  total_reward_sat: number;
  subsidy_sat: number;
  fees_sat: number;
  worker: string | null;
  username: string | null;
  observed_at_ms: number;
}

/**
 * #130: Braiins on-chain deposit watcher state. One row per deposit
 * tx ever observed; idempotency flags prevent re-firing the same
 * lifecycle alert on every poll.
 */
export interface BraiinsDepositsTable {
  tx_id: string;
  amount_sat: number;
  address: string | null;
  last_seen_status: number;
  last_seen_return_tx_id: string | null;
  first_seen_at_ms: number;
  updated_at_ms: number;
  tx_timestamp_ms: number | null;
  credited_at_ms: number | null;
  notified_detected: 0 | 1;
  notified_available: 0 | 1;
  notified_returned: 0 | 1;
}

/**
 * #149: operator-managed list of solo-mining devices (Bitaxe /
 * Nerdaxe / any ESP-Miner fork). The daemon polls each enabled
 * device's `/api/system/info` every tick when the
 * `config.solo_mining_enabled` master toggle is on.
 */
export interface SoloMinersTable {
  id: Generated<number>;
  label: string;
  ip: string;
  enabled: Generated<0 | 1>;
  sort_order: Generated<number>;
  created_at: number;
  updated_at: number;
}

/**
 * #149: one row per (device, tick). AxeOS's API only exposes a live
 * snapshot, so the daemon persists a rolling history itself for
 * chart back-fill + alert delta computation. Pruned via the same
 * retention service that purges `tick_metrics`.
 */
export interface SoloMinerSamplesTable {
  device_id: number;
  tick_at: number;
  /** 1 = HTTP succeeded; 0 = timeout / refused / non-2xx. All other columns may be null when 0. */
  reachable: 0 | 1;
  /** AxeOS `hashRate` (instantaneous, no window). Fallback when the windowed fields are absent on older firmware. */
  hashrate_instant_ghs: number | null;
  hashrate_1m_ghs: number | null;
  hashrate_10m_ghs: number | null;
  hashrate_1h_ghs: number | null;
  expected_hashrate_ghs: number | null;
  temp_c: number | null;
  vr_temp_c: number | null;
  power_w: number | null;
  voltage_v: number | null;
  current_a: number | null;
  shares_accepted: number | null;
  shares_rejected: number | null;
  uptime_seconds: number | null;
  asic_model: string | null;
  version: string | null;
  stratum_url: string | null;
  stratum_port: number | null;
  stratum_user: string | null;
  /** AxeOS `bestDiff` - lifetime best share difficulty for this device (magnitude-suffixed string e.g. "149.53G"). */
  best_diff_text: string | null;
  /** AxeOS `bestSessionDiff` - best share difficulty since current boot. */
  best_session_diff_text: string | null;
  /** #204: parsed numeric value of best_diff_text for aggregation queries. */
  best_diff_numeric: number | null;
}

/** #204: record-breaking best difficulty events for solo miners. */
export interface SoloBestDifficultyEventsTable {
  id: Generated<number>;
  recorded_at: number;
  difficulty: number;
  previous_difficulty: number | null;
  device_label: string;
  device_ip: string;
}

export interface Database {
  config: ConfigTable;
  pool_blocks: PoolBlocksTable;
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
  braiins_deposits: BraiinsDepositsTable;
  solo_miners: SoloMinersTable;
  solo_miner_samples: SoloMinerSamplesTable;
  solo_best_difficulty_events: SoloBestDifficultyEventsTable;
  ip_change_events: IpChangeEventsTable;
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
