-- #91: Datum gateway-side rejected-shares counter, captured per
-- tick. Cumulative (not delta) — the dashboard computes deltas on
-- read for the Datum panel's "rejects (1h)" row.
--
-- Heuristic detection: the daemon's DATUM poller scans
-- `/umbrel-api`'s `items[]` for any tile whose title matches
-- /reject/i and parses the numeric portion of `text`. Most DATUM
-- builds in May 2026 do NOT expose a reject tile, in which case
-- this column stays null on every tick and the dashboard surface
-- silently no-ops. The column is in place so the moment DATUM
-- starts exposing the counter, the daemon picks it up without a
-- code change.

ALTER TABLE tick_metrics ADD COLUMN datum_rejected_shares_total INTEGER;
