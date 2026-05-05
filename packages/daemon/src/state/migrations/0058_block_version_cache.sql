-- Persistent cache of block-header version values, keyed by block
-- hash. Block headers are immutable - once we've fetched a version
-- for a hash we never need to fetch it again, even across daemon
-- restarts. The cache is what powers the BIP-110 crown marker on
-- the hashrate chart (#94).
--
-- Why a separate table rather than `reward_events.block_version`:
-- the chart's block markers come from Ocean's `our_recent_blocks`
-- list (keyed by hash) - reward_events isn't joined to the chart's
-- marker rendering. A hash-keyed cache is the right primary key for
-- the actual consumer. If a future feature needs per-reward_event
-- version, it can read from this table by hash.
--
-- `block_version` is the raw 32-bit version field from the block
-- header (signed-int range fits in INTEGER). We keep the raw value
-- rather than a `signals_bip110` boolean so future signaling-bit
-- features can branch on the same column without backfill.

CREATE TABLE block_version_cache (
  block_hash TEXT PRIMARY KEY,
  block_version INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
