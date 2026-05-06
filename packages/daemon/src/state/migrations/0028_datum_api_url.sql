-- Optional Datum Gateway HTTP API URL (issue #19).
-- When set, the daemon polls {datum_api_url}/umbrel-api each tick to
-- get Datum's view of connection count and hashrate. Integration is
-- purely informational - the control loop does not depend on it.
-- Leaving NULL disables the integration; the dashboard shows a
-- "Datum not configured" empty state.

ALTER TABLE config ADD COLUMN datum_api_url TEXT DEFAULT NULL;
