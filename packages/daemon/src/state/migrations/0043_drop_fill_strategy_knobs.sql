-- Drop the entire fill-strategy subsystem (#49 redesign).
--
-- Once empirical observation confirmed that Braiins' marketplace
-- matches classic-CLOB (you pay the seller's ask, not your bid), the
-- elaborate machinery for managing where the bid sits relative to
-- fillable became pointless complexity: our bid just needs to sit at
-- the effective cap (min(max_bid, hashprice + max_overpay_vs_hashprice))
-- and the market does the rest. Lowering the bid only gates *which
-- sellers we can reach*, not what we pay; raising is ~free.
--
-- Fields removed:
--   - overpay_sat_per_eh_day              (bid above fillable — no longer used)
--   - escalation_mode                     (market/dampened/above_market picker)
--   - fill_escalation_step_sat_per_eh_day (dampened-mode step)
--   - fill_escalation_after_minutes       (trigger delay)
--   - min_lower_delta_sat_per_eh_day      (lowering threshold)
--   - lower_patience_minutes              (lowering dwell time)
--
-- decide() is simplified to: keep one bid at the effective cap,
-- adjust speed on cheap-mode transitions.

ALTER TABLE config DROP COLUMN overpay_sat_per_eh_day;
ALTER TABLE config DROP COLUMN escalation_mode;
ALTER TABLE config DROP COLUMN fill_escalation_step_sat_per_eh_day;
ALTER TABLE config DROP COLUMN fill_escalation_after_minutes;
ALTER TABLE config DROP COLUMN min_lower_delta_sat_per_eh_day;
ALTER TABLE config DROP COLUMN lower_patience_minutes;
