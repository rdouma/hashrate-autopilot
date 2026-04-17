import { describe, expect, it } from 'vitest';

import { createOceanClient } from './ocean.js';

// Fixtures matching the real api.ocean.xyz/v1/ JSON responses
// captured 2026-04-16.

const STATSNAP = {
  result: {
    unpaid: '0.00385090',
    estimated_earn_next_block: '0.00028745',
    estimated_total_earn_next_block: '0.00028745',
    shares_in_tides: '103027310592',
  },
};

const USER_HASHRATE = {
  result: {
    hashrate_10800s: '1849290596989010',
    active_worker_count: 1,
  },
};

const POOL_STAT = {
  result: {
    network_difficulty: '138966872071213.02',
    current_tides_shares: '1111734976569704',
    current_estimated_block_reward: '3.13312160',
  },
};

function fakeApiFetch(overrides: Record<string, unknown> = {}): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    let body: unknown;
    if (u.includes('/statsnap/')) body = overrides['statsnap'] ?? STATSNAP;
    else if (u.includes('/user_hashrate/')) body = overrides['hashrate'] ?? USER_HASHRATE;
    else if (u.includes('/pool_stat')) body = overrides['pool'] ?? POOL_STAT;
    else return { ok: false, status: 404, json: async () => ({}) } as Response;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('OceanClient (JSON API)', () => {
  it('parses unpaid earnings from statsnap', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats).not.toBeNull();
    expect(stats!.unpaid_sat).toBe(385_090);
  });

  it('parses estimated next-block earnings', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.next_block_sat).toBe(28_745);
  });

  it('computes share log percentage from user + pool shares', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.share_log_pct).toBeGreaterThan(0);
    expect(stats!.share_log_pct).toBeLessThan(1);
  });

  it('computes daily estimate from hashrate + network difficulty', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.daily_estimate_sat).toBeGreaterThan(0);
  });

  it('computes time-to-payout from unpaid + daily rate', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.time_to_payout_text).toMatch(/^\d+ (days|hours)$/);
  });

  it('returns null on HTTP failure', async () => {
    const client = createOceanClient({
      fetch: (async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    });
    expect(await client.fetchStats('bc1qaddress')).toBeNull();
  });

  it('caches results within the TTL', async () => {
    let calls = 0;
    const client = createOceanClient({
      fetch: (async (url: string) => {
        calls++;
        const f = fakeApiFetch();
        return f(url, {} as RequestInit);
      }) as unknown as typeof fetch,
      cacheTtlMs: 60_000,
      now: () => 1_700_000_000_000,
    });
    await client.fetchStats('bc1qaddress');
    const callsAfterFirst = calls;
    await client.fetchStats('bc1qaddress');
    expect(calls).toBe(callsAfterFirst);
  });

  it('lifetime_sat is null (not available via JSON API)', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.lifetime_sat).toBeNull();
  });

  it('reports payout threshold', async () => {
    const client = createOceanClient({ fetch: fakeApiFetch() });
    const stats = await client.fetchStats('bc1qaddress');
    expect(stats!.payout_threshold_sat).toBe(1_048_576);
  });
});
