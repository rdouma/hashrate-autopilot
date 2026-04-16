import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
import { isSopsEncrypted, loadSecrets } from './secrets.js';

const VALID_YAML = `braiins_owner_token: owner_xyz
braiins_read_only_token: reader_xyz
telegram_bot_token: 123:bot-token
telegram_webhook_secret: webhook-secret
bitcoind_rpc_url: http://127.0.0.1:8332
bitcoind_rpc_user: rpcuser
bitcoind_rpc_password: rpcpass
dashboard_password: hunter2
`;

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'braiins-secrets-test-'));
});

afterAll(async () => {
  // Not cleaning up — small test files, OS reaps the tmpdir on reboot.
});

describe('isSopsEncrypted', () => {
  it('returns false for plaintext YAML', () => {
    expect(isSopsEncrypted(VALID_YAML)).toBe(false);
  });

  it('returns true when the sops mapping marker is present', () => {
    const encrypted = `${VALID_YAML}sops:\n  version: 3.12.2\n`;
    expect(isSopsEncrypted(encrypted)).toBe(true);
  });

  it('does not false-positive on keys containing the substring "sops"', () => {
    const yaml = `sops_config_path: "/etc/sops.yaml"\n`;
    expect(isSopsEncrypted(yaml)).toBe(false);
  });
});

describe('loadSecrets — plaintext path', () => {
  it('loads and validates a valid plaintext secrets file', async () => {
    const path = join(tmp, 'valid.yaml');
    await writeFile(path, VALID_YAML, 'utf8');
    const secrets = await loadSecrets(path);
    expect(secrets.braiins_owner_token).toBe('owner_xyz');
    expect(secrets.braiins_read_only_token).toBe('reader_xyz');
  });

  it('throws FILE_NOT_FOUND for a missing file', async () => {
    const path = join(tmp, 'does-not-exist.yaml');
    await expect(loadSecrets(path)).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'FILE_NOT_FOUND',
    });
  });

  it('throws YAML_PARSE_FAILED for malformed YAML', async () => {
    const path = join(tmp, 'malformed.yaml');
    await writeFile(path, ':::not yaml:::\n\t\t\t- broken', 'utf8');
    await expect(loadSecrets(path)).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'YAML_PARSE_FAILED',
    });
  });

  it('throws SCHEMA_VALIDATION_FAILED when required fields are missing', async () => {
    const path = join(tmp, 'incomplete.yaml');
    await writeFile(path, 'braiins_owner_token: only-this\n', 'utf8');
    await expect(loadSecrets(path)).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'SCHEMA_VALIDATION_FAILED',
    });
    // The details should enumerate the missing fields
    try {
      await loadSecrets(path);
    } catch (err) {
      const e = err as ConfigError;
      expect(e.details).toMatch(/telegram_bot_token/);
      expect(e.details).toMatch(/bitcoind_rpc_url/);
    }
  });
});

describe('loadSecrets — sops path', () => {
  it('reports SOPS_NOT_INSTALLED when the binary cannot be spawned', async () => {
    const path = join(tmp, 'encrypted.yaml');
    // Produce a file that LOOKS sops-encrypted by the content sniff:
    await writeFile(path, `${VALID_YAML}sops:\n  version: 3.12.2\n`, 'utf8');
    await expect(
      loadSecrets(path, { sopsBin: '/definitely/does/not/exist/sops' }),
    ).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'SOPS_NOT_INSTALLED',
    });
  });

  it('reports SOPS_DECRYPT_FAILED when sops exits non-zero', async () => {
    const path = join(tmp, 'encrypted2.yaml');
    await writeFile(path, `${VALID_YAML}sops:\n  version: 3.12.2\n`, 'utf8');
    // Use `false(1)` — always exits 1 — as a stand-in for "sops failed".
    await expect(loadSecrets(path, { sopsBin: '/usr/bin/false' })).rejects.toMatchObject({
      name: 'ConfigError',
      code: 'SOPS_DECRYPT_FAILED',
    });
  });
});
