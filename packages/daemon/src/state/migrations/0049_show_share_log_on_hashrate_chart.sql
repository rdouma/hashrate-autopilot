-- Operator toggle: show our share of Ocean's pool hashrate as a
-- fourth series on the Hashrate chart (issue #72).
--
-- When enabled, the dashboard renders `share_log_pct` (recorded each
-- tick into `tick_metrics`) as a violet line on a right-side Y-axis
-- labelled `% of Ocean`, formatted to 4 decimals (e.g. 0.0182%). Off
-- by default — the controller does not read it, and adding a second
-- Y-axis to a chart that already carries 3-5 hashrate lines costs
-- more glance-time than most operators need. Useful for tracking how
-- our slice of the pool drifts as Ocean's total hashrate grows or
-- our delivered PH/s fluctuates.

ALTER TABLE config ADD COLUMN show_share_log_on_hashrate_chart INTEGER NOT NULL DEFAULT 0
  CHECK (show_share_log_on_hashrate_chart IN (0, 1));
