-- #100: Telegram notifications - schema groundwork.
--
-- Reinstates the alerts pipeline that was scaffolded in v1.0 but never
-- wired to a notification channel. Replaces the original v1.0
-- telegram_message_id with a channel-agnostic delivery_meta_json so a
-- future second NotificationSink (Nostr, ntfy, ...) can slot in without
-- another schema bump.
--
-- Also absorbs #99 cleanup: drops the v1.0 columns that have been
-- dead-since-launch (quiet_hours_*, confirmation_timeout_minutes,
-- telegram_webhook_secret) and were carried only as @deprecated
-- placeholders in the TS types.
--
-- telegram_chat_id (config) and telegram_bot_token (secrets) are
-- KEPT - they finally get a live consumer in this issue.
--
-- ALTER TABLE … DROP COLUMN requires SQLite ≥ 3.35 (better-sqlite3
-- bundles a recent build). All ADD/DROP run in a single migration
-- transaction so a partial apply rolls back cleanly.

-- Alerts table: channel-agnostic delivery state + retry scheduling.
ALTER TABLE alerts ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE alerts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN last_attempt_at_ms INTEGER;
ALTER TABLE alerts ADD COLUMN next_retry_at_ms INTEGER;
ALTER TABLE alerts ADD COLUMN snoozed_until_ms INTEGER;
ALTER TABLE alerts ADD COLUMN paired_alert_id INTEGER REFERENCES alerts(id);
ALTER TABLE alerts ADD COLUMN delivery_meta_json TEXT;
ALTER TABLE alerts ADD COLUMN acknowledged_at_ms INTEGER;
ALTER TABLE alerts ADD COLUMN event_class TEXT;

-- The v1.0 placeholder for the Telegram message id is superseded by
-- the channel-agnostic delivery_meta_json (which holds Telegram's
-- message_id today and any future channel's identifier later).
ALTER TABLE alerts DROP COLUMN telegram_message_id;

-- Indexes on the new lookups the daemon's retry scheduler does on
-- every tick.
CREATE INDEX idx_alerts_delivery_status ON alerts (delivery_status);
CREATE INDEX idx_alerts_next_retry      ON alerts (next_retry_at_ms);

-- Config: new global mute toggle and per-event retry cadence.
ALTER TABLE config ADD COLUMN notifications_muted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN notification_retry_interval_minutes INTEGER NOT NULL DEFAULT 30;

-- Config: drop the v1.0 quiet-hours / confirmation columns. Replaced
-- by mute-on-demand + per-alert snooze; never had a live consumer.
ALTER TABLE config DROP COLUMN quiet_hours_start;
ALTER TABLE config DROP COLUMN quiet_hours_end;
ALTER TABLE config DROP COLUMN quiet_hours_timezone;
ALTER TABLE config DROP COLUMN confirmation_timeout_minutes;

-- Secrets: drop the v1.0 webhook-secret column. We POST to Telegram,
-- never receive callbacks, so this was always unused.
ALTER TABLE secrets DROP COLUMN telegram_webhook_secret;
