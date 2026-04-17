ALTER TABLE config ADD COLUMN payout_source TEXT NOT NULL DEFAULT 'none' CHECK (payout_source IN ('none', 'electrs', 'bitcoind'));
