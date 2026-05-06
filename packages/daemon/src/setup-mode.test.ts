import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigRepo } from './state/repos/config.js';
import { SecretsRepo } from './state/repos/secrets.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from './state/db.js';
import {
  createSetupModeServer,
  detectBitcoindEnv,
  type SetupModeServer,
} from './setup-mode.js';
import { APP_CONFIG_DEFAULTS } from './config/schema.js';

function validSetupPayload() {
  return {
    config: {
      ...APP_CONFIG_DEFAULTS,
      destination_pool_url: 'stratum+tcp://datum.local:23334',
      destination_pool_worker_name: 'bc1qexample.rig1',
      btc_payout_address: 'bc1qexample',
    },
    secrets: {
      braiins_owner_token: 'owner-tok',
      dashboard_password: 'pw-12345678',
    },
  };
}

describe('createSetupModeServer', () => {
  let handle: DatabaseHandle;
  let configRepo: ConfigRepo;
  let secretsRepo: SecretsRepo;
  let server: SetupModeServer;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    configRepo = new ConfigRepo(handle.db);
    secretsRepo = new SecretsRepo(handle.db);
    server = await createSetupModeServer({
      configRepo,
      secretsRepo,
      // No-op exit so the timer-driven process.exit(0) doesn't tear
      // down the test runner.
      onSetupComplete: () => {},
    });
    await server.app.ready();
  });

  afterEach(async () => {
    await server.stop();
    await closeDatabase(handle);
  });

  it('GET /api/health returns NEEDS_SETUP mode without auth', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', mode: 'NEEDS_SETUP' });
  });

  it('GET /api/setup-info exposes defaults and existing flags (no row yet)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/setup-info' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      has_existing_config: boolean;
      has_existing_secrets: boolean;
      defaults: { target_hashrate_ph: number; destination_pool_url: string };
      current_config: unknown;
    };
    expect(body.has_existing_config).toBe(false);
    expect(body.has_existing_secrets).toBe(false);
    expect(body.defaults.target_hashrate_ph).toBe(APP_CONFIG_DEFAULTS.target_hashrate_ph);
    expect(body.defaults.destination_pool_url).toBe('stratum+tcp://datum.local:23334');
    expect(body.current_config).toBeNull();
  });

  it('GET /api/setup-info reports existing config when one exists', async () => {
    await configRepo.upsert(validSetupPayload().config);
    const res = await server.app.inject({ method: 'GET', url: '/api/setup-info' });
    const body = res.json() as { has_existing_config: boolean; current_config: unknown };
    expect(body.has_existing_config).toBe(true);
    expect(body.current_config).not.toBeNull();
  });

  it('POST /api/setup writes config + secrets and returns 200', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: validSetupPayload(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const cfg = await configRepo.get();
    expect(cfg).not.toBeNull();
    expect(cfg!.btc_payout_address).toBe('bc1qexample');
    const secrets = await secretsRepo.get();
    expect(secrets).not.toBeNull();
    expect(secrets!.braiins_owner_token).toBe('owner-tok');
  });

  it('POST /api/setup invokes onSetupComplete after a successful write', async () => {
    let called = false;
    const ad = await openDatabase({ path: ':memory:' });
    const cr = new ConfigRepo(ad.db);
    const sr = new SecretsRepo(ad.db);
    const s = await createSetupModeServer({
      configRepo: cr,
      secretsRepo: sr,
      onSetupComplete: () => {
        called = true;
      },
    });
    try {
      await s.app.ready();
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: validSetupPayload(),
      });
      expect(res.statusCode).toBe(200);
      expect(called).toBe(true);
    } finally {
      await s.stop();
      await closeDatabase(ad);
    }
  });

  it('does NOT invoke onSetupComplete on a malformed payload', async () => {
    let called = false;
    const ad = await openDatabase({ path: ':memory:' });
    const cr = new ConfigRepo(ad.db);
    const sr = new SecretsRepo(ad.db);
    const s = await createSetupModeServer({
      configRepo: cr,
      secretsRepo: sr,
      onSetupComplete: () => {
        called = true;
      },
    });
    try {
      await s.app.ready();
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { config: {}, secrets: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(called).toBe(false);
    } finally {
      await s.stop();
      await closeDatabase(ad);
    }
  });

  it('POST /api/setup rejects malformed payload with 400 + Zod error details', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        config: { target_hashrate_ph: -1 }, // missing required fields, negative
        secrets: { braiins_owner_token: '' }, // empty
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; details: unknown[] };
    expect(body.error).toBe('invalid_setup_payload');
    expect(body.details.length).toBeGreaterThan(0);
  });

  it('POST /api/setup rejects floor > target invariant', async () => {
    const payload = validSetupPayload();
    payload.config.minimum_floor_hashrate_ph = 99;
    payload.config.target_hashrate_ph = 1;
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/setup',
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 412 + needs_setup on any unrecognised /api/* path', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/status',
    });
    expect(res.statusCode).toBe(412);
    expect(res.json()).toEqual({ error: 'needs_setup', needs_setup: true });
  });

  it('returns 412 on /api/config/whatever (not just exact paths)', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(412);
  });

  it('non-/api paths get the SPA fallback (404 since no static root)', async () => {
    // No staticRoot configured for these tests, so the SPA fallback's
    // sendFile fails - but the handler should still NOT return 412
    // for non-/api paths. We expect a 5xx from the missing static
    // file rather than the 412 from the API gate.
    const res = await server.app.inject({ method: 'GET', url: '/setup' });
    expect(res.statusCode).not.toBe(412);
  });
});

describe('detectBitcoindEnv', () => {
  it('returns all-null when no env vars are set', () => {
    expect(detectBitcoindEnv({})).toEqual({ url: null, user: null, password: null });
  });

  it('uses BITCOIN_RPC_URL when present', () => {
    expect(
      detectBitcoindEnv({ BITCOIN_RPC_URL: 'http://10.0.0.1:8332' }),
    ).toEqual({ url: 'http://10.0.0.1:8332', user: null, password: null });
  });

  it('synthesises URL from BITCOIN_RPC_HOST + BITCOIN_RPC_PORT when URL is absent', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_HOST: '10.21.21.8',
        BITCOIN_RPC_PORT: '8332',
      }),
    ).toEqual({ url: 'http://10.21.21.8:8332', user: null, password: null });
  });

  it('host alone (no port) does not synthesise a URL', () => {
    expect(
      detectBitcoindEnv({ BITCOIN_RPC_HOST: '10.21.21.8' }),
    ).toEqual({ url: null, user: null, password: null });
  });

  it('explicit URL wins over the host+port pair', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://from-url:18332',
        BITCOIN_RPC_HOST: 'ignored',
        BITCOIN_RPC_PORT: '8332',
      }),
    ).toEqual({ url: 'http://from-url:18332', user: null, password: null });
  });

  it('captures user + password', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://10.0.0.1:8332',
        BITCOIN_RPC_USER: 'alice',
        BITCOIN_RPC_PASSWORD: 'secret',
      }),
    ).toEqual({
      url: 'http://10.0.0.1:8332',
      user: 'alice',
      password: 'secret',
    });
  });

  it('accepts BITCOIN_RPC_PASS as a synonym for BITCOIN_RPC_PASSWORD', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: 'http://10.0.0.1:8332',
        BITCOIN_RPC_PASS: 'pass-via-PASS',
      }),
    ).toEqual({
      url: 'http://10.0.0.1:8332',
      user: null,
      password: 'pass-via-PASS',
    });
  });

  it('whitespace-only values are treated as missing', () => {
    expect(
      detectBitcoindEnv({
        BITCOIN_RPC_URL: '   ',
        BITCOIN_RPC_USER: '\t\n',
      }),
    ).toEqual({ url: null, user: null, password: null });
  });
});
