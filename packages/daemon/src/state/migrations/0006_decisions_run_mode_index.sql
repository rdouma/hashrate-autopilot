-- The Decisions page supports filtering by run_mode (Live / Dry run /
-- Paused). Without this index that filter does a table scan over every
-- tick row.

CREATE INDEX IF NOT EXISTS idx_decisions_run_mode ON decisions (run_mode);
