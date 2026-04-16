-- Store the depth-aware fillable ask price per tick so the dashboard
-- chart can plot it alongside best_ask and our_primary_price. Lets the
-- operator see the gap between "first level with any supply" (best_ask)
-- and "first level where the full target hashrate fits" (fillable).

ALTER TABLE tick_metrics ADD COLUMN fillable_ask_sat_per_eh_day INTEGER;
