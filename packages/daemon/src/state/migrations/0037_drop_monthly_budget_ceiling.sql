-- Remove monthly_budget_ceiling_sat (issue #35).
--
-- Original plan: implement enforcement so the field actually does
-- something. Operator changed course — the field is judged
-- superfluous (per-bid budget + overall account balance already
-- bound outflow), so we rip it out instead of wiring up a gate,
-- a Next-Action hint, and an alert row for a knob nobody wants.
--
-- DROP COLUMN requires SQLite >= 3.35 (shipped with better-sqlite3
-- since late 2021, well below our runtime's floor).

ALTER TABLE config DROP COLUMN monthly_budget_ceiling_sat;
