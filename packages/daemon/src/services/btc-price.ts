/**
 * BTC/USD price oracle.
 *
 * Polls one of several public exchange APIs for the current BTC/USD
 * spot price. Cached for 5 minutes to avoid hammering free-tier
 * endpoints. In-flight de-dup prevents concurrent requests from
 * doubling up (same pattern as AccountSpendService).
 *
 * Used by the dashboard to offer a sats <-> USD denomination toggle.
 * The daemon itself never makes decisions based on fiat price — this
 * is purely a display convenience.
 */

export interface BtcPriceSnapshot {
  readonly usd_per_btc: number;
  readonly source: string;
  readonly fetched_at_ms: number;
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

  private async doFetch(source: string): Promise<BtcPriceSnapshot | null> {
    try {
      const usd = await fetchFromSource(source);
      if (usd === null) return null;
      return {
        usd_per_btc: usd,
        source,
        fetched_at_ms: this.now(),
      };
    } catch (err) {
      console.warn(
        `[btc-price] fetch from ${source} failed: ${(err as Error).message}`,
      );
      return null;
    }
  }
}

async function fetchFromSource(source: string): Promise<number | null> {
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
      console.warn(`[btc-price] unknown source: ${source}`);
      return null;
  }
}

async function fetchCoingecko(): Promise<number | null> {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    console.warn(`[btc-price] coingecko returned ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { bitcoin?: { usd?: number } };
  const usd = data?.bitcoin?.usd;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

async function fetchCoinbase(): Promise<number | null> {
  const res = await fetch(
    'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    console.warn(`[btc-price] coinbase returned ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { data?: { amount?: string } };
  const amount = data?.data?.amount;
  if (typeof amount !== 'string') return null;
  const n = Number.parseFloat(amount);
  return Number.isFinite(n) ? n : null;
}

async function fetchBitstamp(): Promise<number | null> {
  const res = await fetch(
    'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    console.warn(`[btc-price] bitstamp returned ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { last?: string };
  const last = data?.last;
  if (typeof last !== 'string') return null;
  const n = Number.parseFloat(last);
  return Number.isFinite(n) ? n : null;
}

async function fetchKraken(): Promise<number | null> {
  const res = await fetch(
    'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) {
    console.warn(`[btc-price] kraken returned ${res.status}`);
    return null;
  }
  const data = (await res.json()) as {
    result?: { XXBTZUSD?: { c?: [string, ...unknown[]] } };
  };
  const c0 = data?.result?.XXBTZUSD?.c?.[0];
  if (typeof c0 !== 'string') return null;
  const n = Number.parseFloat(c0);
  return Number.isFinite(n) ? n : null;
}
