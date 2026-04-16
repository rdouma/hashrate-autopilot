-- Minimum overpay (vs target) before the autopilot bothers to lower the
-- bid. Without this, every-tick re-evaluation could fire a 4-sat EDIT
-- that triggers Braiins's 10-min price-decrease cooldown for negligible
-- savings. Default 200_000 sat/EH/day = 200 sat/PH/day.

ALTER TABLE config
  ADD COLUMN min_lower_delta_sat_per_eh_day INTEGER NOT NULL DEFAULT 200000;
