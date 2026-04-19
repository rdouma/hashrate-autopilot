/**
 * Account-lifetime spend tracker.
 *
 * Sums spend across every bid the Braiins account has ever owned —
 * active + historical — to derive the true "total BTC paid out for
 * hashrate." Covers bids placed before the autopilot was switched on,
 * so it pairs honestly with Ocean's lifetime earnings.
 *
 * Source: `GET /spot/bid` with pagination.
 *
 * Per-bid spend: `counters_committed.amount_consumed_sat`. Empirically
 * (daemon log 2026-04-19 build 12) the list endpoint returns *only*
 * `counters_committed` per item — `counters_estimate` and
 * `state_estimate` are populated solely on `/spot/bid/detail/{id}`.
 * The OpenAPI spec promises all three; the wire only delivers the
 * committed counter. `counters_committed.amount_consumed_sat` matches
 * the final spend on terminal bids and is Braiins's best settled-only
 * figure for active bids (may lag the latest hour's consumption).
 *
 * Splits: each bid is also categorised by `bid.is_current` — `true`
 * for non-terminal statuses (ACTIVE, CREATED, PAUSED, PENDING_CANCEL,
 * FROZEN), `false` for CANCELED / FULFILLED. So the snapshot carries
 * both a closed total and an active (still-in-flight) total, which
 * the panel surfaces as sub-rows. `total_settlement_sat` is the sum
 * of the two.
 *
 * Pagination + cache:
 *   - Walk pages of 200 until a partial page signals end of history.
 *   - Cap at 1000 pages (~200k bids) to stop a misbehaving endpoint
 *     from spinning forever.
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
  /** Total spend across every bid (active + closed). */
  readonly total_settlement_sat: number;
  /** Spend from terminal bids (CANCELED, FULFILLED). */
  readonly closed_sat: number;
  /** Live in-flight spend from still-running bids (is_current=true). */
  readonly active_sat: number;
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
    let closed = 0;
    let active = 0;
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
        const consumed = consumedSatFor(item);
        if (!Number.isFinite(consumed) || consumed <= 0) continue;
        if (isCurrentBid(item)) {
          active += consumed;
        } else {
          closed += consumed;
        }
      }

      // End-of-history signal: a partial page means we got everything.
      if (items.length < PAGE_SIZE) break;
      offset += items.length;
    }

    console.warn(
      `[account-spend] /spot/bid summary: seen=${seen} closed_sat=${Math.round(closed)} active_sat=${Math.round(active)} total_sat=${Math.round(closed + active)}`,
    );

    const total = closed + active;
    return {
      total_settlement_sat: Math.round(total),
      closed_sat: Math.round(closed),
      active_sat: Math.round(active),
      transactions_seen: seen,
      fetched_at_ms: this.now(),
    };
  }

}

/**
 * Read `counters_committed.amount_consumed_sat`, floored at 0.
 * The list endpoint returns this field on every item; other counter
 * variants (estimate / state_estimate) are absent.
 */
function consumedSatFor(item: BidItem): number {
  const consumed = Number(item.counters_committed?.amount_consumed_sat ?? 0);
  if (!Number.isFinite(consumed)) return 0;
  return Math.max(0, consumed);
}

function isCurrentBid(item: BidItem): boolean {
  // `is_current` is listed as required on SpotMarketBid in the
  // OpenAPI spec but absent from the generated TS properties block,
  // same codegen gap as `amount_sat` (worked around in observe.ts).
  const bid = item.bid as unknown as { is_current?: boolean } | undefined;
  return Boolean(bid?.is_current);
}
