-- Initial schema for the Braiins Hashrate autopilot.
-- Mirrors architecture §5. Applied exactly once; future changes go in
-- 0002_*.sql and later migration files.

-- Live-editable configuration (single-row pattern).
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_hashrate_ph REAL NOT NULL,
  minimum_floor_hashrate_ph REAL NOT NULL,
  destination_pool_url TEXT NOT NULL,
  destination_pool_worker_name TEXT NOT NULL,
  max_price_sat_per_eh_day INTEGER NOT NULL,
  emergency_max_price_sat_per_eh_day INTEGER NOT NULL,
  monthly_budget_ceiling_sat INTEGER NOT NULL,
  bid_budget_sat INTEGER NOT NULL,
  wallet_runway_alert_days INTEGER NOT NULL,
  below_floor_alert_after_minutes INTEGER NOT NULL,
  below_floor_emergency_cap_after_minutes INTEGER NOT NULL,
  zero_hashrate_loud_alert_after_minutes INTEGER NOT NULL,
  pool_outage_blip_tolerance_seconds INTEGER NOT NULL,
  api_outage_alert_after_minutes INTEGER NOT NULL,
  quiet_hours_start TEXT NOT NULL,
  quiet_hours_end TEXT NOT NULL,
  quiet_hours_timezone TEXT NOT NULL,
  confirmation_timeout_minutes INTEGER NOT NULL,
  handover_window_minutes INTEGER NOT NULL,
  btc_payout_address TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Persistent runtime state (single-row pattern). run_mode is reset to
-- DRY_RUN on every startup per SPEC §7.1 - this table stores the
-- last-known values for crash recovery / dashboard.
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL,
  operator_available INTEGER NOT NULL,
  last_tick_at INTEGER,
  last_api_ok_at INTEGER,
  last_rpc_ok_at INTEGER,
  last_pool_ok_at INTEGER
);

-- Ownership ledger (§5): which Braiins order IDs we created.
CREATE TABLE owned_bids (
  braiins_order_id TEXT PRIMARY KEY,
  cl_order_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  first_seen_active_at INTEGER,
  last_known_status TEXT,
  price_sat INTEGER,
  amount_sat INTEGER,
  speed_limit_ph REAL,
  last_price_decrease_at INTEGER,
  abandoned INTEGER NOT NULL DEFAULT 0
);

-- Deferred decisions (quiet hours / pending-confirmation queue).
CREATE TABLE deferred_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_at INTEGER NOT NULL,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved_at INTEGER
);

-- Decision log: one row per tick, feeds the dashboard "Decisions" page.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL,
  observed_json TEXT NOT NULL,
  proposed_json TEXT NOT NULL,
  gated_json TEXT NOT NULL,
  executed_json TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL
);

-- Accounting: spend (sourced from Braiins).
CREATE TABLE spend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  amount_consumed_sat INTEGER NOT NULL,
  fee_paid_sat INTEGER NOT NULL,
  shares_purchased_m REAL,
  shares_accepted_m REAL,
  shares_rejected_m REAL
);

-- Accounting: income (sourced from bitcoind payouts).
CREATE TABLE reward_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  value_sat INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  reorged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (txid, vout)
);

-- Alerts (sent + buffered during quiet hours).
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at INTEGER,
  telegram_message_id TEXT
);

-- Cached market settings / fee schedule (refresh every N ticks).
CREATE TABLE market_settings_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

CREATE TABLE fee_schedule_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

-- Indexes on the lookups we know we'll do.
CREATE INDEX idx_decisions_tick_at        ON decisions (tick_at);
CREATE INDEX idx_alerts_created_at        ON alerts (created_at);
CREATE INDEX idx_alerts_status            ON alerts (status);
CREATE INDEX idx_deferred_actions_status  ON deferred_actions (status);
CREATE INDEX idx_spend_events_recorded_at ON spend_events (recorded_at);
CREATE INDEX idx_reward_events_detected_at ON reward_events (detected_at);
CREATE INDEX idx_owned_bids_last_status   ON owned_bids (last_known_status);
