-- Bump btc_price_source default from 'none' to 'coingecko' on installs
-- that never explicitly set it (#77). The earlier default left the
-- sats/USD denomination toggle hidden out of the box because the
-- dashboard suppresses the toggle when btcPrice is null. CoinGecko's
-- public price endpoint needs no auth, no Bitcoin RPC, and one HTTPS
-- call every 5 min - safe to enable by default. Operators who want
-- the daemon to make zero outbound calls beyond Braiins / their own
-- node can still pick 'none' in Config.
--
-- Only touches rows whose value is still the literal old default. If
-- the operator deliberately set 'none' (or any other source), the
-- migration leaves their choice alone.

UPDATE config SET btc_price_source = 'coingecko' WHERE btc_price_source = 'none';
