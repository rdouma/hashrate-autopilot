-- Bump retention defaults so existing installs get the new values (#80):
--   tick_metrics_retention_days       7  → 365  (cheap numeric series; 1y chart range works out of the box)
--   decisions_eventful_retention_days 90 → 365  (rare ~10% of ticks; high-value forensic records)
--
-- decisions_uneventful_retention_days stays at 7d - it's the bloat lever.
--
-- Only touches rows still on the literal old default. Operators who
-- deliberately set 7d / 90d for their own reasons keep their choice.

UPDATE config SET tick_metrics_retention_days = 365 WHERE tick_metrics_retention_days = 7;
UPDATE config SET decisions_eventful_retention_days = 365 WHERE decisions_eventful_retention_days = 90;
