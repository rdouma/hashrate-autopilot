-- #373: persisted CREATE hold (churn breaker / marketplace blacklist).
-- kind: 'churn' (manual release) | 'blacklist' (auto-release at until_ms).
-- All NULL = no hold. Survives restarts so a daemon bounce can't
-- silently resume creating into a broken pool or an active blacklist.
ALTER TABLE runtime_state ADD COLUMN create_hold_kind TEXT;
ALTER TABLE runtime_state ADD COLUMN create_hold_until_ms INTEGER;
ALTER TABLE runtime_state ADD COLUMN create_hold_detail TEXT;
ALTER TABLE runtime_state ADD COLUMN create_hold_since_ms INTEGER;
