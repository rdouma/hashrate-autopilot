-- Snapshot the running `amount_consumed_sat` (= amount_sat -
-- amount_remaining_sat from Braiins) on every observe. When a bid
-- eventually disappears from /spot/bid/current (cancelled, completed,
-- abandoned), the last persisted value is our final figure for that
-- bid. Sum across all rows = lifetime spend, used by the finance
-- panel.
--
-- 0 default is correct for fresh inserts: a brand-new bid hasn't
-- consumed anything until it starts filling.

ALTER TABLE owned_bids
  ADD COLUMN amount_consumed_sat INTEGER NOT NULL DEFAULT 0;
