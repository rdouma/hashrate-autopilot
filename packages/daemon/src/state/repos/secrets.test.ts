import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Secrets } from '../../config/schema.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { SecretsRepo } from './secrets.js';

const VALID: Secrets = {
  braiins_owner_token: 'owner-tok',
  dashboard_password: 'pw-12345678',
};

describe('SecretsRepo', () => {
  let handle: DatabaseHandle;
  let repo: SecretsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new SecretsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('returns null when no row exists', async () => {
    expect(await repo.get()).toBeNull();
    expect(await repo.exists()).toBe(false);
  });

  it('round-trips a minimum-valid secrets row', async () => {
    await repo.upsert(VALID);
    expect(await repo.exists()).toBe(true);
    const out = await repo.get();
    expect(out).toEqual(VALID);
  });

  it('round-trips a fully-populated secrets row', async () => {
    const full: Secrets = {
      braiins_owner_token: 'owner-tok',
      braiins_read_only_token: 'reader-tok',
      dashboard_password: 'pw-12345678',
      bitcoind_rpc_url: 'http://10.0.0.1:8332',
      bitcoind_rpc_user: 'rpc-user',
      bitcoind_rpc_password: 'rpc-pass',
    };
    await repo.upsert(full);
    expect(await repo.get()).toEqual(full);
  });

  it('upsert is idempotent - replaces the existing row', async () => {
    await repo.upsert(VALID);
    await repo.upsert({ ...VALID, dashboard_password: 'new-pw-1234' });
    const out = await repo.get();
    expect(out!.dashboard_password).toBe('new-pw-1234');
    // Still exactly one row.
    const count = handle.raw
      .prepare('SELECT COUNT(*) as c FROM secrets')
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('rejects an invalid input via schema validation', async () => {
    await expect(
      repo.upsert({ ...VALID, braiins_owner_token: '' } as Secrets),
    ).rejects.toThrow();
  });
});
