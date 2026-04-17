-- Separate patience window for price decreases when already filled.
-- Prevents the autopilot from chasing short market dips.
ALTER TABLE config ADD COLUMN lower_patience_minutes INTEGER NOT NULL DEFAULT 15;
