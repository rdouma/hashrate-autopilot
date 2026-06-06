/**
 * GET /api/btc-price - BTC/USD spot price from the configured exchange.
 *
 * Returns the latest price snapshot, or nulls if the price source is
 * 'none' or the fetch failed. The dashboard polls this to feed its
 * sats <-> USD denomination toggle.
 *
 * POST /api/btc-price/test (#270) - live probe against a provider for
 * the Config panel's "Test connection" button. Bypasses the cache and
 * reports the concrete failure (HTTP status / network error) instead
 * of the silent null the cached path collapses everything into.
 */

import type { FastifyInstance } from 'fastify';

import type { BtcPriceService } from '../../services/btc-price.js';
import type { ConfigRepo } from '../../state/repos/config.js';

const KNOWN_SOURCES = new Set(['coingecko', 'coinbase', 'bitstamp', 'kraken']);

export interface BtcPriceResponse {
  readonly usd_per_btc: number | null;
  readonly source: string;
  readonly fetched_at_ms: number | null;
}

export interface BtcPriceDeps {
  readonly btcPriceService: BtcPriceService;
  readonly configRepo: ConfigRepo;
}

export async function registerBtcPriceRoute(
  app: FastifyInstance,
  deps: BtcPriceDeps,
): Promise<void> {
  app.get('/api/btc-price', async (): Promise<BtcPriceResponse> => {
    const config = await deps.configRepo.get();
    const source = config?.btc_price_source ?? 'none';

    if (source === 'none') {
      return { usd_per_btc: null, source: 'none', fetched_at_ms: null };
    }

    const snap = await deps.btcPriceService.fetchPrice(source);
    if (!snap) {
      return { usd_per_btc: null, source, fetched_at_ms: null };
    }

    return {
      usd_per_btc: snap.usd_per_btc,
      source: snap.source,
      fetched_at_ms: snap.fetched_at_ms,
    };
  });

  app.post<{ Body?: { source?: string } }>(
    '/api/btc-price/test',
    async (req, reply): Promise<BtcPriceTestResponse> => {
      // Test the source currently selected in the form when given,
      // falling back to the saved config - same "test unsaved values"
      // semantics as the other test routes (DDNS, bitcoind, Datum).
      let source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
      if (!source) {
        const config = await deps.configRepo.get();
        source = config?.btc_price_source ?? 'none';
      }
      if (source !== 'none' && !KNOWN_SOURCES.has(source)) {
        reply.code(400);
        return { ok: false, usd_per_btc: null, source, error: `unknown price source: ${source}` };
      }
      const result = await deps.btcPriceService.probe(source);
      return result;
    },
  );
}

export interface BtcPriceTestResponse {
  readonly ok: boolean;
  readonly usd_per_btc: number | null;
  readonly source: string;
  readonly error: string | null;
}
