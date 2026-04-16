-- Simplify pricing model: all thresholds relative to fillable + max_overpay.
-- Removes dampeners (overpay_before_lowering, max_lowering_step) since
-- downward adjustments now jump directly to target.
-- Adds escalation_mode for configurable upward adjustment behavior.

-- Rename pricing cap columns for clarity
ALTER TABLE config RENAME COLUMN max_price_sat_per_eh_day TO max_bid_sat_per_eh_day;
ALTER TABLE config RENAME COLUMN emergency_max_price_sat_per_eh_day TO emergency_max_bid_sat_per_eh_day;

-- Rename overpay column (drop the verbose "vs_ask" suffix)
ALTER TABLE config RENAME COLUMN max_overpay_vs_ask_sat_per_eh_day TO max_overpay_sat_per_eh_day;

-- Add escalation mode: 'market' (jump to target) or 'dampened' (step up)
ALTER TABLE config ADD COLUMN escalation_mode TEXT NOT NULL DEFAULT 'dampened';

-- SQLite doesn't support DROP COLUMN directly in all versions, but 3.35+
-- does. The old columns remain but are ignored by the new schema.
-- If using older SQLite, these will fail gracefully and the unused
-- columns will remain (harmless bloat).
-- ALTER TABLE config DROP COLUMN overpay_before_lowering_sat_per_eh_day;
-- ALTER TABLE config DROP COLUMN max_lowering_step_sat_per_eh_day;
