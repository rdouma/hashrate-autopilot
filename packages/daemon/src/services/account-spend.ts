/**
 * Account-lifetime spend tracker.
 *
 * Sums `counters_estimate.amount_consumed_sat` across every bid the
 * Braiins account has ever owned — active + historical — to derive
 * the true "total BTC paid out for hashrate." Covers bids placed
 * before the autopilot was switched on, so it pairs honestly with
 * Ocean's lifetime earnings.
 *
 * Source: `GET /spot/bid` with pagination. The endpoint returns bids
 * sorted by creation time, each with a `counters_estimate` subobject
 * carrying `amount_consumed_sat` — Braiins's live running total of
 * spend on that bid, including the most recent in-flight consumption
 * that hasn't yet hit the hourly settlement ledger. `counters_committed`
 * is the settled-only counterpart; we deliberately use the estimate so
 * the panel isn't up to an hour behind reality.
 *
 * Pagination + cache:
 *   - Walk pages of 200 until a partial page signals end of history.
 *   - Cap at 1000 pages (~200k bids) to stop a misbehaving endpoint
 *     from spinning forever — orders of magnitude beyond anything real.
 *   - 5-min in-memory cache; inflight-dedup so concurrent requests
 *     share one fetch. A restart re-fetches.
 *
 * Prior implementation summed `/v1/account/transaction` rows of type
 * "(Partial) order settlement (brutto price)". That was correct but
 * lagged the real spend by up to one settlement interval (hourly), and
 * didn't pick up brand-new bids before their first settlement tick.
 * Switching to the bid list removes both gaps and lets us drop the
 * magic-string tx-type match.
 */

import type { BidItem, BraiinsClient } from '@braiins-hashrate/braiins-client';

const PAGE_SIZE = 200;
const MAX_PAGES = 1000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export interface AccountSpendSnapshot {
  readonly total_settlement_sat: number;
  readonly transactions_seen: number;
  readonly fetched_at_ms: number;
}

export interface AccountSpendOptions {
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export class AccountSpendService {
  private readonly client: BraiinsClient;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: AccountSpendSnapshot | null = null;
  private inflight: Promise<AccountSpendSnapshot | null> | null = null;

  constructor(client: BraiinsClient, opts: AccountSpendOptions = {}) {
    this.client = client;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  async getLifetimeSpend(): Promise<AccountSpendSnapshot | null> {
    const fresh = this.cache && this.now() - this.cache.fetched_at_ms < this.cacheTtlMs;
    if (fresh) return this.cache;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchAndSum().finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if (result) this.cache = result;
    return result;
  }

  private async fetchAndSum(): Promise<AccountSpendSnapshot | null> {
    let total = 0;
    let seen = 0;
    let offset = 0;

    for (let i = 0; i < MAX_PAGES; i++) {
      let res;
      try {
        res = await this.client.listBids({ limit: PAGE_SIZE, offset });
      } catch (err) {
        console.warn(
          `[account-spend] /spot/bid page offset=${offset} failed: ${(err as Error).message}`,
        );
        return null;
      }
      const items: BidItem[] = res.items ?? [];
      if (items.length === 0) break;

      for (const item of items) {
        seen++;
        const consumed = Number(item.counters_estimate?.amount_consumed_sat ?? 0);
        if (Number.isFinite(consumed) && consumed > 0) {
          total += consumed;
        }
      }

      // End-of-history signal: a partial page means we got everything.
      if (items.length < PAGE_SIZE) break;
      offset += items.length;
    }

    return {
      total_settlement_sat: Math.round(total),
      transactions_seen: seen,
      fetched_at_ms: this.now(),
    };
  }
}
