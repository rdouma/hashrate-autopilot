import { describe, expect, it, vi } from 'vitest';
import type { BidItem, BidsResponse, BraiinsClient } from '@braiins-hashrate/braiins-client';

import { AccountSpendService } from './account-spend.js';

// Minimal stub: only the `listBids` method matters for this service.
function makeClient(listBids: BraiinsClient['listBids']): BraiinsClient {
  return { listBids } as unknown as BraiinsClient;
}

function bid({
  consumed,
  is_current = false,
}: {
  consumed: number;
  is_current?: boolean;
}): BidItem {
  // Mirror the shape the real list endpoint returns, per the daemon
  // log sample 2026-04-19: only `counters_committed` is populated on
  // /spot/bid — `counters_estimate` and `state_estimate` are absent.
  return {
    bid: { is_current } as unknown as BidItem['bid'],
    counters_committed: {
      shares_purchased_m: 0,
      shares_accepted_m: 0,
      shares_rejected_m: 0,
      fee_paid_sat: 0,
      amount_consumed_sat: consumed,
    } as unknown as BidItem['counters_committed'],
  } as unknown as BidItem;
}

function pageOf(bids: BidItem[]): BidsResponse {
  return { items: bids };
}

describe('AccountSpendService', () => {
  it('sums counters_committed.amount_consumed_sat across every bid', async () => {
    const listBids = vi.fn(async () =>
      pageOf([bid({ consumed: 300 }), bid({ consumed: 2000 })]),
    );
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(2300);
    expect(snap?.transactions_seen).toBe(2);
  });

  it('splits spend into closed vs active using bid.is_current', async () => {
    const listBids = vi.fn(async () =>
      pageOf([
        bid({ consumed: 100, is_current: true }),   // active
        bid({ consumed: 500, is_current: false }),  // closed
        bid({ consumed: 50, is_current: true }),    // active
        bid({ consumed: 250, is_current: false }),  // closed
      ]),
    );
    const svc = new AccountSpendService(makeClient(listBids));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.active_sat).toBe(150);
    expect(snap?.closed_sat).toBe(750);
    expect(snap?.total_settlement_sat).toBe(900);
  });

  it('paginates until a short page is returned', async () => {
    const fullPage = pageOf(Array.from({ length: 200 }, () => bid({ consumed: 10 })));
    const partial = pageOf([bid({ consumed: 1 })]);
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

  it('treats missing counters_committed as zero (degrade, not poison)', async () => {
    const items: BidItem[] = [
      bid({ consumed: 300 }),
      { bid: { is_current: false } } as unknown as BidItem, // no counters_committed
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
    listBids.mockResolvedValueOnce(pageOf([bid({ consumed: 42 })]));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.total_settlement_sat).toBe(42);
  });

  it('caches successful results within the TTL', async () => {
    const listBids = vi.fn(async () => pageOf([bid({ consumed: 100 })]));
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
