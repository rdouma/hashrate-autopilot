-- Persist the original filename of an uploaded custom block-found
-- sound, so the Config UI can show the operator what they currently
-- have selected (#88 follow-up). Without this column, the dashboard
-- could only report bytes/MIME after upload; the operator had no
-- visual confirmation of which file was active.
--
-- Nullable: pre-existing rows have no filename, and the daemon
-- treats null as "unknown filename" without breaking playback.

ALTER TABLE config ADD COLUMN block_found_sound_custom_filename TEXT;
