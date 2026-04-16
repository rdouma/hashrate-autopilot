import type { FastifyInstance } from 'fastify';

import type { PayoutObserver } from '../../services/payout-observer.js';

export interface PayoutsResponse {
  readonly address: string | null;
  readonly total_unspent_sat: number | null;
  readonly utxo_count: number | null;
  readonly scanned_block_height: number | null;
  readonly checked_at: number | null;
  readonly last_error: string | null;
  readonly source: 'electrs' | 'bitcoind' | null;
}

export async function registerPayoutsRoute(
  app: FastifyInstance,
  deps: { payoutObserver: PayoutObserver | null },
): Promise<void> {
  app.get('/api/payouts', async (): Promise<PayoutsResponse> => {
    if (!deps.payoutObserver) {
      return {
        address: null,
        total_unspent_sat: null,
        utxo_count: null,
        scanned_block_height: null,
        checked_at: null,
        last_error: 'payout observer not configured',
        source: null,
      };
    }
    const snap = deps.payoutObserver.getLastSnapshot();
    const err = deps.payoutObserver.getLastError();
    if (!snap) {
      return {
        address: null,
        total_unspent_sat: null,
        utxo_count: null,
        scanned_block_height: null,
        checked_at: null,
        last_error: err,
        source: null,
      };
    }
    return {
      address: snap.address,
      total_unspent_sat: snap.total_unspent_sat,
      utxo_count: snap.utxo_count,
      scanned_block_height: snap.scanned_block_height,
      checked_at: snap.checked_at,
      last_error: err,
      source: snap.source,
    };
  });

  app.post('/api/payouts/scan', async (_req, reply) => {
    if (!deps.payoutObserver) {
      reply.code(503);
      return { ok: false, error: 'payout observer not configured' };
    }
    await deps.payoutObserver.scanOnce();
    return { ok: true };
  });
}
