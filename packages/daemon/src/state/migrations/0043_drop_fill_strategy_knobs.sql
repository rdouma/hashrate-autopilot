-- Retire the fill-strategy subsystem shipped in v1.x (#49 redesign,
-- partially reversed by #53 — see below).
--
-- The v1.x controller layered escalation modes, dampening, patience
-- timers and min-lower-delta on top of a `bid = fillable + overpay`
-- primitive. The v2.0 CLOB-redesign (#49) ripped all of that out on a
-- mistaken pay-at-ask premise. v2.1 (#53) restored direct
-- `fillable + overpay` tracking without the escalation/patience
-- machinery — so the old bolted-on timers and modes stay retired,
-- but `overpay_sat_per_eh_day` itself is PRESERVED with identical
-- semantics ("how far above fillable to sit").
--
-- Migration history note: an earlier version of this file also
-- dropped `overpay_sat_per_eh_day`; the follow-up 0045 re-added it
-- with a default 1,000 sat/PH/day. Operators who applied that earlier
-- chain lost their configured overpay value. The current file no
-- longer drops it, so future upgrades (main-branch users pulling
-- post-v2.1) preserve their existing value through the migration.
-- See 0045 for the paired no-op.
--
-- Fields removed:
--   - escalation_mode                     (market/dampened/above_market picker)
--   - fill_escalation_step_sat_per_eh_day (dampened-mode step)
--   - fill_escalation_after_minutes       (trigger delay)
--   - min_lower_delta_sat_per_eh_day      (lowering threshold)
--   - lower_patience_minutes              (lowering dwell time)

ALTER TABLE config DROP COLUMN escalation_mode;
ALTER TABLE config DROP COLUMN fill_escalation_step_sat_per_eh_day;
ALTER TABLE config DROP COLUMN fill_escalation_after_minutes;
ALTER TABLE config DROP COLUMN min_lower_delta_sat_per_eh_day;
ALTER TABLE config DROP COLUMN lower_patience_minutes;
