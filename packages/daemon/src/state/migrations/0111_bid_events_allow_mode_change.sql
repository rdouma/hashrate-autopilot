-- #287: allow 'MODE_CHANGE' (run-mode switches), 'BID_PAUSED' and
-- 'BID_RESUMED' (Braiins-side bid status transitions, observed per
-- tick) in bid_events.kind so all three appear on the History page. Same
-- rebuild-the-table dance as 0016 (SQLite can't modify a CHECK
-- constraint in place). Schema must match the LIVE table shape,
-- which includes the two #120 overpay-snapshot columns added by 0077
-- after the original CREATE.

CREATE TABLE bid_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('AUTOPILOT', 'OPERATOR')),
  kind TEXT NOT NULL CHECK (
    kind IN ('CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID', 'MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED')
  ),
  braiins_order_id TEXT,
  old_price_sat INTEGER,
  new_price_sat INTEGER,
  speed_limit_ph REAL,
  amount_sat INTEGER,
  reason TEXT,
  overpay_sat_per_eh_day INTEGER,
  max_overpay_vs_hashprice_sat_per_eh_day INTEGER
);

INSERT INTO bid_events_new
  (id, occurred_at, source, kind, braiins_order_id,
   old_price_sat, new_price_sat, speed_limit_ph, amount_sat, reason,
   overpay_sat_per_eh_day, max_overpay_vs_hashprice_sat_per_eh_day)
SELECT
  id, occurred_at, source, kind, braiins_order_id,
  old_price_sat, new_price_sat, speed_limit_ph, amount_sat, reason,
  overpay_sat_per_eh_day, max_overpay_vs_hashprice_sat_per_eh_day
FROM bid_events;

DROP TABLE bid_events;
ALTER TABLE bid_events_new RENAME TO bid_events;
CREATE INDEX idx_bid_events_occurred_at ON bid_events (occurred_at);
