-- #106: per-event-class Telegram subscription.
--
-- Comma-separated list of event_class names the operator has opted
-- out of. Empty string = all enabled (the default). Avoids a
-- migration per new event class - new classes default to "enabled"
-- without code changes elsewhere.
--
-- Daemon resolution: AlertEvaluator.runTransition() short-circuits
-- when the event_class is in this set - no alert row, no timer
-- arming, no recovery message. Symmetric: re-enabling mid-outage
-- starts a fresh "bad since now" rather than retroactively crediting
-- silent time.

ALTER TABLE config ADD COLUMN notification_disabled_event_classes TEXT NOT NULL DEFAULT '';
