-- Cap on how much a single lower-edit may drop the bid price. Without this,
-- a real market drop could cause one large EDIT_PRICE that lands us at
-- "topmost-ask + overpay" - but the topmost ask might only offer a sliver
-- of supply. The dampener forces the lowering to happen in small steps
-- (one per allowed edit), giving the fill a chance to settle between
-- moves. Default mirrors fill_escalation_step so up/down moves are
-- symmetric per edit.

ALTER TABLE config
  ADD COLUMN max_lowering_step_sat_per_eh_day INTEGER NOT NULL DEFAULT 300000
  CHECK (max_lowering_step_sat_per_eh_day > 0);
