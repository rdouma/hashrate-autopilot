import { describe, expect, it, vi } from 'vitest';

import type { BraiinsClient, MarketSettings } from '@braiins-hashrate/braiins-client';

import { BraiinsService } from './braiins-service.js';

const SETTINGS_FIXTURE = { status: 'SPOT_INSTRUMENT_STATUS_ACTIVE', tick_size_sat: 1000 } as unknown as MarketSettings;

function makeClient(overrides: Partial<BraiinsClient> = {}): BraiinsClient {
  return {
    getStats: vi.fn().mockResolvedValue({ status: 'SPOT_INSTRUMENT_STATUS_ACTIVE' }),
    getOrderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getSettings: vi.fn().mockResolvedValue(SETTINGS_FIXTURE),
    getFee: vi.fn().mockResolvedValue({ spot_fees: [] }),
    getBalance: vi.fn().mockResolvedValue({ accounts: [] }),
    getCurrentBids: vi.fn().mockResolvedValue({ items: [] }),
    getBidDetail: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as BraiinsClient;
}

describe('BraiinsService — metadata cache', () => {
  it('fetches settings on first call', async () => {
    const client = makeClient();
    const svc = new BraiinsService({ client, now: () => 1_000_000 });
    await svc.getSettings();
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  it('returns cached settings within the TTL', async () => {
    const client = makeClient();
    const now = vi.fn<() => number>();
    now.mockReturnValue(1_000_000);
    const svc = new BraiinsService({ client, settingsTtlMs: 60_000, feeTtlMs: 60_000, now });
    await svc.getSettings();
    now.mockReturnValue(1_030_000); // +30s, inside TTL
    await svc.getSettings();
    expect(client.getSettings).toHaveBeenCalledTimes(1);
  });

  it('refetches settings past the TTL', async () => {
    const client = makeClient();
    const now = vi.fn<() => number>();
    now.mockReturnValue(1_000_000);
    const svc = new BraiinsService({ client, settingsTtlMs: 60_000, feeTtlMs: 60_000, now });
    await svc.getSettings();
    now.mockReturnValue(1_000_000 + 61_000); // just past TTL
    await svc.getSettings();
    expect(client.getSettings).toHaveBeenCalledTimes(2);
  });

  it('invalidateMetadataCaches forces a refetch', async () => {
    const client = makeClient();
    const svc = new BraiinsService({ client });
    await svc.getSettings();
    svc.invalidateMetadataCaches();
    await svc.getSettings();
    expect(client.getSettings).toHaveBeenCalledTimes(2);
  });
});

describe('BraiinsService — last-OK tracking', () => {
  it('records the wall-clock time of the last successful read', async () => {
    const client = makeClient();
    const svc = new BraiinsService({ client, now: () => 1_234_567 });
    expect(svc.getLastApiOkAt()).toBeNull();
    await svc.getStats();
    expect(svc.getLastApiOkAt()).toBe(1_234_567);
  });

  it('does not update the timestamp on failure', async () => {
    const client = makeClient({
      getStats: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const svc = new BraiinsService({ client, now: () => 2_000_000 });
    await expect(svc.getStats()).rejects.toThrow('boom');
    expect(svc.getLastApiOkAt()).toBeNull();
  });
});
