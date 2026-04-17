ALTER TABLE config ADD COLUMN payout_source TEXT NOT NULL DEFAULT 'none' CHECK (payout_source IN ('none', 'electrs', 'bitcoind'));

-- Back-fill from existing config: if electrs is configured, use it;
-- else if bitcoind is configured, use that. Runs once at migration
-- time so operator can override freely after.
UPDATE config SET payout_source = 'electrs'
  WHERE electrs_host IS NOT NULL AND electrs_host != '';
UPDATE config SET payout_source = 'bitcoind'
  WHERE payout_source = 'none'
    AND bitcoind_rpc_url IS NOT NULL AND bitcoind_rpc_url != '';
