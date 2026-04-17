-- Store the operator's max_bid ceiling per tick so it can be plotted
-- as a historical time series on the price chart.
ALTER TABLE tick_metrics ADD COLUMN max_bid_sat_per_eh_day INTEGER;
