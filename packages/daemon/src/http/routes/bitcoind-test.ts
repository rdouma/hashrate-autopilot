/**
 * POST /api/bitcoind/test
 *
 * Test bitcoind RPC connectivity using the URL/user/pass supplied in
 * the request body — typically the form values the operator just
 * typed on the Config page, before saving. The endpoint deliberately
 * does NOT fall back to the saved config: the operator's whole reason
 * for clicking Test is to validate UNSAVED candidate values, and
 * mixing in saved fallbacks would obscure which value got tested.
 *
 * Returns a structured success/failure. On success the bitcoind
 * `getblockchaininfo` summary (chain, blocks, headers, bestblockhash);
 * on failure a string that already includes the underlying network-
 * error code (ENOTFOUND / ECONNREFUSED / ETIMEDOUT) and the target
 * URL via the bitcoind-client's describeFetchFailure helper.
 *
 * Why a separate endpoint and not "just hit /api/bip110/scan?blocks=1":
 * scan uses the SAVED config; this lets the operator iterate on
 * candidate URL/creds without a save-restart-retry loop.
 */

import type { FastifyInstance } from 'fastify';

import {
  createBitcoindClient,
  BitcoindError,
} from '@braiins-hashrate/bitcoind-client';

export interface BitcoindTestRequest {
  url?: string;
  user?: string;
  password?: string;
}

export interface BitcoindTestResponse {
  ok: boolean;
  chain?: string | null;
  blocks?: number | null;
  headers?: number | null;
  best_block_hash?: string | null;
  error?: string | null;
}

export async function registerBitcoindTestRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body?: BitcoindTestRequest }>(
    '/api/bitcoind/test',
    async (req): Promise<BitcoindTestResponse> => {
      const body = req.body ?? {};
      const url = body.url?.trim() ?? '';
      const user = body.user?.trim() ?? '';
      const password = body.password ?? '';

      if (!url || !user || !password) {
        return {
          ok: false,
          error: 'URL, username, and password are all required',
        };
      }

      const client = createBitcoindClient({ url, username: user, password, timeoutMs: 10_000 });

      try {
        const info = await client.getBlockchainInfo();
        return {
          ok: true,
          chain: info.chain,
          blocks: info.blocks,
          headers: info.headers,
          best_block_hash: info.bestblockhash,
        };
      } catch (err) {
        const msg = err instanceof BitcoindError ? err.message : (err as Error).message;
        return { ok: false, error: msg };
      }
    },
  );
}
