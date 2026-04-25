/**
 * Multi-source secrets loader for the daemon entrypoint.
 *
 * Resolution priority on boot:
 *
 * 1. **Pure environment variables** (`BHA_BRAIINS_OWNER_TOKEN` +
 *    `BHA_DASHBOARD_PASSWORD` set, plus any optional fields). Lets a
 *    Docker / Umbrel / Start9 deployment skip both the SOPS file and
 *    the wizard entirely — declare creds in the manifest, done.
 *
 * 2. **SOPS-encrypted file** (`.env.sops.yaml`). Power-user path —
 *    unchanged from the v1.x flow. Env-var overrides still overlay
 *    on top so a `docker run -e BHA_…` rotation works without
 *    touching the encrypted file.
 *
 * 3. **`secrets` table in `state.db`**. Populated by the first-run
 *    web onboarding wizard (#57). Same env-var overlay as the SOPS
 *    path.
 *
 * 4. **Null** — no source carries a complete `Secrets` object. The
 *    daemon entrypoint interprets this as NEEDS_SETUP and starts a
 *    slim HTTP server with the wizard route exposed.
 */

import { stat } from 'node:fs/promises';

import {
  applyEnvOverridesToSecrets,
  buildSecretsFromEnv,
} from './env-overrides.js';
import { loadSecrets } from './secrets.js';
import type { Secrets } from './schema.js';
import type { SecretsRepo } from '../state/repos/secrets.js';

export interface LoadSecretsAnySourceOptions {
  readonly sopsPath: string;
  readonly ageKeyPath: string;
  readonly secretsRepo: SecretsRepo;
  readonly env?: NodeJS.ProcessEnv;
}

export interface LoadSecretsAnySourceResult {
  readonly secrets: Secrets;
  readonly source: 'env' | 'sops' | 'db';
}

/**
 * Try every secret source in priority order, returning the first one
 * that produces a valid `Secrets` object. Returns `null` if none do —
 * caller should branch into NEEDS_SETUP.
 *
 * Env-var overrides are applied on top of the file/db sources so the
 * appliance "just rotate this one secret via env" pattern works
 * regardless of which source initially populated the rest.
 */
export async function loadSecretsAnySource(
  opts: LoadSecretsAnySourceOptions,
): Promise<LoadSecretsAnySourceResult | null> {
  const env = opts.env ?? process.env;

  // 1. Pure env (every required field set).
  const fromEnv = buildSecretsFromEnv(env);
  if (fromEnv) {
    return { secrets: fromEnv, source: 'env' };
  }

  // 2. SOPS file — if it exists, use it. A decrypt/parse failure is
  // surfaced as-is (not silently swallowed into the db fallback) so
  // operators with a misconfigured SOPS setup get a clear error.
  if (await fileExists(opts.sopsPath)) {
    const fromFile = await loadSecrets(opts.sopsPath, {
      env: { ...env, SOPS_AGE_KEY_FILE: opts.ageKeyPath },
    });
    return { secrets: applyEnvOverridesToSecrets(fromFile, env), source: 'sops' };
  }

  // 3. DB-backed (wizard).
  const fromDb = await opts.secretsRepo.get();
  if (fromDb) {
    return { secrets: applyEnvOverridesToSecrets(fromDb, env), source: 'db' };
  }

  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
