-- BTC/USD price oracle source. 'none' disables the price fetcher;
-- other values name the exchange API to poll. Feeds the dashboard's
-- denomination toggle (sats ↔ USD).

ALTER TABLE config
  ADD COLUMN btc_price_source TEXT NOT NULL DEFAULT 'none'
  CHECK (btc_price_source IN ('none', 'coingecko', 'coinbase', 'bitstamp', 'kraken'));
