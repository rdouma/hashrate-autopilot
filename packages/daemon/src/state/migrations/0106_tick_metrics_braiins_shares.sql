-- #243: per-tick snapshot of the primary owned bid's cumulative
-- share counters from Braiins. Sourced from /spot/bid/detail's
-- `counters_committed` block (not on the bids list response, hence
-- the per-tick extra GET). Stored as cumulative-since-bid-creation;
-- the dashboard derives the instantaneous rejection rate from
-- per-tick deltas (purchased / accepted / rejected each tick minus
-- previous tick). Counter-reset on bid rotation (new CREATE /
-- EDIT_SPEED) produces a negative delta - the derivation sets the
-- per-tick rate to NULL for those samples so the chart line breaks
-- across the rotation rather than spiking off-screen.
--
-- All nullable: NULL means we didn't manage to read the bid detail
-- this tick (Braiins API hiccup) or there is no primary owned bid
-- (account empty). Pre-migration rows stay NULL.

ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_purchased_m REAL;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_accepted_m REAL;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_shares_rejected_m REAL;
