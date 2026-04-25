import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../state/db.js';
import { SecretsRepo } from '../state/repos/secrets.js';
import { loadSecretsAnySource } from './secret-sources.js';

const PLAINTEXT_SOPS_FILE = `
braiins_owner_token: file-owner-tok
dashboard_password: file-password-12
`.trimStart();

describe('loadSecretsAnySource', () => {
  let handle: DatabaseHandle;
  let secretsRepo: SecretsRepo;
  let tmpDir: string;
  let sopsPath: string;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    secretsRepo = new SecretsRepo(handle.db);
    tmpDir = await mkdtemp(join(tmpdir(), 'secret-sources-test-'));
    sopsPath = join(tmpDir, '.env.sops.yaml');
  });

  afterEach(async () => {
    await closeDatabase(handle);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no source has anything', async () => {
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: {},
    });
    expect(r).toBeNull();
  });

  it('uses pure-env path when both required env vars are set', async () => {
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: {
        BHA_BRAIINS_OWNER_TOKEN: 'env-owner',
        BHA_DASHBOARD_PASSWORD: 'env-password-12',
      },
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('env');
    expect(r!.secrets.braiins_owner_token).toBe('env-owner');
  });

  it('falls back to SOPS file when env is incomplete', async () => {
    await writeFile(sopsPath, PLAINTEXT_SOPS_FILE, 'utf8');
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: { BHA_BRAIINS_OWNER_TOKEN: 'env-owner-only' /* no dashboard_password */ },
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('sops');
    // SOPS file's owner token is preserved, but env override applies on top.
    expect(r!.secrets.braiins_owner_token).toBe('env-owner-only');
    expect(r!.secrets.dashboard_password).toBe('file-password-12');
  });

  it('falls back to db (secrets repo) when no env and no SOPS file', async () => {
    await secretsRepo.upsert({
      braiins_owner_token: 'db-owner',
      dashboard_password: 'db-password-12',
    });
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: {},
    });
    expect(r).not.toBeNull();
    expect(r!.source).toBe('db');
    expect(r!.secrets.braiins_owner_token).toBe('db-owner');
  });

  it('env > sops > db priority', async () => {
    // All three populated; env should win.
    await writeFile(sopsPath, PLAINTEXT_SOPS_FILE, 'utf8');
    await secretsRepo.upsert({
      braiins_owner_token: 'db-owner',
      dashboard_password: 'db-password-12',
    });
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: {
        BHA_BRAIINS_OWNER_TOKEN: 'env-owner',
        BHA_DASHBOARD_PASSWORD: 'env-password-12',
      },
    });
    expect(r!.source).toBe('env');
    expect(r!.secrets.braiins_owner_token).toBe('env-owner');
  });

  it('sops > db when env is incomplete', async () => {
    await writeFile(sopsPath, PLAINTEXT_SOPS_FILE, 'utf8');
    await secretsRepo.upsert({
      braiins_owner_token: 'db-owner',
      dashboard_password: 'db-password-12',
    });
    const r = await loadSecretsAnySource({
      sopsPath,
      ageKeyPath: '/nonexistent/age.key',
      secretsRepo,
      env: {},
    });
    expect(r!.source).toBe('sops');
    expect(r!.secrets.braiins_owner_token).toBe('file-owner-tok');
  });
});
