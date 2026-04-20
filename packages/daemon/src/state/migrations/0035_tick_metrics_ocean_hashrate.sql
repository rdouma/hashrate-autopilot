-- Per-tick record of the hashrate Ocean's API credits to the
-- operator's payout address (issue #36). Plotted as a third line
-- on the Hashrate chart alongside Braiins-delivered and
-- Datum-received so the gap between them is visible at a glance.
--
-- Sourced from GET /v1/user_hashrate/<address>?field=hashrate_300s
-- (5-minute window — responsive but not noisy). NULL when Ocean is
-- not configured or the poll failed. Stored in PH/s to match the
-- existing hashrate columns.

ALTER TABLE tick_metrics ADD COLUMN ocean_hashrate_ph REAL;
