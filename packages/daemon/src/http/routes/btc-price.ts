/**
 * GET /api/btc-price - BTC/USD spot price from the configured exchange.
 *
 * Returns the latest price snapshot, or nulls if the price source is
 * 'none' or the fetch failed. The dashboard polls this to feed its
 * sats <-> USD denomination toggle.
 */

import type { FastifyInstance } from 'fastify';

import type { BtcPriceService } from '../../services/btc-price.js';
import type { ConfigRepo } from '../../state/repos/config.js';

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
}
