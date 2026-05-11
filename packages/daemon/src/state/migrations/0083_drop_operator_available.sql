-- #148: drop the `operator_available` column from `runtime_state`.
--
-- The action-mode state machine (QUIET_HOURS / PENDING_CONFIRMATION /
-- CONFIRMATION_TIMEOUT) was retired in spec v1.1 when the owner-token API
-- was found to bypass Braiins's 2FA prompt, removing the need for an
-- operator-availability flag. The column + endpoint + dashboard client
-- method survived as dead plumbing - no controller, service, dashboard
-- page, or component reads or sets it.
--
-- SQLite does not support DROP COLUMN on older versions, but the supported
-- syntax has been stable since 3.35 (March 2021). The daemon ships with
-- better-sqlite3 >= 11 which bundles a modern SQLite, so a direct DROP
-- COLUMN works.

ALTER TABLE runtime_state DROP COLUMN operator_available;
