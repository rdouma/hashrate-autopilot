-- Client-side chart smoothing windows (issue #42). Applied by the
-- dashboard's HashrateChart to the Braiins-delivered and Datum-received
-- series so their jitter can be dampened to match Ocean's built-in
-- 5-min server-side average. 1 = no smoothing (pass raw values through).
--
-- Not read by the daemon control loop — pure display config.
ALTER TABLE config ADD COLUMN braiins_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1;
ALTER TABLE config ADD COLUMN datum_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1;
