-- Per-tick spend in sats (issue #43). Enables the range-aware P&L
-- per-day panel - SUM(spend_sat) over the selected chart range gives
-- total sats spent in that window; divide by window-days to get the
-- daily rate without re-deriving from price × delivered_ph on the
-- dashboard side.
--
-- Definition: sat spent during this tick's ~1-minute interval =
-- price_sat_per_eh_day × delivered_ph / 1_440_000
-- (price is sat/EH/day → sat/PH/day is /1000; × delivered PH gives
-- sat/day; / 1440 converts daily rate to one-minute chunk; combined
-- divisor is 1_440_000).
--
-- Nullable so ticks without a primary price (no owned bid) record
-- NULL instead of 0 - keeps "nothing to spend" distinct from
-- "spent zero".
ALTER TABLE tick_metrics ADD COLUMN spend_sat REAL;

UPDATE tick_metrics
SET spend_sat = our_primary_price_sat_per_eh_day * delivered_ph / 1440000.0
WHERE our_primary_price_sat_per_eh_day IS NOT NULL
  AND delivered_ph IS NOT NULL;
