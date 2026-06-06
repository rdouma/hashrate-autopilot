/**
 * BTC/USD price oracle.
 *
 * Polls one of several public exchange APIs for the current BTC/USD
 * spot price. Cached for 5 minutes to avoid hammering free-tier
 * endpoints. In-flight de-dup prevents concurrent requests from
 * doubling up (same pattern as AccountSpendService).
 *
 * Used by the dashboard to offer a sats <-> USD denomination toggle.
 * The daemon itself never makes decisions based on fiat price - this
 * is purely a display convenience.
 */

import { USER_AGENT } from '../http/routes/build.js';

export interface BtcPriceSnapshot {
  readonly usd_per_btc: number;
  readonly source: string;
  readonly fetched_at_ms: number;
}

/** Result of an operator-triggered live probe (#270 test button). */
export interface BtcPriceProbeResult {
  readonly ok: boolean;
  readonly usd_per_btc: number | null;
  readonly source: string;
  /** Concrete failure, e.g. "coingecko returned HTTP 429" or "fetch failed: getaddrinfo ENOTFOUND api.kraken.com". */
  readonly error: string | null;
}

export interface BtcPriceServiceOptions {
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
const FETCH_TIMEOUT_MS = 10_000;

export class BtcPriceService {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: BtcPriceSnapshot | null = null;
  private inflight: Promise<BtcPriceSnapshot | null> | null = null;

  constructor(opts: BtcPriceServiceOptions = {}) {
    this.cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Return the latest cached snapshot, or null if it's stale or
   * never fetched. "Stale" = older than 2× cacheTtlMs - one missed
   * refresh cycle is fine, but two consecutive misses (or a sustained
   * oracle outage) mean we'd rather write null into tick_metrics than
   * pretend the old price is still live. Without this gate observers
   * silently keep reading the last successful fetch indefinitely,
   * which produced a 2h flat line on the chart when the dashboard
   * (which used to be the sole driver of `fetchPrice` cadence) wasn't
   * being polled. The daemon-side BtcPriceRefresher now keeps the
   * cache warm independently, but this defensive gate stays so a
   * future regression in the refresher doesn't silently corrupt
   * tick_metrics again.
   */
  getLatest(): BtcPriceSnapshot | null {
    if (!this.cache) return null;
    if (this.now() - this.cache.fetched_at_ms > this.cacheTtlMs * 2) return null;
    return this.cache;
  }

  /**
   * Seed the in-memory cache from a previously persisted price.
   * Used at boot when the live fetch fails - lets the first tick
   * after restart write a non-null price even when the oracle is
   * temporarily unreachable. Caller is responsible for the freshness
   * gate (see main.ts BOOT_FALLBACK_MAX_AGE_MS); this method does
   * not validate age, it just writes the snapshot.
   */
  seedFromPersisted(usdPerBtc: number, source: string, fetchedAtMs: number): void {
    this.cache = {
      usd_per_btc: usdPerBtc,
      source,
      fetched_at_ms: fetchedAtMs,
    };
  }

  /** Fetch (or return from cache) the current BTC/USD price for the given source. */
  async fetchPrice(source: string): Promise<BtcPriceSnapshot | null> {
    if (source === 'none') return null;

    const fresh = this.cache && this.now() - this.cache.fetched_at_ms < this.cacheTtlMs;
    // If cache is fresh AND from the same source, return it.
    if (fresh && this.cache!.source === source) return this.cache;

    // De-dup concurrent requests.
    if (this.inflight) return this.inflight;

    this.inflight = this.doFetch(source).finally(() => {
      this.inflight = null;
    });
    const result = await this.inflight;
    if (result) this.cache = result;
    return result;
  }

  /**
   * #270: operator-triggered live probe for the Config panel's "Test
   * connection" button. Always bypasses the cache and reports the
   * concrete failure (HTTP status / network error code) instead of
   * the silent null the cached path returns. A successful probe warms
   * the cache so the dashboard's USD toggle lights up immediately
   * after a green test.
   */
  async probe(
    source: string,
    opts: { warmCache?: boolean } = {},
  ): Promise<BtcPriceProbeResult> {
    if (source === 'none') {
      return { ok: false, usd_per_btc: null, source, error: 'price source is disabled' };
    }
    try {
      const usd = await fetchFromSource(source);
      // The Config test button warms the cache so the USD toggle
      // lights up right after a green test. The diagnostics sweep
      // (#272) probes ALL providers and must NOT leave the cache
      // pointing at whichever provider happened to resolve last.
      if (opts.warmCache !== false) {
        this.cache = { usd_per_btc: usd, source, fetched_at_ms: this.now() };
      }
      return { ok: true, usd_per_btc: usd, source, error: null };
    } catch (err) {
      // HTTP-level errors already name the provider ("kraken returned
      // HTTP 429"); timeouts and connection errors don't ("The
      // operation was aborted due to timeout") - prefix those so the
      // operator can tell which provider the message is about.
      const msg = describeFetchError(err);
      const error = msg.includes(source) ? msg : `${source}: ${msg}`;
      return { ok: false, usd_per_btc: null, source, error };
    }
  }

  private async doFetch(source: string): Promise<BtcPriceSnapshot | null> {
    try {
      const usd = await fetchFromSource(source);
      return {
        usd_per_btc: usd,
        source,
        fetched_at_ms: this.now(),
      };
    } catch (err) {
      console.warn(`[btc-price] fetch from ${source} failed: ${describeFetchError(err)}`);
      return null;
    }
  }
}

/**
 * undici wraps every connection-level failure in a generic
 * `TypeError: fetch failed` with the real code (ENOTFOUND /
 * ECONNREFUSED / ETIMEDOUT / ...) hidden in `cause`. Surface it -
 * same masking that made #260 and #267 needlessly hard to diagnose
 * from logs.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.cause instanceof Error && err.cause.message) {
    return `${err.message}: ${err.cause.message}`;
  }
  return err.message;
}

/**
 * Fetch the BTC/USD spot from one provider. Throws on ANY failure -
 * non-2xx status, unparseable body, missing field, network error -
 * with a message specific enough to act on. The cached path logs it;
 * the probe path returns it to the operator verbatim.
 *
 * All requests send an explicit User-Agent: these are unauthenticated,
 * bot-hammered CDN-fronted endpoints, and UA-less requests are exactly
 * what their anti-abuse layers like to reject (#267).
 */
async function fetchFromSource(source: string): Promise<number> {
  switch (source) {
    case 'coingecko':
      return fetchCoingecko();
    case 'coinbase':
      return fetchCoinbase();
    case 'bitstamp':
      return fetchBitstamp();
    case 'kraken':
      return fetchKraken();
    default:
      throw new Error(`unknown price source: ${source}`);
  }
}

function fetchOpts(): RequestInit {
  return {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  };
}

async function fetchCoingecko(): Promise<number> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    fetchOpts(),
  );
  if (!res.ok) throw new Error(`coingecko returned HTTP ${res.status}`);
  const data = (await res.json()) as { bitcoin?: { usd?: number } };
  const usd = data?.bitcoin?.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) {
    throw new Error('coingecko response missing bitcoin.usd');
  }
  return usd;
}

