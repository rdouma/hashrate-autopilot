/**
 * #270: tests for the BTC price oracle's probe path (Config panel
 * "Test connection" button) and the error-detail plumbing that #267
 * showed was missing - a bare "fetch failed" with the real cause
 * (ENOTFOUND / ECONNREFUSED / HTTP 429) swallowed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BtcPriceService, describeFetchError } from './btc-price.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('describeFetchError', () => {
  it('appends the undici cause to the generic message', () => {
    const cause = new Error('getaddrinfo ENOTFOUND api.kraken.com');
    const err = new TypeError('fetch failed', { cause });
    expect(describeFetchError(err)).toBe(
      'fetch failed: getaddrinfo ENOTFOUND api.kraken.com',
    );
  });

  it('passes plain errors through', () => {
    expect(describeFetchError(new Error('kraken returned HTTP 429'))).toBe(
      'kraken returned HTTP 429',
    );
    expect(describeFetchError('boom')).toBe('boom');
  });
});

describe('BtcPriceService.probe', () => {
  it('returns the live price and warms the cache on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ bitcoin: { usd: 104_250 } })),
    );
    const svc = new BtcPriceService({ now: () => 1_000_000 });

    const result = await svc.probe('coingecko');
    expect(result).toEqual({
      ok: true,
      usd_per_btc: 104_250,
      source: 'coingecko',
      error: null,
    });
    // Cache warmed: getLatest serves the probed price without a new fetch.
    expect(svc.getLatest()).toEqual({
      usd_per_btc: 104_250,
      source: 'coingecko',
      fetched_at_ms: 1_000_000,
    });
  });

  it('reports the HTTP status on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 429)));
    const svc = new BtcPriceService();

    const result = await svc.probe('kraken');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('kraken returned HTTP 429');
  });

  it('reports the network cause on a connection-level failure', async () => {
    const cause = new Error('connect ECONNREFUSED 1.2.3.4:443');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause });
      }),
    );
    const svc = new BtcPriceService();

    const result = await svc.probe('coinbase');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('coinbase: fetch failed: connect ECONNREFUSED 1.2.3.4:443');
  });

  it('prefixes provider-less messages (timeouts) with the source name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    const svc = new BtcPriceService();

    const result = await svc.probe('coingecko');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('coingecko: The operation was aborted due to timeout');
  });

  it('reports a malformed body as a missing-field error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ unexpected: true })));
    const svc = new BtcPriceService();

    const result = await svc.probe('coingecko');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('coingecko response missing bitcoin.usd');
  });

  it("rejects source 'none' without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new BtcPriceService();

    const result = await svc.probe('none');
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves the cache untouched with warmCache=false (#272 diagnostics sweep)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ bitcoin: { usd: 104_000 } })),
    );
    const svc = new BtcPriceService({ now: () => 1_000_000 });
    svc.seedFromPersisted(99_000, 'kraken', 999_999);

    const result = await svc.probe('coingecko', { warmCache: false });
    expect(result.ok).toBe(true);
    // Cache still holds the kraken snapshot - the sweep must not
    // repoint it at whichever provider resolved last.
    expect(svc.getLatest()?.source).toBe('kraken');
    expect(svc.getLatest()?.usd_per_btc).toBe(99_000);
  });

  it('bypasses a fresh cache from another source', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ bitcoin: { usd: 104_000 } }));
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new BtcPriceService({ now: () => 1_000_000 });
    svc.seedFromPersisted(99_000, 'kraken', 999_999);

    const result = await svc.probe('coingecko');
    expect(result.ok).toBe(true);
    expect(result.usd_per_btc).toBe(104_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('BtcPriceService.fetchPrice (cached path, unchanged semantics)', () => {
  it('sends an explicit User-Agent on price fetches (#267)', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ bitcoin: { usd: 104_000 } }));
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new BtcPriceService();

    await svc.fetchPrice('coingecko');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['user-agent']).toMatch(/^hashrate-autopilot\//);
  });

  it('returns null on failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('ENOTFOUND') });
      }),
    );
    const svc = new BtcPriceService();
    await expect(svc.fetchPrice('kraken')).resolves.toBeNull();
  });

  it('fetches live when the cache is fresh but from a different source', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ bitcoin: { usd: 105_000 } }));
    vi.stubGlobal('fetch', fetchSpy);
    const svc = new BtcPriceService({ now: () => 1_000_000 });
    svc.seedFromPersisted(99_000, 'kraken', 999_000);

    const snap = await svc.fetchPrice('coingecko');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(snap?.usd_per_btc).toBe(105_000);
    expect(snap?.source).toBe('coingecko');
  });
});
