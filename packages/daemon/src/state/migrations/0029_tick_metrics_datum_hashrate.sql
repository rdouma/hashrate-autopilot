-- Per-tick hashrate reported by Datum Gateway (in PH/s), null when
-- the Datum integration is disabled or the poll failed. Stored so
-- the operator can compare Datum's perspective against Braiins over
-- time in a later chart iteration (issue #19).

ALTER TABLE tick_metrics ADD COLUMN datum_hashrate_ph REAL;
