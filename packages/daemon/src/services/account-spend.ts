/**
 * Account-lifetime spend tracker.
 *
 * Sums spend across every bid the Braiins account has ever owned —
 * active + historical — to derive the true "total BTC paid out for
 * hashrate." Covers bids placed before the autopilot was switched on,
 * so it pairs honestly with Ocean's lifetime earnings.
 *
 * Source: `GET /spot/bid` with pagination, plus a persistent
 * `closed_bids_cache` (see state/repos/closed_bids_cache.ts).
 *
 * Per-bid spend: `counters_committed.amount_consumed_sat`. Empirically
 * the list endpoint returns only `counters_committed` per item —
 * `counters_estimate` and `state_estimate` are populated solely on
 * `/spot/bid/detail/{id}`. The OpenAPI spec promises all three; the
 * wire only delivers the committed counter.
 *
 * Caching strategy:
 *   - Terminal bids (is_current=false) are immutable after the status
 *     flips. We upsert each one into `closed_bids_cache` the first
 *     time we see it, then count them from the DB sum on every
 *     subsequent refresh — never re-reading their consumed value.
 *   - Active bids (is_current=true) are always read live from the
 *     wire; their consumed counter updates hourly as Braiins settles.
 *   - Pagination short-circuits: once a page produces zero new
 *     terminal bids, every older terminal is already cached, so we
 *     stop walking. First boot walks everything; steady-state walks
 *     one page per 5 min.
 *
 * A small in-memory 5-min snapshot cache sits on top so back-to-back
 * dashboard refreshes don't hit the repo + wire every poll.
 *
 * Operator-facing "rebuild" path: `rebuild()` wipes the repo and
 * forces a full re-paginate on the next fetch. Exposed via the
 * finance route so a button on the dashboard can trigger it.
 */

import type { BidItem, BraiinsClient } from '@braiins-hashrate/braiins-client';

import type { ClosedBidsCacheRepo } from '../state/repos/closed_bids_cache.js';

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
  private readonly repo: ClosedBidsCacheRepo;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private snapshotCache: AccountSpendSnapshot | null = null;
  private inflight: Promise<AccountSpendSnapshot | null> | null = null;

  constructor(
    client: BraiinsClient,
    repo: ClosedBidsCacheRepo,
    opts: AccountSpendOptions = {},
  ) {
    this.client = client;
    this.repo = repo;
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  async getLifetimeSpend(): Promise<AccountSpendSnapshot | null> {
    const fresh =
      this.snapshotCache && this.now() - this.snapshotCache.fetched_at_ms < this.cacheTtlMs;
    if (fresh) return this.snapshotCache;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchAndSum().finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if (result) this.snapshotCache = result;
    return result;
  }

  /**
   * Wipe the persistent cache and the in-memory snapshot so the very
   * next `getLifetimeSpend` call re-paginates everything from the wire
   * and re-populates the cache. Safety net for the unlikely case of
   * Braiins retroactively adjusting a terminal bid, a schema bug we
   * discover later, or the operator flat-out wanting fresh numbers.
   */
  async rebuild(): Promise<void> {
    await this.repo.clear();
    this.snapshotCache = null;
    // Don't await any in-flight fetch — just invalidate and let the
    // next call trigger a new one.
  }

  private async fetchAndSum(): Promise<AccountSpendSnapshot | null> {
    // Start with the already-cached terminal sum. We'll only *add*
    // newly-discovered terminals on top of this — never re-read
    // existing cached rows.
    const closedFromCache = await this.repo.sumConsumedSat();
    const cachedIds = await this.repo.allIds();

    let closedNew = 0;
    let active = 0;
    let seen = 0;
    let offset = 0;
    const fetchStart = this.now();

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

      let newTerminalsOnThisPage = 0;

      for (const item of items) {
        seen++;
        const consumed = consumedSatFor(item);
        if (!Number.isFinite(consumed) || consumed <= 0) continue;

        if (isCurrentBid(item)) {
          // Active — always counted live, never cached.
          active += consumed;
        } else {
          const id = bidIdOf(item);
          if (!id) continue; // terminal with no ID — shouldn't happen, but skip defensively
          if (!cachedIds.has(id)) {
            closedNew += consumed;
            cachedIds.add(id);
            await this.repo.upsert(
              { braiins_order_id: id, amount_consumed_sat: consumed },
              fetchStart,
            );
            newTerminalsOnThisPage++;
          }
        }
      }

      // Short-circuit: if this whole page had zero new terminals, the
      // older tail is definitely already in the cache. Note that a
      // page can still contain new *active* bids — those are at the
      // top (newest created) and we always process them. We only
      // terminate the pagination when terminals stop appearing fresh.
      if (newTerminalsOnThisPage === 0) break;

      // End-of-history signal: a partial page means we got everything.
      if (items.length < PAGE_SIZE) break;
      offset += items.length;
    }

    const closed = closedFromCache + closedNew;
    const total = closed + active;
    console.warn(
      `[account-spend] summary: seen=${seen} cached_terminals=${cachedIds.size} closed_sat=${Math.round(closed)} active_sat=${Math.round(active)} total_sat=${Math.round(total)}`,
    );
    return {
      total_settlement_sat: Math.round(total),
      closed_sat: Math.round(closed),
      active_sat: Math.round(active),
      transactions_seen: seen,
      fetched_at_ms: fetchStart,
    };
  }
}

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

function bidIdOf(item: BidItem): string | null {
  const id = item.bid?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
