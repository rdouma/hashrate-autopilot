-- Per-tick pool luck values, computed daemon-side from the gap
-- between the tick time and the most recent pool block:
--
--   luck = expected_gap_seconds / time_since_last_pool_block
--   expected_gap_seconds = 600 / pool_share
--   pool_share = pool_hashrate_avg / network_hashrate
--
-- Replaces the prior `count_in_window / poisson_expected` formula
-- whose numerator was an integer block count and therefore moved
-- only in discrete +/-1 steps regardless of how much time had passed
-- between finds. The new formula:
--   - Decays continuously between finds (1/t shape).
--   - Jumps at every pool block (elapsed resets to ~0).
--   - Reads exactly 1.0× at elapsed == expected_gap.
--   - "Two blocks in 20 min" reads as a >1× spike in the gap before
--     the second find (the gap was much shorter than expected).
--
-- 24h and 7d variants differ only in which window we search for "the
-- most recent block": the 24h variant reads "very unlucky" if no
-- pool block landed in the last 24 hours; the 7d variant looks back
-- further before falling off. Both columns are nullable - any tick
-- with missing pool_hashrate / network_difficulty / block list
-- writes null and the chart shows a gap.

ALTER TABLE tick_metrics ADD COLUMN pool_luck_24h REAL;
ALTER TABLE tick_metrics ADD COLUMN pool_luck_7d REAL;
