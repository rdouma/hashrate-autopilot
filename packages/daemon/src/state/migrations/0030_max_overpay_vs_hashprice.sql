-- Hashprice-relative pricing cap (issue #27).
-- Per-tick the effective cap becomes:
--   min(max_bid_sat_per_eh_day, hashprice_sat_per_eh_day + max_overpay_vs_hashprice_sat_per_eh_day)
-- when both the fixed and dynamic caps are configured. NULL means the
-- dynamic cap is disabled; decide() falls back to the fixed max_bid
-- alone. Also falls back when hashprice is unavailable (Ocean stats
-- down or unconfigured).
ALTER TABLE config ADD COLUMN max_overpay_vs_hashprice_sat_per_eh_day INTEGER;
