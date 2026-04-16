-- Boot-mode knob: how the daemon chooses run_mode on startup.
--   ALWAYS_DRY_RUN  — reset to DRY_RUN on every boot (original SPEC §7.1 behaviour)
--   LAST_MODE       — keep whatever run_mode the operator last set (PAUSED is demoted
--                     to DRY_RUN to avoid booting into a non-operating state)
--   ALWAYS_LIVE     — always start in LIVE (for trusted redeployments)
-- Default is ALWAYS_DRY_RUN to preserve the original safety posture.

ALTER TABLE config ADD COLUMN boot_mode TEXT NOT NULL DEFAULT 'ALWAYS_DRY_RUN'
  CHECK (boot_mode IN ('ALWAYS_DRY_RUN', 'LAST_MODE', 'ALWAYS_LIVE'));
