-- Store the hashprice (break-even revenue per PH/day) per tick so the
-- price chart can plot it as a time series instead of a static
-- horizontal line. Hashprice changes with difficulty adjustments
-- (~every 2 weeks) and block reward fluctuations.

ALTER TABLE tick_metrics ADD COLUMN hashprice_sat_per_eh_day INTEGER;
