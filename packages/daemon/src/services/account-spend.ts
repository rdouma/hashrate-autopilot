/**
 * Account-lifetime spend tracker.
 *
 * Sums Braiins' transaction ledger to derive *total BTC paid out for
 * hashrate*, including bids that existed before the autopilot. The
 * autopilot's own `owned_bids` ledger only knows about bids it
 * created/tagged — when the user has a long Braiins history (e.g.
 * many manual bids before the autopilot was switched on), the
 * autopilot-only "spent" figure understates reality and makes the net
 * P&L look unrealistically positive. This service is the alternative
 * source the operator can flip to via `spent_scope = 'account'`.
 *
 * How:
 *   /v1/account/transaction returns rows of:
 *     { tx_type, amount_sat, timestamp, details }
 *   The `tx_type` we care about is exactly:
 *     "(Partial) order settlement (brutto price)"
 *   Empirical 2026-04-16 — that's the line that fires every hour as
 *   Braiins debits the bid's blocked balance to pay the hashrate
 *   seller. Anything else (cancellations, "Blocked amount" reservations,
 *   payouts, fees, deposits) is *not* spend on hashrate and gets
 *   ignored.
 *
 * Pagination + cache:
 *   - The endpoint takes limit/offset; we walk pages of 200 until an
 *     empty page (or pageSize-rejection) signals end of history.
 *   - Result cached for `cacheTtlMs` (default 5 min) — operator
 *     pulls the panel hourly at most, no need to thrash the API.
 *   - Cache survives within a single daemon process; a restart
 *     re-fetches. Persisting the running total + last-seen timestamp
 *     so we could fetch only deltas would be a follow-up; today's
 *     account has ~hundreds of transactions which fits in 1-2 GETs
 *     and takes <500 ms.
 */

import type { BraiinsClient, Transaction } from '@braiins-hashrate/braiins-client';

const SETTLEMENT_TX_TYPE = '(Partial) order settlement (brutto price)';
const PAGE_SIZE = 200;
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
    // Bounded by page count — without this a misbehaving endpoint that
    // never returns < PAGE_SIZE could spin forever. 1000 pages = 200k
    // transactions, several years of hourly settlements; way past
    // anything realistic.
    const maxPages = 1000;

    for (let i = 0; i < maxPages; i++) {
      let res;
      try {
        res = await this.client.getTransactions({ limit: PAGE_SIZE, offset });
      } catch (err) {
        console.warn(
          `[account-spend] /account/transaction page offset=${offset} failed: ${(err as Error).message}`,
        );
        return null;
      }
      const items: Transaction[] = res.transactions ?? [];
      if (items.length === 0) break;

      for (const t of items) {
        seen++;
        if (t.tx_type === SETTLEMENT_TX_TYPE) {
          total += t.amount_sat ?? 0;
        }
      }

      // End-of-history signal: a partial page means we got everything.
      if (items.length < PAGE_SIZE) break;
      offset += items.length;
    }

    return {
      total_settlement_sat: total,
      transactions_seen: seen,
      fetched_at_ms: this.now(),
    };
  }
}
