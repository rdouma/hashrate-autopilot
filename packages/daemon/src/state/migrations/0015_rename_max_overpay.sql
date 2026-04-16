-- Rename `max_overpay_sat_per_eh_day` -> `overpay_sat_per_eh_day`.
-- "max_" was misleading: this isn't the upper bound of a varying
-- overpay amount, it's the (fixed) overpay we always aim for above
-- the fillable ask. The only "max" semantic is the absolute
-- `max_bid_sat_per_eh_day` cap that clips us in the rare overheated
-- market case. Cleaner name = clearer config UX.

ALTER TABLE config RENAME COLUMN max_overpay_sat_per_eh_day TO overpay_sat_per_eh_day;
