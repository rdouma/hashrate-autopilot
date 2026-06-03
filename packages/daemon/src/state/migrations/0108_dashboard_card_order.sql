-- #244: column for the dashboard card/block display order (drag to
-- reorder). RESERVED / currently dormant: the operator chose per-device
-- ordering, so the dashboard stores the order in browser localStorage
-- and does not write here. The column is kept (cheaper than a revert,
-- and avoids schema divergence on any instance that already ran this
-- migration); the daemon plumbing is ready if cross-device sync is ever
-- wanted. JSON array of stable block IDs; '[]' = built-in default order.
ALTER TABLE config ADD COLUMN dashboard_card_order TEXT NOT NULL DEFAULT '[]';
