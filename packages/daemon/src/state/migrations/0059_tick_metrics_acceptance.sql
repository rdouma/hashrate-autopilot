-- #90: per-tick bid-acceptance counters from Braiins's
-- `/spot/bid/delivery/{order_id}` endpoint. Three nullable REALs
-- because Braiins reports them in millions ("_m" suffix on the
-- columns). Null on ticks where the call failed, the bid did not
-- exist yet, or there was no primary owned bid (e.g. between cancel
-- and re-create).
--
-- Acceptance ratio = shares_accepted_m / shares_purchased_m. Healthy
-- baseline is ~0.9995 (the 0.05% pool-side rejection rate is normal
-- noise per docs/research.md §7.5). A sustained drop below ~99% is
-- the signature of a real problem (Datum stale work, worker-identity
-- misconfiguration, pool difficulty too low). The dashboard renders
-- a 1h-rolling acceptance % stat card and fires an alert when it
-- crosses below 98%.

ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_purchased_m REAL;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_accepted_m REAL;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_rejected_m REAL;
