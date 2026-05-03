-- #89: per-tick BTC oracle source. Locks the source historically
-- alongside the price reading so retroactive USD valuations stay
-- attributable. Nullable - when btc_usd_price is null (oracle off
-- or unreachable) so is the source.
ALTER TABLE tick_metrics ADD COLUMN btc_usd_price_source TEXT;
