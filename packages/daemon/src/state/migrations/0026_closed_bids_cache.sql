-- Persistent cache of terminal Braiins bids (CANCELED / FULFILLED).
--
-- Terminal bids have `is_current = false` and their
-- `counters_committed.amount_consumed_sat` is immutable - once a bid
-- is closed, its consumed figure never changes. Storing them locally
-- means `AccountSpendService` can start each refresh from a cached
-- running total and only paginate `/spot/bid` far enough to catch
-- new closed bids (usually one page).
--
-- Active bids (is_current=true) are NOT cached here - their consumed
-- counter updates hourly as Braiins settles, and we always re-read
-- them live from `/spot/bid`.

CREATE TABLE closed_bids_cache (
  braiins_order_id TEXT PRIMARY KEY,
  amount_consumed_sat INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX idx_closed_bids_cache_last_seen_at
  ON closed_bids_cache (last_seen_at);