async function fetchCoinbase(): Promise<number> {
  const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot', fetchOpts());
  if (!res.ok) throw new Error(`coinbase returned HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { amount?: string } };
  const amount = data?.data?.amount;
  const n = typeof amount === 'string' ? Number.parseFloat(amount) : NaN;
  if (!Number.isFinite(n)) throw new Error('coinbase response missing data.amount');
  return n;
}

async function fetchBitstamp(): Promise<number> {
  const res = await fetch('https://www.bitstamp.net/api/v2/ticker/btcusd/', fetchOpts());
  if (!res.ok) throw new Error(`bitstamp returned HTTP ${res.status}`);
  const data = (await res.json()) as { last?: string };
  const last = data?.last;
  const n = typeof last === 'string' ? Number.parseFloat(last) : NaN;
  if (!Number.isFinite(n)) throw new Error('bitstamp response missing last');
  return n;
}

async function fetchKraken(): Promise<number> {
  const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD', fetchOpts());
  if (!res.ok) throw new Error(`kraken returned HTTP ${res.status}`);
  const data = (await res.json()) as {
    result?: { XXBTZUSD?: { c?: [string, ...unknown[]] } };
  };
  const c0 = data?.result?.XXBTZUSD?.c?.[0];
  const n = typeof c0 === 'string' ? Number.parseFloat(c0) : NaN;
  if (!Number.isFinite(n)) throw new Error('kraken response missing result ticker');
  return n;
}
