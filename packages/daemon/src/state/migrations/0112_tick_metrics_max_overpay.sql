-- #312: historize the "max premium over hashprice" knob per tick, the
-- same way max_bid_sat_per_eh_day already is (migration 0024). The Price
-- chart's effective-cap line is min(max_bid, hashprice + premium); the
-- premium half was previously applied as the *current* config value
-- across all history, so changing it retroactively shifted the whole
-- line. Storing it per tick lets the chart plot what the premium
-- actually was at each moment. NULL on pre-migration rows; the chart
-- falls back to the current config value for those.
ALTER TABLE tick_metrics ADD COLUMN max_overpay_vs_hashprice_sat_per_eh_day INTEGER;
