-- #89: persist 11 free per-tick fields from data sources we already
-- poll. All nullable so older rows back-fill cleanly with NULL.
-- Total ~50 bytes/row added × 525k rows/year = ~26 MB/year at the
-- 365-day default retention.

-- From Ocean /pool_stat (already on OceanPoolInfo, just not stored).
ALTER TABLE tick_metrics ADD COLUMN network_difficulty INTEGER;
ALTER TABLE tick_metrics ADD COLUMN estimated_block_reward_sat INTEGER;
ALTER TABLE tick_metrics ADD COLUMN pool_hashrate_ph INTEGER;
ALTER TABLE tick_metrics ADD COLUMN pool_active_workers INTEGER;

-- From Braiins /account/balance (same response we use for available_balance_sat).
ALTER TABLE tick_metrics ADD COLUMN braiins_total_deposited_sat INTEGER;
ALTER TABLE tick_metrics ADD COLUMN braiins_total_spent_sat INTEGER;

-- From Ocean /statsnap (already on OceanStats.unpaid_sat).
ALTER TABLE tick_metrics ADD COLUMN ocean_unpaid_sat INTEGER;

-- From the BTC-price oracle (already polled every 5 min). Float to
-- accommodate sub-dollar resolution at the typical 50-100k$/BTC range.
ALTER TABLE tick_metrics ADD COLUMN btc_usd_price REAL;

-- From Braiins /spot/bid/current (the primary owned bid's metadata).
-- last_pause_reason is short identifier text; 'NONE' / 'POOL_FAILED' etc.
-- fee_paid_sat is cumulative on the bid; fee_rate_pct is captured at
-- bid creation per research.md §2.2 (no surprise mid-bid changes).
ALTER TABLE tick_metrics ADD COLUMN primary_bid_last_pause_reason TEXT;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_fee_paid_sat INTEGER;
ALTER TABLE tick_metrics ADD COLUMN primary_bid_fee_rate_pct REAL;
