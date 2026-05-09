-- #123: count-based suppression of bid-event markers on the price
-- chart. When more than this many markers would render in a single
-- chart frame, the dashboard hides EDIT_PRICE markers first
-- (CREATE / EDIT_SPEED / CANCEL stay because they're rare and
-- diagnostic), and if still over the cap, hides everything.
--
-- Default 0 = no count-based suppression - all markers render
-- subject to the existing per-range showEventKinds filter, same
-- as today. Operator opts in by setting a positive value on
-- Config -> Display & Logging.

ALTER TABLE config
  ADD COLUMN chart_max_markers INTEGER NOT NULL DEFAULT 0;
