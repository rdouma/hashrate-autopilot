-- Optional Electrs connection for fast address balance lookups.
-- When both host and port are non-null, the payout observer uses
-- Electrs instead of bitcoind's slow scantxoutset.

ALTER TABLE config ADD COLUMN electrs_host TEXT DEFAULT NULL;
ALTER TABLE config ADD COLUMN electrs_port INTEGER DEFAULT NULL;
