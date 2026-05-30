-- #226: two opt-in INFO Telegram alerts covering the Ocean payout
-- lifecycle. Default off, matching the existing notify_on_*
-- conventions (#117 pool block credited, #130 braiins deposit
-- lifecycle), so a fresh install + upgrade doesn't suddenly
-- buzz the operator's phone.
ALTER TABLE config ADD COLUMN notify_on_payout_initiated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE config ADD COLUMN notify_on_payout_confirmed INTEGER NOT NULL DEFAULT 0;
