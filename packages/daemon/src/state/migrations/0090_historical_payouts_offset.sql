-- Operator-set pre-installation earnings (sat) - #170 follow-up.
-- Free numeric field for off-chain or pre-autopilot pool earnings
-- that the on-chain payout-observer can't see (Lightning payouts,
-- payouts received and swept before the autopilot was installed,
-- etc.). Added to the lifetime-earnings chart's starting value AND
-- to the Status finance panel's net P&L, so users whose Ocean
-- history pre-dates the autopilot get a coherent picture without
-- needing to rotate their payout address.
ALTER TABLE config
  ADD COLUMN historical_payouts_offset_sat INTEGER NOT NULL DEFAULT 0;
