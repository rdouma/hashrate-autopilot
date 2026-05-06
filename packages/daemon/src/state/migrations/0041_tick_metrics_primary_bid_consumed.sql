-- Snapshot the primary bid's cumulative `amount_consumed_sat` on each
-- tick. Tick-level deltas of this column give the authoritative
-- per-tick actual spend (from Braiins), independent of our
-- pay-your-bid `spend_sat` model.
--
-- Used by (a) the pay-your-bid-vs-pay-at-ask verification workflow
-- (issue #49 TBD) - per-tick actual vs modeled ratio pins down the
-- matching semantics definitively - and (b) a new "effective rate"
-- line on the Price chart derived client-side as
--   actual_rate_sat_per_ph_day =
--     (consumed[N] − consumed[N-1]) × 1_440_000 /
--     (delivered_ph × (tick_at[N] − tick_at[N-1]) / 60_000)
-- Null on pre-migration rows and on any tick with no primary bid.
--
-- Nullable because (a) legacy rows don't have it and (b) a tick with
-- no owned primary bid has no meaningful consumed figure.

ALTER TABLE tick_metrics
  ADD COLUMN primary_bid_consumed_sat INTEGER;
