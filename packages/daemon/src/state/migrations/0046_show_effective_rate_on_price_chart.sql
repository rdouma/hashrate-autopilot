-- Operator toggle: show the effective-rate line on the Price chart.
--
-- The emerald "effective" line is window-aggregated Δconsumed_sat ÷
-- (delivered_ph × Δt) per tick. It's dramatically more volatile than
-- bid/fillable/hashprice because Braiins' amount_consumed_sat counter
-- settles in lumps and the rolling denominator keeps accumulating
-- between settlements - deep transient dips that auto-scale the Y-axis
-- down by 10-15 k sat/PH/day and crush the detail of the flatter
-- series (bid, fillable, hashprice, max_bid) into a thin band.
--
-- Operators who want to eyeball the settlement rate from time to time
-- can flip this on; the finer controller movements then get harder to
-- read. Off by default - the Price card + AVG COST / PH DELIVERED
-- stat card already surface the effective rate as a number without
-- hijacking the chart scale.

ALTER TABLE config ADD COLUMN show_effective_rate_on_price_chart INTEGER NOT NULL DEFAULT 0
  CHECK (show_effective_rate_on_price_chart IN (0, 1));
