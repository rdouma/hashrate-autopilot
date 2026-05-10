-- #135: split the alert thresholds for `datum_unreachable` and
-- `sustained_paused` out from under the shared
-- `pool_outage_blip_tolerance_seconds * 5` formula.
--
-- Pre-migration both detectors used the same derived threshold,
-- which meant edits to one tile silently affected the other on the
-- Notifications-tab UI. Two new dedicated minute-int columns let the
-- operator tune them independently. `pool_outage_blip_tolerance_seconds`
-- keeps its current meaning - the dashboard's reachability-pill
-- blip tolerance - and is no longer multiplied by 5 in the alert
-- evaluator.
--
-- Defaults computed per-row from each operator's existing
-- `pool_outage_blip_tolerance_seconds`, rounded to the nearest
-- integer minute, so post-upgrade behaviour is unchanged. Operators
-- on the default 120s land at 10 minutes for both. Floor of 1 so
-- a degenerate `pool_outage_blip_tolerance_seconds = 0` doesn't
-- silently produce a 0-minute alert that fires on the first tick.

ALTER TABLE config
  ADD COLUMN datum_unreachable_alert_after_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE config
  ADD COLUMN sustained_paused_alert_after_minutes INTEGER NOT NULL DEFAULT 10;

UPDATE config
SET datum_unreachable_alert_after_minutes =
      MAX(1, CAST(ROUND(pool_outage_blip_tolerance_seconds * 5.0 / 60.0) AS INTEGER)),
    sustained_paused_alert_after_minutes =
      MAX(1, CAST(ROUND(pool_outage_blip_tolerance_seconds * 5.0 / 60.0) AS INTEGER))
WHERE id = 1;
