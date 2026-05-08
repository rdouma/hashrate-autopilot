-- #100: live-editable Telegram bot token on the config table.
--
-- Mirrors the bitcoind_rpc_password dual-location pattern: keep the
-- secrets-table column as the SOPS / first-run wizard fallback, AND
-- add a config-table column the dashboard can read/write through the
-- standard /api/config flow. Daemon resolution: prefer config when
-- non-empty, fall back to secrets.
--
-- Without this column the dashboard would need a bespoke /api/secrets
-- editing path; with it, the bot token follows exactly the same
-- "type into Config, click Save, autopilot uses it on the next tick"
-- UX as every other live-editable setting.

ALTER TABLE config ADD COLUMN telegram_bot_token TEXT NOT NULL DEFAULT '';
