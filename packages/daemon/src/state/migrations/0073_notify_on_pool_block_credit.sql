-- #117: opt-in INFO Telegram message at every Ocean pool-block
-- credit (TIDES). Off by default - the audible cue + chart
-- marker already exist, and not every operator wants a phone
-- buzz on every block.
--
-- Stored as INTEGER (SQLite booleans are 0/1 in this schema).
-- Default 0 = off, in line with the operator-stated preference
-- and matching the schema-side default.
--
-- Distinct from `notification_disabled_event_classes` because new
-- event classes default to enabled per #106; a dedicated boolean
-- keeps "off by default" load-bearing even if the operator
-- later un-mutes everything globally.

ALTER TABLE config
  ADD COLUMN notify_on_pool_block_credit INTEGER NOT NULL DEFAULT 0;
