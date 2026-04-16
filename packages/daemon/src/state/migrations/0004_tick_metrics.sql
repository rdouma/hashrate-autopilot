-- Per-tick time series for the Hashrate graph and later analytics.
-- One row per tick. Kept compact: ~1 row/minute at 60s cadence = ~525k
-- rows/year, trivial for SQLite.

CREATE TABLE tick_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL,
  delivered_ph REAL NOT NULL,
  target_ph REAL NOT NULL,
  floor_ph REAL NOT NULL,
  owned_bid_count INTEGER NOT NULL,
  unknown_bid_count INTEGER NOT NULL,
  our_primary_price_sat_per_eh_day INTEGER,
  best_bid_sat_per_eh_day INTEGER,
  best_ask_sat_per_eh_day INTEGER,
  available_balance_sat INTEGER,
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL
);

CREATE INDEX idx_tick_metrics_tick_at ON tick_metrics (tick_at);
