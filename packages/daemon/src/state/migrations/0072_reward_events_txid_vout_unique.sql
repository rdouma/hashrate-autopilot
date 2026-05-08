-- Promote the (txid, vout) tuple on `reward_events` to a real
-- UNIQUE constraint. The payout-observer was emulating this
-- with a SELECT-then-filter dance: every scan read the entire
-- table to build a Set of seen pairs before inserting, which
-- (a) costs O(N) per scan as the table grows monotonically and
-- (b) leaves a race window between the SELECT and the INSERT if
-- two scans run concurrently. With a UNIQUE index we can drop
-- the SELECT entirely and use INSERT ... ON CONFLICT DO NOTHING
-- - the database enforces dedup at write time, race-free.
--
-- IF NOT EXISTS so re-running the migration on a DB that already
-- has the unique index (e.g. operators who manually added it) is
-- a no-op.

CREATE UNIQUE INDEX IF NOT EXISTS idx_reward_events_txid_vout
  ON reward_events(txid, vout);
