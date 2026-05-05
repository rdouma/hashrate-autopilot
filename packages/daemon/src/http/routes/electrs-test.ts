/**
 * POST /api/electrs/test
 *
 * Test Electrs (Electrum-protocol) reachability using the host/port
 * supplied in the request body. Same shape and intent as the
 * /api/bitcoind/test endpoint: validate UNSAVED form values from the
 * Config page before the operator commits a save + restart.
 *
 * Verification: open the TCP socket via createElectrsClient (which
 * does the connect handshake) and request the genesis-block header
 * via `blockchain.block.header(0)`. Genesis version is always 1, so
 * a successful call is an end-to-end protocol confirmation rather
 * than just "TCP listener exists" - distinguishes "Electrs is up"
 * from "wrong port that happens to have something listening".
 */

import type { FastifyInstance } from 'fastify';

import { createElectrsClient } from '../../services/electrs-client.js';

export interface ElectrsTestRequest {
  host?: string;
  port?: number | string;
}

export interface ElectrsTestResponse {
  ok: boolean;
  genesis_version?: number | null;
  error?: string | null;
}

export async function registerElectrsTestRoute(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Body?: ElectrsTestRequest }>(
    '/api/electrs/test',
    async (req): Promise<ElectrsTestResponse> => {
      const body = req.body ?? {};
      const host = typeof body.host === 'string' ? body.host.trim() : '';
      const portRaw = body.port;
      const port =
        typeof portRaw === 'number'
          ? portRaw
          : typeof portRaw === 'string'
          ? Number.parseInt(portRaw, 10)
          : NaN;

      if (!host) {
        return { ok: false, error: 'host is required' };
      }
      if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return { ok: false, error: 'port must be 1-65535' };
      }

      try {
        const client = await createElectrsClient({ host, port, timeoutMs: 10_000 });
        try {
          const version = await client.getBlockVersionByHeight(0);
          return { ok: true, genesis_version: version };
        } finally {
          client.close();
        }
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}
