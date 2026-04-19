import { describe, expect, it, vi } from 'vitest';
import type { BidItem, BidsResponse, BraiinsClient } from '@braiins-hashrate/braiins-client';

import { AccountSpendService } from './account-spend.js';
import type { ClosedBidsCacheRepo } from '../state/repos/closed_bids_cache.js';

function makeClient(listBids: BraiinsClient['listBids']): BraiinsClient {
  return { listBids } as unknown as BraiinsClient;
}

function bid({
  id,
  consumed,
  is_current = false,
}: {
  id: string;
  consumed: number;
  is_current?: boolean;
}): BidItem {
  return {
    bid: { id, is_current } as unknown as BidItem['bid'],
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

// In-memory fake ClosedBidsCacheRepo — captures upserts, satisfies
// the interface the service uses.
function makeFakeRepo() {
  const rows = new Map<string, { braiins_order_id: string; amount_consumed_sat: number; first_seen_at: number; last_seen_at: number }>();
  const repo: ClosedBidsCacheRepo = {
    async upsert(row, now) {
      const existing = rows.get(row.braiins_order_id);
      rows.set(row.braiins_order_id, {
        braiins_order_id: row.braiins_order_id,
        amount_consumed_sat: row.amount_consumed_sat,
        first_seen_at: existing?.first_seen_at ?? now,
        last_seen_at: now,
      });
    },
    async sumConsumedSat() {
      let t = 0;
      for (const r of rows.values()) t += r.amount_consumed_sat;
      return t;
    },
    async allIds() {
      return new Set(rows.keys());
    },
    async count() {
      return rows.size;
    },
    async clear() {
      rows.clear();
    },
  } as unknown as ClosedBidsCacheRepo;
  return { repo, rows };
}

describe('AccountSpendService (repo-backed)', () => {
  it('on first fetch, paginates everything and upserts every terminal bid', async () => {
    const listBids = vi.fn(async () =>
      pageOf([
        bid({ id: 'B1', consumed: 100, is_current: true }),
        bid({ id: 'B2', consumed: 500 }),
        bid({ id: 'B3', consumed: 250 }),
      ]),
    );
    const { repo, rows } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo);
    const snap = await svc.getLifetimeSpend();
    expect(snap?.active_sat).toBe(100);
    expect(snap?.closed_sat).toBe(750);
    expect(snap?.total_settlement_sat).toBe(850);
    expect(rows.size).toBe(2);
    expect(rows.get('B2')?.amount_consumed_sat).toBe(500);
    expect(rows.get('B3')?.amount_consumed_sat).toBe(250);
  });

  it('on refresh with no new terminals, paginates one page and stops', async () => {
    const listBids = vi
      .fn<BraiinsClient['listBids']>()
      .mockResolvedValueOnce(
        pageOf([bid({ id: 'B2', consumed: 500 }), bid({ id: 'B3', consumed: 250 })]),
      )
      // Second call: same page (nothing changed); service should short-circuit.
      .mockResolvedValueOnce(
        pageOf([bid({ id: 'B2', consumed: 500 }), bid({ id: 'B3', consumed: 250 })]),
      );
    const { repo } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo, {
      cacheTtlMs: 0,
    });
    await svc.getLifetimeSpend();
    const snap = await svc.getLifetimeSpend();
    expect(snap?.closed_sat).toBe(750);
    // Both calls walked just one page — short-circuit on page without
    // new terminals. 2 calls total (one per getLifetimeSpend).
    expect(listBids).toHaveBeenCalledTimes(2);
  });

  it('active→terminal transition moves spend from active_sat to cached closed_sat on the next fetch', async () => {
    // Fetch 1: B_ACT is active (consumed 300). Not cached.
    // Fetch 2: B_ACT has flipped to terminal (consumed 400, final).
    //          It should now be cached and counted under closed_sat.
    const listBids = vi
      .fn<BraiinsClient['listBids']>()
      .mockResolvedValueOnce(
        pageOf([bid({ id: 'B_ACT', consumed: 300, is_current: true })]),
      )
      .mockResolvedValueOnce(
        pageOf([bid({ id: 'B_ACT', consumed: 400, is_current: false })]),
      );
    const { repo } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo, {
      cacheTtlMs: 0,
    });
    const first = await svc.getLifetimeSpend();
    expect(first?.active_sat).toBe(300);
    expect(first?.closed_sat).toBe(0);

    const second = await svc.getLifetimeSpend();
    expect(second?.active_sat).toBe(0);
    expect(second?.closed_sat).toBe(400);
  });

  it('rebuild() wipes the persistent cache and forces a full re-fetch', async () => {
    const listBids = vi.fn(async () =>
      pageOf([bid({ id: 'B2', consumed: 500 })]),
    );
    const { repo, rows } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo, {
      cacheTtlMs: 60_000,
    });
    await svc.getLifetimeSpend();
    expect(rows.size).toBe(1);
    await svc.rebuild();
    expect(rows.size).toBe(0);
    await svc.getLifetimeSpend();
    expect(rows.size).toBe(1); // repopulated
  });

  it('in-memory snapshot cache hides the repo + wire within the TTL', async () => {
    const listBids = vi.fn(async () =>
      pageOf([bid({ id: 'B2', consumed: 500 })]),
    );
    const { repo } = makeFakeRepo();
    let now = 1_700_000_000_000;
    const svc = new AccountSpendService(makeClient(listBids), repo, {
      cacheTtlMs: 60_000,
      now: () => now,
    });
    await svc.getLifetimeSpend();
    await svc.getLifetimeSpend(); // within TTL — snapshot hit
    expect(listBids).toHaveBeenCalledTimes(1);
    now += 60_001;
    await svc.getLifetimeSpend(); // TTL expired
    expect(listBids).toHaveBeenCalledTimes(2);
  });

  it('paginates multiple full pages until one lacks new terminals', async () => {
    const fullTerminalPage = pageOf(
      Array.from({ length: 200 }, (_, i) => bid({ id: `Bnew${i}`, consumed: 10 })),
    );
    const partial = pageOf([bid({ id: 'Bnew200', consumed: 1 })]);
    const listBids = vi
      .fn<BraiinsClient['listBids']>()
      .mockResolvedValueOnce(fullTerminalPage)
      .mockResolvedValueOnce(partial);
    const { repo } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo);
    const snap = await svc.getLifetimeSpend();
    expect(snap?.transactions_seen).toBe(201);
    expect(snap?.closed_sat).toBe(200 * 10 + 1);
    expect(listBids).toHaveBeenCalledTimes(2);
    expect(listBids.mock.calls[1]?.[0]).toMatchObject({ offset: 200 });
  });

  it('returns null when the API throws, without caching the failure', async () => {
    const listBids = vi.fn<BraiinsClient['listBids']>().mockRejectedValueOnce(new Error('boom'));
    const { repo } = makeFakeRepo();
    const svc = new AccountSpendService(makeClient(listBids), repo);
    expect(await svc.getLifetimeSpend()).toBeNull();
    listBids.mockResolvedValueOnce(pageOf([bid({ id: 'X', consumed: 42 })]));
    const snap = await svc.getLifetimeSpend();
    expect(snap?.closed_sat).toBe(42);
  });
});
