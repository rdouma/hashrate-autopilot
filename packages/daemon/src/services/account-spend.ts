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
 * Per-bid spend formula: `bid.amount_sat - state_estimate.amount_remaining_sat`.
 * Empirically, `counters_estimate.amount_consumed_sat` on the list
 * endpoint is not populated (stays at 0 even for clearly-consuming
 * bids), so we use the same `amount_sat − amount_remaining_sat`
 * derivation the controller already applies in observe.ts:247.
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
 * consumed = amount_sat - amount_remaining_sat, floored at 0.
 * Resilient to the list endpoint occasionally omitting `state_estimate`
 * (treated as "nothing consumed yet"). Does NOT use
 * `counters_estimate.amount_consumed_sat` — empirically that field
 * returns 0 on the list endpoint even for clearly-consuming bids.
 *
 * Why the cast: Braiins's OpenAPI spec lists `amount_sat` as required
 * on SpotMarketBid but omits it from the properties block, so the
 * generated TS type doesn't carry it. observe.ts:217 works around
 * the same gap the same way. The field exists on the wire.
 */
function consumedSatFor(item: BidItem): number {
  const bid = item.bid as unknown as { amount_sat?: number; is_current?: boolean } | undefined;
  const total = Number(bid?.amount_sat ?? 0);
  const remaining = Number(item.state_estimate?.amount_remaining_sat ?? total);
  if (!Number.isFinite(total) || !Number.isFinite(remaining)) return 0;
  return Math.max(0, total - remaining);
}

function isCurrentBid(item: BidItem): boolean {
  const bid = item.bid as unknown as { is_current?: boolean } | undefined;
  return Boolean(bid?.is_current);
}
