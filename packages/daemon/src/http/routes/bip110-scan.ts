/**
 * GET /api/bip110/scan?blocks=N
 *
 * Scans the most recent N blocks for BIP 110 (Reduced Data Temporary
 * Softfork) signaling and returns deployment-level state plus the list
 * of signaling block hashes for the operator to verify the crown
 * marker (#94) renders correctly.
 *
 * Detection (BIP 9-style):
 *   isBip110Signal = ((version & 0xe0000000) === 0x20000000)  // top 3 bits = 001
 *                 && ((version & (1 << 4)) !== 0)             // bit 4 set
 *
 * Speed: bitcoind JSON-RPC batch sends N requests per HTTP call so a
 * 2016-block scan is two round-trips totalling ~5-15s on a healthy
 * node. Replaces the deleted scripts/bip110scan.sh approach which had
 * the wrong shape (creds in a file, no clean gitignore answer).
 */

import type { FastifyInstance } from 'fastify';

import type { BitcoindClient } from '@braiins-hashrate/bitcoind-client';

const DEFAULT_BLOCKS = 2016;
const MAX_BLOCKS = 8064;
const BATCH_SIZE = 200;

export interface Bip110ScanDeps {
  readonly bitcoindClient: BitcoindClient | null;
}

export interface Bip110SignalingBlock {
  readonly height: number;
  readonly hash: string;
  readonly time_ms: number;
  readonly version: number;
  readonly version_hex: string;
}

export interface Bip110Deployment {
  readonly key: string;
  readonly status: string | null;
  readonly bit: number | null;
  readonly statistics: {
    readonly count: number;
    readonly elapsed: number;
    readonly threshold: number;
    readonly period: number;
  } | null;
}

export interface Bip110ScanResponse {
  readonly rpc_available: boolean;
  readonly tip_height: number | null;
  readonly scanned: number;
  readonly signaling_count: number;
  readonly signaling_pct: number;
  readonly deployment: Bip110Deployment | null;
  readonly signaling_blocks: readonly Bip110SignalingBlock[];
  readonly error: string | null;
}

interface BlockHeaderVerbose {
  readonly hash: string;
  readonly height: number;
  readonly version: number;
  readonly versionHex: string;
  readonly time: number;
}

interface SoftforkBip9 {
  status?: string;
  bit?: number;
  statistics?: {
    count?: number;
    elapsed?: number;
    threshold?: number;
    period?: number;
  };
}

interface SoftforkEntry {
  type?: string;
  active?: boolean;
  bip9?: SoftforkBip9;
}

function isBip110Signal(version: number): boolean {
  return (version & 0xe000_0000) === 0x2000_0000 && (version & 0x10) !== 0;
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function findBip110Deployment(softforks: Record<string, unknown> | undefined): Bip110Deployment | null {
  if (!softforks) return null;
  const candidates = ['bip110', 'reduceddatasoftfork', 'reduceddata', 'reduced_data'];
  for (const key of candidates) {
    const entry = softforks[key] as SoftforkEntry | undefined;
    if (!entry) continue;
    const bip9 = entry.bip9;
    const stats = bip9?.statistics;
    return {
      key,
      status: bip9?.status ?? null,
      bit: typeof bip9?.bit === 'number' ? bip9.bit : null,
      statistics:
        stats && typeof stats.count === 'number'
          ? {
              count: stats.count,
              elapsed: stats.elapsed ?? 0,
              threshold: stats.threshold ?? 0,
              period: stats.period ?? 0,
            }
          : null,
    };
  }
  return null;
}

export async function registerBip110ScanRoute(
  app: FastifyInstance,
  deps: Bip110ScanDeps,
): Promise<void> {
  app.get<{ Querystring: { blocks?: string } }>(
    '/api/bip110/scan',
    async (req): Promise<Bip110ScanResponse> => {
      const empty = (error: string | null = null): Bip110ScanResponse => ({
        rpc_available: deps.bitcoindClient !== null,
        tip_height: null,
        scanned: 0,
        signaling_count: 0,
        signaling_pct: 0,
        deployment: null,
        signaling_blocks: [],
        error,
      });

      if (!deps.bitcoindClient) {
        return empty('bitcoind RPC not configured');
      }

      const requested = Number.parseInt(req.query.blocks ?? String(DEFAULT_BLOCKS), 10);
      const blocks = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_BLOCKS)
        : DEFAULT_BLOCKS;

      let info;
      try {
        info = await deps.bitcoindClient.getBlockchainInfo();
      } catch (err) {
        return empty(`getblockchaininfo failed: ${(err as Error).message}`);
      }

      const tip = info.blocks;
      const start = Math.max(0, tip - blocks + 1);
      const heights = Array.from({ length: tip - start + 1 }, (_, i) => start + i);
      const deployment = findBip110Deployment(info.softforks);

      let hashes: string[];
      try {
        hashes = [];
        for (const batch of chunk(heights, BATCH_SIZE)) {
          const results = await deps.bitcoindClient.batch<string>(
            batch.map((h) => ({ method: 'getblockhash', params: [h] })),
          );
          hashes.push(...results);
        }
      } catch (err) {
        return {
          ...empty(`getblockhash batch failed: ${(err as Error).message}`),
          tip_height: tip,
          deployment,
        };
      }

      let headers: BlockHeaderVerbose[];
      try {
        headers = [];
        for (const batch of chunk(hashes, BATCH_SIZE)) {
          const results = await deps.bitcoindClient.batch<BlockHeaderVerbose>(
            batch.map((h) => ({ method: 'getblockheader', params: [h, true] })),
          );
          headers.push(...results);
        }
      } catch (err) {
        return {
          ...empty(`getblockheader batch failed: ${(err as Error).message}`),
          tip_height: tip,
          deployment,
        };
      }

      const signaling: Bip110SignalingBlock[] = headers
        .filter((h) => isBip110Signal(h.version))
        .map((h) => ({
          height: h.height,
          hash: h.hash,
          time_ms: h.time * 1000,
          version: h.version,
          version_hex: h.versionHex || `0x${h.version.toString(16).padStart(8, '0')}`,
        }));

      return {
        rpc_available: true,
        tip_height: tip,
        scanned: headers.length,
        signaling_count: signaling.length,
        signaling_pct: headers.length > 0 ? (signaling.length / headers.length) * 100 : 0,
        deployment,
        signaling_blocks: signaling,
        error: null,
      };
    },
  );
}
