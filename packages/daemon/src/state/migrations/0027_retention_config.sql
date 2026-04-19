-- Per-table retention windows for the append-only logs (issue #21).
-- Periodic maintenance deletes rows older than these cutoffs so the
-- DB doesn't grow unboundedly with uneventful tick records.
--
-- 0 means "disabled" (keep forever) for any of these columns.

ALTER TABLE config ADD COLUMN tick_metrics_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE config ADD COLUMN decisions_uneventful_retention_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE config ADD COLUMN decisions_eventful_retention_days INTEGER NOT NULL DEFAULT 90;
