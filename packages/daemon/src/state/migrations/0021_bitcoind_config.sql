ALTER TABLE config ADD COLUMN bitcoind_rpc_url TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN bitcoind_rpc_user TEXT NOT NULL DEFAULT '';
ALTER TABLE config ADD COLUMN bitcoind_rpc_password TEXT NOT NULL DEFAULT '';
