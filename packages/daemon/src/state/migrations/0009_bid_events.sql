-- Append-only log of every executed bid event (CREATE/EDIT/CANCEL), whether
-- it came from the autopilot tick loop or an operator action from the
-- dashboard. Separate from `decisions` because the decisions log is per-tick
-- (a single row whether or not a bid event fired) and does not cover the
-- manual bump-price path, which bypasses the controller entirely. Markers
-- on the hashrate chart read from this table.

CREATE TABLE bid_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('AUTOPILOT', 'OPERATOR')),
  kind TEXT NOT NULL CHECK (kind IN ('CREATE_BID', 'EDIT_PRICE', 'CANCEL_BID')),
  braiins_order_id TEXT,
  old_price_sat INTEGER,
  new_price_sat INTEGER,
  speed_limit_ph REAL,
  amount_sat INTEGER,
  reason TEXT
);

CREATE INDEX idx_bid_events_occurred_at ON bid_events (occurred_at);
