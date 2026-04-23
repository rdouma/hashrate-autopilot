-- Cheap-mode: require sustained-average threshold, not per-tick spot (#50).
-- When > 0, cheap-mode engages only if avg(best_ask) over the last N
-- minutes is below cheap_threshold_pct * avg(hashprice) over the same
-- window. Default 0 preserves the prior per-tick spot behaviour.
ALTER TABLE config ADD COLUMN cheap_sustained_window_minutes INTEGER NOT NULL DEFAULT 0;
