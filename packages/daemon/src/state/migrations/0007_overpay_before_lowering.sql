-- Safety margin for auto-lowering the bid price. The autopilot only
-- proposes an EDIT_PRICE downward when (current_price - target_price)
-- exceeds this amount. Keeps fills alive when the market is moving
-- normally; takes advantage of genuine market drops.
--
-- 2_000_000 sat/EH/day = 2,000 sat/PH/day. Per operator preference.

ALTER TABLE config
  ADD COLUMN overpay_before_lowering_sat_per_eh_day INTEGER NOT NULL DEFAULT 2000000;
