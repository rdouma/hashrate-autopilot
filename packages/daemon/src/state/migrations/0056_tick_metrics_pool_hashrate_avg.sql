-- Pool luck (24h/7d) was using the *current tick's* pool_hashrate_ph
-- as the denominator of its Poisson expectation, while the numerator
-- was a trailing 7d (or 24h) block count. That snapshot-vs-trailing
-- mismatch made luck swing 15-20% over a few hours when Ocean's pool
-- hashrate drifted (farms cycling, shift changes) - which the
-- operator's intuition correctly flagged as "shouldn't a 7d window be
-- nearly flat over 6h".
--
-- Storing the trailing average per tick on the daemon side fixes
-- this properly: at any tick T the chart can divide
-- pool_blocks_Nd_count(T) by an expectation derived from the matching
-- N-day average pool hashrate ending at T. No client-side smoothing
-- knob, no asymmetric "leftmost tick has 1 sample" artifact.
--
-- Both columns are nullable - back-rows have no pre-computed average,
-- and the chart falls back to its previous SMOOTH_TICKS path on those
-- rows so the historical luck line keeps rendering.

ALTER TABLE tick_metrics ADD COLUMN pool_hashrate_ph_avg_24h REAL;
ALTER TABLE tick_metrics ADD COLUMN pool_hashrate_ph_avg_7d REAL;
