-- #238: per-series chart color overrides. JSON blob keyed by canonical
-- series name (e.g. "hashrate.delivered", "price.our_bid"). Missing keys
-- fall back to the built-in defaults in lib/chartColors.ts on the
-- dashboard side, so an empty object preserves the current look.
--
-- One column (JSON) instead of one column per series so future series
-- can be added without another migration.

ALTER TABLE config ADD COLUMN chart_color_overrides TEXT NOT NULL DEFAULT '{}';
