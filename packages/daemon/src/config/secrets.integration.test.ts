/**
 * End-to-end round-trip test exercising the real sops + age toolchain.
 *
 * Skipped automatically when either CLI is missing from PATH so the suite
 * still works in environments without them (CI bare images etc.).
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import { loadSecrets } from './secrets.js';
import type { Secrets } from './schema.js';

const SAMPLE: Secrets = {
  braiins_owner_token: 'owner_xyz',
  braiins_read_only_token: 'reader_xyz',
  telegram_bot_token: '123:bot-token',
  telegram_webhook_secret: 'webhook-secret',
  bitcoind_rpc_url: 'http://127.0.0.1:8332',
  bitcoind_rpc_user: 'rpcuser',
  bitcoind_rpc_password: 'rpcpass',
  dashboard_password: 'hunter2dashboardpw',
};

function haveBinary(name: string): boolean {
  const res = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return !res.error && res.status === 0;
}

const needsTools = describe.skipIf(!haveBinary('sops') || !haveBinary('age-keygen'));

needsTools('loadSecrets — sops+age round-trip', () => {
  it('encrypts with age, decrypts via loadSecrets, yields the original payload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'braiins-sops-e2e-'));
    const keyPath = join(dir, 'age.key');
    const policyPath = join(dir, '.sops.yaml');
    const secretsPath = join(dir, '.env.sops.yaml');

    // 1. Generate age key
    const keygen = spawnSync('age-keygen', ['-o', keyPath], { encoding: 'utf8' });
    expect(keygen.status).toBe(0);

    // 2. Extract public key and write sops policy
    const keyFileContents = await readFile(keyPath, 'utf8');
    const pubMatch = keyFileContents.match(/^#\s*public key:\s*(age1[0-9a-z]+)/m);
    expect(pubMatch?.[1]).toBeDefined();
    const pubKey = pubMatch![1]!;

    const policy = `creation_rules:
  - path_regex: \\.env\\.sops\\.ya?ml$
    age: ${pubKey}
`;
    await writeFile(policyPath, policy, 'utf8');

    // 3. Write plaintext YAML
    await writeFile(secretsPath, stringifyYaml(SAMPLE), 'utf8');

    // 4. Encrypt in place with sops
    const enc = spawnSync('sops', ['-e', '-i', secretsPath], {
      encoding: 'utf8',
      cwd: dir, // so sops finds the .sops.yaml policy
      env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath },
    });
    expect(enc.status, `sops -e -i failed: ${enc.stderr}`).toBe(0);

    // Sanity check: the file is now sops-encrypted
    const encryptedContent = await readFile(secretsPath, 'utf8');
    expect(encryptedContent).toMatch(/^sops:\s*$/m);
    expect(encryptedContent).not.toContain('owner_xyz');

    // 5. Decrypt via loadSecrets
    const loaded = await loadSecrets(secretsPath, {
      env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath },
    });

    // 6. Values round-trip
    expect(loaded).toEqual(SAMPLE);
  });
});
