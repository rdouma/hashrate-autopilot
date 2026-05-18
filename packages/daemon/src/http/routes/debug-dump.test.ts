/**
 * Unit tests for GET /api/debug/dump route.
 */

import { describe, it, expect, vi } from 'vitest';

import { registerDebugDumpRoute, type DebugDumpDeps } from './debug-dump.js';

// Minimal mock types to exercise the route logic.

function mockDb(overrides?: Partial<{
  tick_metrics: unknown[];
  pool_blocks: unknown[];
  alerts: unknown[];
  bid_events: unknown[];
  reward_events: unknown[];
  runtime_state: unknown;
}>) {
  const tick_metrics = overrides?.tick_metrics ?? [];
  const pool_blocks = overrides?.pool_blocks ?? [];
  const alerts = overrides?.alerts ?? [];
  const bid_events = overrides?.bid_events ?? [];
  const reward_events = overrides?.reward_events ?? [];

  // Simulate Kysely's fluent query builder
  function makeQueryBuilder(rows: unknown[]) {
    const builder: any = {
      selectAll: () => builder,
      select: () => builder,
      where: () => builder,
      orderBy: () => builder,
      execute: () => Promise.resolve(rows),
    };
    return builder;
  }

  const db: any = {
    selectFrom: (table: string) => {
      switch (table) {
        case 'tick_metrics': return makeQueryBuilder(tick_metrics);
        case 'pool_blocks': return makeQueryBuilder(pool_blocks);
        case 'alerts': return makeQueryBuilder(alerts);
        case 'bid_events': return makeQueryBuilder(bid_events);
        case 'reward_events': return makeQueryBuilder(reward_events);
        default: return makeQueryBuilder([]);
      }
    },
  };

  return db;
}

function mockConfigRepo(config?: Record<string, unknown> | null) {
  return {
    get: vi.fn().mockResolvedValue(config ?? {
      target_hashrate_ph: 2.0,
      telegram_bot_token: 'secret-token-123',
      telegram_chat_id: '-100123456',
      bitcoind_rpc_password: 'super-secret',
      bitcoind_rpc_user: 'rpcuser',
      bitcoind_rpc_url: 'http://10.0.0.1:8332',
      ddns_credential: 'my-ddns-key',
      ddns_username: 'ddnsuser',
      block_found_sound_custom_blob: Buffer.from('fake-mp3'),
      overpay_sat_per_eh_day: 500,
    }),
    upsert: vi.fn(),
  };
}

// Minimal Fastify mock
function mockFastify() {
  const routes: Map<string, Function> = new Map();
  return {
    get: (path: string, handler: Function) => {
      routes.set(path, handler);
    },
    _routes: routes,
    _callRoute: async (path: string, query: Record<string, string> = {}) => {
      const handler = routes.get(path);
      if (!handler) throw new Error(`No route registered for ${path}`);
      return handler({ query });
    },
  } as any;
}

describe('GET /api/debug/dump', () => {
  it('registers the route', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    expect(app._routes.has('/api/debug/dump')).toBe(true);
  });

  it('returns all tables by default', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb({ tick_metrics: [{ id: 1, tick_at: Date.now() }] }),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', {});

    expect(result.hours).toBe(24);
    expect(result.tables_included).toContain('tick_metrics');
    expect(result.tables_included).toContain('app_config');
    expect(result.tables_included).toContain('daemon_info');
    expect(result.generated_at).toBeDefined();
    expect(result.generated_at_ms).toBeGreaterThan(0);
  });

  it('respects hours parameter', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', { hours: '48' });

    expect(result.hours).toBe(48);
  });

  it('clamps hours to max 168', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', { hours: '9999' });

    expect(result.hours).toBe(168);
  });

  it('clamps hours to min 1', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', { hours: '0' });

    expect(result.hours).toBe(1);
  });

  it('filters tables when ?tables= is provided', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', {
      tables: 'tick_metrics,bid_events',
    });

    expect(result.tables_included).toEqual(['tick_metrics', 'bid_events']);
    expect(result.tick_metrics).toBeDefined();
    expect(result.bid_events).toBeDefined();
    expect(result.app_config).toBeUndefined();
    expect(result.daemon_info).toBeUndefined();
  });

  it('redacts sensitive config fields', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', {
      tables: 'app_config',
    });

    expect(result.app_config.telegram_bot_token).toBe('[REDACTED]');
    expect(result.app_config.telegram_chat_id).toBe('[REDACTED]');
    expect(result.app_config.bitcoind_rpc_password).toBe('[REDACTED]');
    expect(result.app_config.bitcoind_rpc_user).toBe('[REDACTED]');
    expect(result.app_config.bitcoind_rpc_url).toBe('[REDACTED]');
    expect(result.app_config.ddns_credential).toBe('[REDACTED]');
    expect(result.app_config.ddns_username).toBe('[REDACTED]');
    expect(result.app_config.block_found_sound_custom_blob).toBe('[REDACTED]');
    // Non-sensitive fields pass through
    expect(result.app_config.target_hashrate_ph).toBe(2.0);
    expect(result.app_config.overpay_sat_per_eh_day).toBe(500);
  });

  it('ignores invalid table names in filter', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', {
      tables: 'tick_metrics,nonexistent,bid_events',
    });

    expect(result.tables_included).toEqual(['tick_metrics', 'bid_events']);
  });

  it('defaults to all tables when filter is empty string', async () => {
    const app = mockFastify();
    const deps: DebugDumpDeps = {
      db: mockDb(),
      configRepo: mockConfigRepo() as any,
    };
    await registerDebugDumpRoute(app, deps);
    const result = await app._callRoute('/api/debug/dump', { tables: '' });

    expect(result.tables_included.length).toBe(7);
  });
});
