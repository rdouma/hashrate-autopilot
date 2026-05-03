-- #92 (follow-up): persist pool block counts per tick so the
-- pool-luck multiplier (observed / Poisson-expected) can be plotted
-- as a historical series on the Hashrate chart's right axis.
--
-- Counts are the raw observation; the luck calc happens at chart
-- render time using these counts plus the existing
-- network_difficulty + pool_hashrate_ph columns. Storing the input
-- (rather than the derived luck) leaves room to retune the formula
-- later (different reference window, etc.) without backfilling.

ALTER TABLE tick_metrics ADD COLUMN pool_blocks_24h_count INTEGER;
ALTER TABLE tick_metrics ADD COLUMN pool_blocks_7d_count INTEGER;
