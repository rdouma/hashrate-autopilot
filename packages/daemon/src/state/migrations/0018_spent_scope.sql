-- Operator-facing toggle: how the Money panel computes "spent".
-- 'autopilot' (default) = sum of consumed across owned_bids the
-- autopilot has tagged. 'account' = sum of all
-- "(Partial) order settlement (brutto price)" entries from
-- /v1/account/transaction — includes bids placed before the autopilot
-- existed, so the net P&L matches Ocean's lifetime earnings on the
-- income side.

ALTER TABLE config
  ADD COLUMN spent_scope TEXT NOT NULL DEFAULT 'autopilot'
  CHECK (spent_scope IN ('autopilot', 'account'));
