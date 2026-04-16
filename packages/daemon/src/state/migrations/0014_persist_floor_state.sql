-- Persist below-floor / above-floor controller state across daemon
-- restarts. Without this, every restart resets the escalation timer to
-- zero — operator sees "below floor since 2m" while the actual drought
-- has been running for 20 min, masking long unfilled stretches and
-- effectively disabling the escalation ladder if restarts are frequent.
-- Issue #11.
--
-- Why safe to persist (vs run_mode which is deliberately NOT
-- persisted): SPEC §7.1 resets run_mode at boot to bound mutation
-- blast radius. These two fields are observations, not authority — they
-- inform when the controller *would* mutate, but the mutation gate
-- (§7.2) is unchanged and still requires LIVE mode.

ALTER TABLE runtime_state ADD COLUMN below_floor_since_ms INTEGER;
ALTER TABLE runtime_state ADD COLUMN above_floor_ticks INTEGER NOT NULL DEFAULT 0;
