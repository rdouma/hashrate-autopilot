-- Client-side smoothing window for the Price chart's "our bid" and
-- "effective" (per-tick actual rate) lines (#49 follow-up). Same
-- mechanism as the Hashrate chart's braiins/datum smoothing knobs
-- from 0039 - 1 = no smoothing, N = rolling N-minute mean applied
-- in the dashboard.
--
-- Not read by the daemon control loop - pure display config.
ALTER TABLE config ADD COLUMN braiins_price_smoothing_minutes INTEGER NOT NULL DEFAULT 1;
