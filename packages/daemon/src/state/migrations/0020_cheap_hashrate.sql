-- Opportunistic hashrate scaling: when the market is cheap vs hashprice,
-- scale up to cheap_target_hashrate_ph instead of the normal target.
-- Default 0 = disabled; feature activates when both values are non-zero.
ALTER TABLE config ADD COLUMN cheap_target_hashrate_ph REAL NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN cheap_threshold_pct INTEGER NOT NULL DEFAULT 0;
