-- Single-row `secrets` table - daemon's persistent home for the values
-- that historically lived only in `.env.sops.yaml`.
--
-- Why: appliance environments (Umbrel, Start9) cannot run the
-- interactive `setup.ts` flow and have no place to put a SOPS-encrypted
-- file with a separately-distributed age key. The first-run web wizard
-- (#57) writes secrets to this table directly, so the same SQLite file
-- the appliance backs up carries everything the daemon needs to boot.
-- Power-user SOPS path is unchanged - `.env.sops.yaml` still wins when
-- present.
--
-- Schema mirrors `SecretsSchema` in packages/daemon/src/config/schema.ts.
-- Single row enforced via `CHECK (id = 1)` (same idiom as `config`).
-- Optional fields are nullable; required fields are NOT NULL so a
-- malformed row simply can't be inserted.

CREATE TABLE secrets (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  braiins_owner_token TEXT NOT NULL,
  braiins_read_only_token TEXT,
  dashboard_password TEXT NOT NULL,
  bitcoind_rpc_url TEXT,
  bitcoind_rpc_user TEXT,
  bitcoind_rpc_password TEXT,
  telegram_bot_token TEXT,
  telegram_webhook_secret TEXT,
  updated_at INTEGER NOT NULL
);
