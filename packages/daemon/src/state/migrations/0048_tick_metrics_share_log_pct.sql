-- Per-tick record of Ocean's `share_log` percentage - our share of the
-- pool's TIDES window, derived from `/statsnap.shares_in_tides ÷
-- pool_stat.current_tides_shares × 100` (issue #72). Plotted as an
-- opt-in fourth series on the Hashrate chart's right-side Y-axis when
-- `show_share_log_on_hashrate_chart` is enabled.
--
-- Sourced from the same Ocean response that already supplies
-- `hashprice_sat_per_ph_day` (cached `fetchStats` call shared with the
-- /api/ocean route). NULL when Ocean isn't configured, the poll
-- failed, or the pool's tides shares were zero. Stored as a percentage
-- (e.g. 0.0182 for 0.0182%) to match Ocean's display convention.
--
-- Display-only - never read by the controller.

ALTER TABLE tick_metrics ADD COLUMN share_log_pct REAL;
