-- #149: solo-mining monitoring (Bitaxe / AxeOS units running ESP-Miner).
--
-- Adds the schema needed for the daemon to poll a manually-configured
-- list of solo-mining devices (Bitaxe / Nerdaxe / any ESP-Miner fork)
-- every tick, persist a rolling sample of their /api/system/info
-- responses, and surface the fleet on /status with a card + on the
-- charts via three new right-axis series.
--
-- Opt-in feature: `solo_mining_enabled` defaults to 0 so existing
-- operators see no behaviour change until they explicitly enable it
-- on Config -> Solo miners. With the toggle off the daemon does not
-- poll, the /status card is hidden, and the new chart right-axis
-- options are absent from their dropdowns.
--
-- Alert-threshold columns ship in this migration even though the
-- alert-evaluator hookup arrives in a follow-up commit. Doing both
-- in one migration keeps schema versioning straightforward; the
-- defaults take effect lazily when the alert paths land.

CREATE TABLE solo_miners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT    NOT NULL,
  ip          TEXT    NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One row per (device, tick) - the AxeOS API only exposes a live
-- snapshot, so we persist a rolling history ourselves for chart
-- back-fill + alert-evaluator delta computation. Pruned alongside
-- tick_metrics by the existing retention service (see below) so
-- a long-running fleet doesn't unbounded-grow this table.
CREATE TABLE solo_miner_samples (
  device_id              INTEGER NOT NULL REFERENCES solo_miners(id) ON DELETE CASCADE,
  tick_at                INTEGER NOT NULL,
  reachable              INTEGER NOT NULL,
  hashrate_1m_ghs        REAL,
  hashrate_10m_ghs       REAL,
  hashrate_1h_ghs        REAL,
  expected_hashrate_ghs  REAL,
  temp_c                 REAL,
  vr_temp_c              REAL,
  power_w                REAL,
  voltage_v              REAL,
  current_a              REAL,
  shares_accepted        INTEGER,
  shares_rejected        INTEGER,
  uptime_seconds         INTEGER,
  asic_model             TEXT,
  version                TEXT,
  stratum_url            TEXT,
  stratum_port           INTEGER,
  stratum_user           TEXT,
  PRIMARY KEY (device_id, tick_at)
);

CREATE INDEX solo_miner_samples_tick_idx ON solo_miner_samples(tick_at);

ALTER TABLE config
  ADD COLUMN solo_mining_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config
  ADD COLUMN solo_overheating_threshold_celsius INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config
  ADD COLUMN solo_zero_hashrate_alert_after_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE config
  ADD COLUMN solo_share_rejection_threshold_pct REAL NOT NULL DEFAULT 10.0;
ALTER TABLE config
  ADD COLUMN solo_share_rejection_window_minutes INTEGER NOT NULL DEFAULT 60;
-- 0 = "use per-ASIC-model lookup" (the default); a non-zero value is
-- a global operator override that wins for every device regardless
-- of model. Per-device overrides are explicitly out of scope for v1.
