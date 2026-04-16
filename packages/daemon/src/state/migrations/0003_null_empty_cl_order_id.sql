-- Backfill: empty-string cl_order_id values came from early LIVE attempts
-- where Braiins returned `cl_order_id: ""`. SQLite's UNIQUE index treats
-- multiple empty strings as duplicates (unlike multiple NULLs), so further
-- inserts fail. Normalise existing empties to NULL.

UPDATE owned_bids
   SET cl_order_id = NULL
 WHERE cl_order_id = '';
