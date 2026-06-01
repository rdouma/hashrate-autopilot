-- #241: mark synthetic tick_metrics rows (inserted by boot-time
-- backfill services to fill offline-gap state - currently
-- runRetargetBackfill; future per-tick gap-fill from the broader
-- #241 work). Real polled rows have synthetic=0; backfilled rows
-- have synthetic=1.
--
-- Why: the gap-detection logic in runRetargetBackfill queries the
-- "previous tick" before the current outage. If a previous boot
-- inserted a synthetic tick at the wrong-time inside the gap, that
-- row becomes the most-recent "previous" candidate on the next
-- boot, blocks the re-detection (its difficulty already matches
-- the new value), and the backfill silently no-ops without ever
-- correcting the wrong-time tick. Filtering `synthetic = 0` in the
-- prev-tick query fixes this, and lets the backfill safely DELETE
-- and re-insert synthetic rows when bitcoind hands us a more
-- canonical timestamp than what's currently stored.

ALTER TABLE tick_metrics ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
