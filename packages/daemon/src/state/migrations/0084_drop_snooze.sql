-- #148 follow-up: drop the `snoozed_until_ms` column from `alerts` and
-- normalize any historical `delivery_status = 'snoozed'` rows so the
-- daemon-side type union can lose 'snoozed' too.
--
-- Snooze (the operator-controlled "quiet this alert for 30m / 2h / 24h"
-- affordance) was retired in commit cc62951 in favour of the simpler
-- ack-only model. The column + the union member survived as dead code
-- until #148 catalogued them; this migration removes them.
--
-- 'snoozed' rows are remapped to 'gave_up' (the closest semantic - we
-- stopped delivering for some operator-driven reason). The historical
-- audit trail keeps every row; only the leaf status label changes.
--
-- SQLite 3.35+ supports direct ALTER TABLE DROP COLUMN; better-sqlite3
-- 11+ bundles a recent enough SQLite.

UPDATE alerts SET delivery_status = 'gave_up' WHERE delivery_status = 'snoozed';
ALTER TABLE alerts DROP COLUMN snoozed_until_ms;
