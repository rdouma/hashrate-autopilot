-- Reverts 0034. The block_metadata table cached per-block
-- enrichment (pool_name / miner_tag) derived from bitcoind's
-- getblock coinbase parse. The enrichment feature was pulled -
-- it required bitcoind RPC configured regardless of the operator's
-- payout-source choice, which made the Config panel confusing, and
-- the extracted miner tag was rarely meaningful anyway.
--
-- Forward-only migration: existing deployments that ran 0034 will
-- drop the dead table here; fresh installs still see 0034 create
-- and 0036 drop, which is harmless.

DROP TABLE IF EXISTS block_metadata;
