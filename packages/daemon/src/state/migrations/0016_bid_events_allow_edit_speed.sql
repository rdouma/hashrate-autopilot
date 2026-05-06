-- Allow 'EDIT_SPEED' in bid_events.kind. The original CHECK constraint
-- predates the EDIT_SPEED proposal kind, so live inserts silently
-- failed (caught by the execute.ts try/catch -> warning only) and
-- the dashboard chart never got a marker for in-place speed edits.
-- SQLite can't modify a CHECK constraint in place - rebuild the
-- table the standard way.

CREATE TABLE bid_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('AUTOPILOT', 'OPERATOR')),
  kind TEXT NOT NULL CHECK (
    kind IN ('CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID')
  ),
  braiins_order_id TEXT,
  old_price_sat INTEGER,
  new_price_sat INTEGER,
  speed_limit_ph REAL,
  amount_sat INTEGER,
  reason TEXT
);

INSERT INTO bid_events_new
  (id, occurred_at, source, kind, braiins_order_id,
   old_price_sat, new_price_sat, speed_limit_ph, amount_sat, reason)
SELECT
  id, occurred_at, source, kind, braiins_order_id,
  old_price_sat, new_price_sat, speed_limit_ph, amount_sat, reason
FROM bid_events;

DROP TABLE bid_events;
ALTER TABLE bid_events_new RENAME TO bid_events;
CREATE INDEX idx_bid_events_occurred_at ON bid_events (occurred_at);
