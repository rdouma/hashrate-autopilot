-- #266: configurable StatsBar tiles. JSON array of catalogue ids
-- (e.g. ["uptime", "avg_braiins", "hashrate_target", ...]). Empty
-- array means "use the dashboard's default set" so existing installs
-- preserve the build-611 look. Defensive parse on the dashboard side
-- filters out ids that no longer exist in the catalogue (a tile
-- removed in a future release), so a stale config blob degrades
-- cleanly. One column (JSON) instead of one-column-per-tile-slot so
-- a variable tile count works without further migrations.

ALTER TABLE config ADD COLUMN dashboard_tiles TEXT NOT NULL DEFAULT '[]';
