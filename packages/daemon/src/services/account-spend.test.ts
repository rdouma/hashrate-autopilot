import { describe, expect, it, vi } from 'vitest';
import type { BidItem, BidsResponse, BraiinsClient } from '@braiins-hashrate/braiins-client';

import { AccountSpendService } from './account-spend.js';

// Minimal stub: only the `listBids` method matters for this service.
function makeClient(listBids: BraiinsClient['listBids']): BraiinsClient {
  return { listBids } as unknown as BraiinsClient;
}

function bid(consumed: number): BidItem {
  return {
    bid: {} as unknown as BidItem['bid'],
    counters_estimate: {
      shares_purchased_m: 0,
      shares_accepted_m: 0,
      shares_rejected_m: 0,
      fee_paid_sat: 0,
      amount_consumed_sat: consumed,
    },
    counters_committed: {
      shares_purchased_m: 0,
      shares_accepted_m: 0,
      shares_rejected_m: 0,
      fee_paid_sat: 0,
      amount_consumed_sat: consumed,
    },
    state_estimate: {} as unknown as BidItem['state_estimate'],
  };
}

function pageOf(consumedAmounts: number[]): BidsResponse {
  return { items: consumedAmounts.map(bid) };
}

describe('AccountSpendService', () => {
  it('sums counters_estimate.amount_consumed_sat across every bid in a single page', async () => {
    const listBids = vi.fn(async () => pageOf([100, 200, 300]));
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(600);
    expect(snap?.transactions_seen).toBe(3);
    expect(listBids).toHaveBeenCalledTimes(1);
  });

  it('paginates until a short page is returned', async () => {
    // Two full 200-item pages, then a partial — short page signals EOF.
    const full = pageOf(Array.from({ length: 200 }, () => 10));
    const partial = pageOf([1, 2, 3]);
    const listBids = vi
      .fn<BraiinsClient['listBids']>()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce(partial);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.transactions_seen).toBe(403);
    expect(snap?.total_settlement_sat).toBe(200 * 10 + 200 * 10 + 1 + 2 + 3);
    expect(listBids).toHaveBeenCalledTimes(3);
    // Verify the offset advances correctly.
    expect(listBids.mock.calls[1]?.[0]).toMatchObject({ offset: 200 });
    expect(listBids.mock.calls[2]?.[0]).toMatchObject({ offset: 400 });
  });

  it('stops immediately on an empty first page', async () => {
    const listBids = vi.fn(async () => ({ items: [] }) satisfies BidsResponse);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(0);
    expect(snap?.transactions_seen).toBe(0);
    expect(listBids).toHaveBeenCalledTimes(1);
  });

  it('ignores non-finite / negative counters', async () => {
    // Braiins returns counters as string-serialisable "Double"s —
    // defensive parse should tolerate a bogus value without NaN-poisoning
    // the whole total.
    const items = [bid(100), bid(200)];
    items.push({ ...bid(0), counters_estimate: { ...bid(0).counters_estimate, amount_consumed_sat: Number.NaN } });
    items.push({ ...bid(0), counters_estimate: { ...bid(0).counters_estimate, amount_consumed_sat: -50 } });
    const listBids = vi.fn(async () => ({ items }) satisfies BidsResponse);
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(300);
    expect(snap?.transactions_seen).toBe(4);
  });

  it('returns null when the API throws, without caching the failure', async () => {
    const listBids = vi.fn<BraiinsClient['listBids']>().mockRejectedValueOnce(new Error('boom'));
    const svc = new AccountSpendService(makeClient(listBids));
    expect(await svc.getLifetimeSpend()).toBeNull();
    // Next call retries (the null result was not cached).
    listBids.mockResolvedValueOnce(pageOf([42]));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(42);
  });

  it('caches successful results within the TTL', async () => {
    const listBids = vi.fn(async () => pageOf([100]));
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
