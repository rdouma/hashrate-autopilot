import { describe, expect, it, vi } from 'vitest';
import type { BidItem, BidsResponse, BraiinsClient } from '@braiins-hashrate/braiins-client';

import { AccountSpendService } from './account-spend.js';

// Minimal stub: only the `listBids` method matters for this service.
function makeClient(listBids: BraiinsClient['listBids']): BraiinsClient {
  return { listBids } as unknown as BraiinsClient;
}

function bid({
  amount,
  remaining,
  is_current = false,
}: {
  amount: number;
  remaining: number;
  is_current?: boolean;
}): BidItem {
  // Braiins's generated TS type omits amount_sat/is_current (the
  // OpenAPI spec's required list mentions them but the properties
  // block doesn't). Mirror the production cast so the test exercises
  // the same shape the service reads.
  return {
    bid: { amount_sat: amount, is_current } as unknown as BidItem['bid'],
    counters_estimate: {} as unknown as BidItem['counters_estimate'],
    counters_committed: {} as unknown as BidItem['counters_committed'],
    state_estimate: {
      amount_remaining_sat: remaining,
    } as unknown as BidItem['state_estimate'],
  };
}

function pageOf(bids: BidItem[]): BidsResponse {
  return { items: bids };
}

describe('AccountSpendService', () => {
  it('sums amount_sat - amount_remaining_sat across every bid', async () => {
    // Why this formula, not counters_estimate.amount_consumed_sat:
    // empirically the list endpoint returns counters all-zeros even
    // for clearly-consuming bids. The controller already uses this
    // derivation in observe.ts:247.
    const listBids = vi.fn(async () =>
      pageOf([
        bid({ amount: 1000, remaining: 700 }),  // consumed 300
        bid({ amount: 2000, remaining: 0 }),    // consumed 2000 (fulfilled)
      ]),
    );
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(2300);
    expect(snap?.transactions_seen).toBe(2);
  });

  it('splits spend into closed vs active using bid.is_current', async () => {
    const listBids = vi.fn(async () =>
      pageOf([
        bid({ amount: 1000, remaining: 900, is_current: true }),   // active, 100
        bid({ amount: 500, remaining: 0, is_current: false }),     // closed, 500
        bid({ amount: 200, remaining: 150, is_current: true }),    // active, 50
        bid({ amount: 300, remaining: 50, is_current: false }),    // closed, 250
      ]),
    );
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.active_sat).toBe(150);
    expect(snap?.closed_sat).toBe(750);
    expect(snap?.total_settlement_sat).toBe(900);
  });

  it('paginates until a short page is returned', async () => {
    const fullPage = pageOf(
      Array.from({ length: 200 }, () => bid({ amount: 10, remaining: 0 })),
    );
    const partial = pageOf([bid({ amount: 1, remaining: 0 })]);
    const listBids = vi
      .fn<BraiinsClient['listBids']>()
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(partial);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.transactions_seen).toBe(201);
    expect(snap?.total_settlement_sat).toBe(200 * 10 + 1);
    expect(listBids).toHaveBeenCalledTimes(2);
    expect(listBids.mock.calls[1]?.[0]).toMatchObject({ offset: 200 });
  });

  it('stops immediately on an empty first page', async () => {
    const listBids = vi.fn(async () => ({ items: [] }) satisfies BidsResponse);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(0);
    expect(snap?.closed_sat).toBe(0);
    expect(snap?.active_sat).toBe(0);
    expect(listBids).toHaveBeenCalledTimes(1);
  });

  it('treats missing state_estimate as "nothing consumed"', async () => {
    // The list endpoint occasionally omits state_estimate; we should
    // degrade to 0 (not NaN) rather than poison the total.
    const items: BidItem[] = [
      bid({ amount: 500, remaining: 200 }), // consumed 300
      { bid: { amount_sat: 1000, is_current: true } } as unknown as BidItem,
    ];
    const listBids = vi.fn(async () => ({ items }) satisfies BidsResponse);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(300);
    expect(snap?.transactions_seen).toBe(2);
  });

  it('returns null when the API throws, without caching the failure', async () => {
    const listBids = vi.fn<BraiinsClient['listBids']>().mockRejectedValueOnce(new Error('boom'));
    const svc = new AccountSpendService(makeClient(listBids));
    expect(await svc.getLifetimeSpend()).toBeNull();
    // Next call retries (the null result was not cached).
    listBids.mockResolvedValueOnce(pageOf([bid({ amount: 42, remaining: 0 })]));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(42);
  });

  it('caches successful results within the TTL', async () => {
    const listBids = vi.fn(async () => pageOf([bid({ amount: 100, remaining: 0 })]));
    let now = 1_700_000_000_000;
    const svc = new AccountSpendService(makeClient(listBids), {
      cacheTtlMs: 60_000,
      now: () => now,
    });
    await svc.getLifetimeSpend();
    await svc.getLifetimeSpend(); // within TTL, cache hit
    expect(listBids).toHaveBeenCalledTimes(1);
    now += 60_001;
    await svc.getLifetimeSpend(); // TTL expired, refetch
    expect(listBids).toHaveBeenCalledTimes(2);
  });
});
