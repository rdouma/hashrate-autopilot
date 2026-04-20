import { describe, expect, it, vi } from 'vitest';

import { HashpriceCache } from './hashprice-cache.js';
import { HashpriceRefresher } from './hashprice-refresher.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { OceanClient, OceanStats } from './ocean.js';

function makeOcean(hashprice: number | null | 'throw'): OceanClient {
  return {
    fetchStats: vi.fn(async () => {
      if (hashprice === 'throw') throw new Error('ocean down');
      return {
        hashprice_sat_per_ph_day: hashprice,
      } as unknown as OceanStats;
    }),
    fetchPoolInfo: vi.fn(async () => null),
    fetchBlocks: vi.fn(async () => []),
    fetchEarningsHistory: vi.fn(async () => []),
  } as unknown as OceanClient;
}

function makeConfigRepo(overrides: {
  btc_payout_address?: string | null;
  max_overpay_vs_hashprice_sat_per_eh_day?: number | null;
} = {}): ConfigRepo {
  const cfg = {
    btc_payout_address: 'bc1qaddress' as string | null,
    max_overpay_vs_hashprice_sat_per_eh_day: 2_000_000 as number | null,
    ...overrides,
  };
  return {
    get: vi.fn(async () => cfg),
  } as unknown as ConfigRepo;
}

describe('HashpriceRefresher', () => {
  it('writes hashprice to the cache when Ocean returns a value', async () => {
    const cache = new HashpriceCache();
    const ocean = makeOcean(46_500);
    const refresher = new HashpriceRefresher(makeConfigRepo(), ocean, cache);
    await refresher.runOnce();
    expect(cache.peek()?.value).toBe(46_500);
  });

  it('no-ops when payout address is missing (no dynamic cap reference point)', async () => {
    const cache = new HashpriceCache();
    const ocean = makeOcean(46_500);
    const refresher = new HashpriceRefresher(
      makeConfigRepo({ btc_payout_address: null }),
      ocean,
      cache,
    );
    await refresher.runOnce();
    expect(ocean.fetchStats).not.toHaveBeenCalled();
    expect(cache.peek()).toBeNull();
  });

  it('no-ops when the operator has not configured the dynamic cap', async () => {
    const cache = new HashpriceCache();
    const ocean = makeOcean(46_500);
    const refresher = new HashpriceRefresher(
      makeConfigRepo({ max_overpay_vs_hashprice_sat_per_eh_day: null }),
      ocean,
      cache,
    );
    await refresher.runOnce();
    expect(ocean.fetchStats).not.toHaveBeenCalled();
  });

  it('leaves the existing cached value alone when Ocean returns null', async () => {
    const cache = new HashpriceCache();
    cache.set(46_000);
    const ocean = makeOcean(null);
    const log = vi.fn();
    const refresher = new HashpriceRefresher(makeConfigRepo(), ocean, cache, { log });
    await refresher.runOnce();
    expect(cache.peek()?.value).toBe(46_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no hashprice'));
  });

  it('leaves the existing cached value alone when Ocean throws', async () => {
    const cache = new HashpriceCache();
    cache.set(46_000);
    const ocean = makeOcean('throw');
    const log = vi.fn();
    const refresher = new HashpriceRefresher(makeConfigRepo(), ocean, cache, { log });
    await refresher.runOnce();
    expect(cache.peek()?.value).toBe(46_000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fetch failed'));
  });

  it('start() installs an interval timer; stop() clears it', () => {
    const setIntervalFn = vi.fn(() => 'handle' as unknown as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const cache = new HashpriceCache();
    const refresher = new HashpriceRefresher(
      makeConfigRepo(),
      makeOcean(46_500),
      cache,
      { setInterval: setIntervalFn, clearInterval: clearIntervalFn, intervalMs: 123_456 },
    );
    refresher.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0]?.[1]).toBe(123_456);
    refresher.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith('handle');
  });
});
