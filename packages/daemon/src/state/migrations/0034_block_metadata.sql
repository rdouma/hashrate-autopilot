-- Cached enrichment of Ocean pool blocks derived locally from the
-- operator's own bitcoind node - no external HTTP, no disclosure of
-- the node's presence to third-party explorers. The block-marker
-- tooltip on the Hashrate chart wants to show the miner identity
-- the way block explorers do (e.g. "Simple Mining · OCEAN"), which
-- is not available from Ocean's own API.
--
-- Populated by calling bitcoind `getblock <hash> 2`, extracting the
-- coinbase scriptSig, parsing its printable ASCII, and picking the
-- first operator-meaningful token. `pool_name` is currently the
-- literal "OCEAN" for every block (since they all come from Ocean's
-- API) - the column is kept generic so a future pool adapter can
-- populate it from a tags-matcher without another migration.
--
-- Blocks are immutable, so a successful enrichment is cached forever
-- keyed on block_hash. Both fields may be NULL when bitcoind RPC is
-- unavailable or the coinbase yielded no meaningful token; the
-- enrichment is re-tried on the next Ocean poll.

CREATE TABLE block_metadata (
  block_hash TEXT PRIMARY KEY,
  pool_name TEXT,
  miner_tag TEXT,
  fetched_at INTEGER NOT NULL
);
