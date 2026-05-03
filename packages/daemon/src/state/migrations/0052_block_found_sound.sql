-- Audible notification when a block is found (#88).
--
-- Operator-facing setting `block_found_sound` picks one of four
-- bundled sounds shipped at packages/dashboard/public/sounds/, or
-- 'custom' to use the operator-uploaded blob below, or 'off' to
-- disable. Default is 'off' so existing installs don't suddenly
-- start playing audio after upgrade.
--
-- The custom blob + mime are nullable; only meaningful when
-- block_found_sound = 'custom'. Hard size cap (~200 KB) enforced
-- at the upload endpoint so SQLite backups stay sane.

ALTER TABLE config
  ADD COLUMN block_found_sound TEXT NOT NULL DEFAULT 'off';

ALTER TABLE config
  ADD COLUMN block_found_sound_custom_blob BLOB;

ALTER TABLE config
  ADD COLUMN block_found_sound_custom_mime TEXT;
