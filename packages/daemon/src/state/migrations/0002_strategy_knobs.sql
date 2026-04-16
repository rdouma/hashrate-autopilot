-- Strategy knobs for competitive bidding (M4.6).
-- SQLite's ALTER TABLE supports ADD COLUMN but requires a default when
-- the column is NOT NULL. Defaults encode the user's preferences from
-- the first-run interview.

ALTER TABLE config
  ADD COLUMN fill_escalation_step_sat_per_eh_day INTEGER NOT NULL DEFAULT 300000;

ALTER TABLE config
  ADD COLUMN fill_escalation_after_minutes INTEGER NOT NULL DEFAULT 30;

ALTER TABLE config
  ADD COLUMN max_overpay_vs_ask_sat_per_eh_day INTEGER NOT NULL DEFAULT 500000;

ALTER TABLE config
  ADD COLUMN hibernate_on_expensive_market INTEGER NOT NULL DEFAULT 1;
