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

import { createBitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { ConfigRepo } from '../../state/repos/config.js';

const DEFAULT_BLOCKS = 2016;
// 32256 = 16 retarget periods (~7-8 months at 10-minute target spacing).
// 16 batches of getblockhash + 16 of getblockheader at BATCH_SIZE=200 is
// 32 HTTP round-trips total to bitcoind, well within the 300 s default
// timeout on the bitcoind client.
const MAX_BLOCKS = 32256;
const BATCH_SIZE = 200;

export interface Bip110ScanDeps {
  readonly configRepo: ConfigRepo;
  /**
   * RPC creds resolved from the secrets layer at boot. Used as a
   * fallback when the SQLite config row leaves a field empty (so
   * sops-only deployments work). Per-request lookup of the live
   * `config` row still wins over secrets, which is why this route
   * does NOT take a pre-built BitcoindClient: a saved Config edit
   * has to take effect on the next scan without a daemon restart.
   */
  readonly secrets: {
    readonly bitcoind_rpc_url?: string;
    readonly bitcoind_rpc_user?: string;
    readonly bitcoind_rpc_password?: string;
  };
}

export interface Bip110SignalingBlock {
  readonly height: number;
  readonly hash: string;
  readonly time_ms: number;
  readonly version: number;
  readonly version_hex: string;
  readonly n_tx: number | null;
  readonly size_bytes: number | null;
  readonly weight: number | null;
  readonly subsidy_sat: number;
  readonly total_fees_sat: number | null;
  readonly pool_tag: string | null;
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
  readonly softfork_keys: readonly string[] | null;
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

interface BlockVerbosity1 {
  readonly hash: string;
  readonly height: number;
  readonly size: number;
  readonly weight: number;
  readonly nTx: number;
  readonly tx: readonly string[];
}

interface DecodedTx {
  readonly vin: readonly { readonly coinbase?: string }[];
  readonly vout: readonly { readonly value: number }[];
}

function subsidySat(height: number): number {
  const halvings = Math.floor(height / 210_000);
  if (halvings >= 64) return 0;
  return Math.floor(50e8 / (1 << halvings));
}

function extractPoolTag(coinbaseHex: string): string | null {
  const bytes = Buffer.from(coinbaseHex, 'hex');
  let best = '';
  let run = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      run += String.fromCharCode(b);
    } else {
      if (run.length > best.length) best = run;
      run = '';
    }
  }
  if (run.length > best.length) best = run;
  return best.length >= 3 ? best.trim() : null;
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

const BIP110_BIT = 4;

function findBip110Deployment(softforks: Record<string, unknown> | undefined): Bip110Deployment | null {
  if (!softforks) return null;

  const candidates = ['bip110', 'reduceddatasoftfork', 'reduceddata', 'reduced_data'];
  for (const key of candidates) {
    const result = extractDeployment(key, softforks[key] as SoftforkEntry | undefined);
    if (result) return result;
  }

  for (const [key, raw] of Object.entries(softforks)) {
    const entry = raw as SoftforkEntry | undefined;
    if (entry?.bip9?.bit === BIP110_BIT) {
      return extractDeployment(key, entry);
    }
  }

  return null;
}

function extractDeployment(key: string, entry: SoftforkEntry | undefined): Bip110Deployment | null {
  if (!entry) return null;
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

export async function registerBip110ScanRoute(
  app: FastifyInstance,
  deps: Bip110ScanDeps,
): Promise<void> {
  app.get<{ Querystring: { blocks?: string } }>(
    '/api/bip110/scan',
    async (req): Promise<Bip110ScanResponse> => {
      // Read the live config row at request time - saved Config edits
      // take effect on the next scan without a daemon restart. The
      // earlier shape took a boot-time-built client and used stale
      // creds forever; operator empirically hit this 2026-05-05
      // (saved a fresh URL, scanner kept hitting the old host).
      const config = await deps.configRepo.get();
      const url = config?.bitcoind_rpc_url || deps.secrets.bitcoind_rpc_url || '';
      const user = config?.bitcoind_rpc_user || deps.secrets.bitcoind_rpc_user || '';
      const password = config?.bitcoind_rpc_password || deps.secrets.bitcoind_rpc_password || '';
      const rpcAvailable = Boolean(url && user && password);

      const empty = (error: string | null = null): Bip110ScanResponse => ({
        rpc_available: rpcAvailable,
        tip_height: null,
        scanned: 0,
        signaling_count: 0,
        signaling_pct: 0,
        deployment: null,
        softfork_keys: null,
        signaling_blocks: [],
        error,
      });

      if (!rpcAvailable) {
        return empty('bitcoind RPC not configured');
      }

      const client = createBitcoindClient({ url, username: user, password });

      const requested = Number.parseInt(req.query.blocks ?? String(DEFAULT_BLOCKS), 10);
      const blocks = Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_BLOCKS)
        : DEFAULT_BLOCKS;

      let info;
      try {
        info = await client.getBlockchainInfo();
      } catch (err) {
        return empty(`getblockchaininfo failed: ${(err as Error).message}`);
      }

      const tip = info.blocks;
      const start = Math.max(0, tip - blocks + 1);
      const heights = Array.from({ length: tip - start + 1 }, (_, i) => start + i);
      const deployment = findBip110Deployment(info.softforks);
      const softfork_keys = info.softforks ? Object.keys(info.softforks).sort() : null;

      let hashes: string[];
      try {
        hashes = [];
        for (const batch of chunk(heights, BATCH_SIZE)) {
          const results = await client.batch<string>(
            batch.map((h) => ({ method: 'getblockhash', params: [h] })),
          );
          hashes.push(...results);
        }
      } catch (err) {
        return {
          ...empty(`getblockhash batch failed: ${(err as Error).message}`),
          tip_height: tip,
          deployment,
          softfork_keys,
        };
      }

      let headers: BlockHeaderVerbose[];
      try {
        headers = [];
        for (const batch of chunk(hashes, BATCH_SIZE)) {
          const results = await client.batch<BlockHeaderVerbose>(
            batch.map((h) => ({ method: 'getblockheader', params: [h, true] })),
          );
          headers.push(...results);
        }
      } catch (err) {
        return {
          ...empty(`getblockheader batch failed: ${(err as Error).message}`),
          tip_height: tip,
          deployment,
          softfork_keys,
        };
      }

      const signalingHeaders = headers.filter((h) => isBip110Signal(h.version));

      // Enrich signaling blocks with block-level data (nTx, size) and
      // coinbase data (pool tag, fees). Two extra batch rounds but
      // signaling blocks are rare so the cost is negligible.
      let blockMap = new Map<string, BlockVerbosity1>();
      let coinbaseMap = new Map<string, DecodedTx>();
      if (signalingHeaders.length > 0) {
        try {
          const blocks: BlockVerbosity1[] = [];
          for (const batch of chunk(signalingHeaders.map((h) => h.hash), BATCH_SIZE)) {
            const results = await client.batch<BlockVerbosity1>(
              batch.map((h) => ({ method: 'getblock', params: [h, 1] })),
            );
            blocks.push(...results);
          }
          blockMap = new Map(blocks.map((b) => [b.hash, b]));

          const coinbasePairs = blocks
            .filter((b) => b.tx.length > 0)
            .map((b) => ({ hash: b.hash, txid: b.tx[0]! }));
          if (coinbasePairs.length > 0) {
            const txs: DecodedTx[] = [];
            for (const batch of chunk(coinbasePairs, BATCH_SIZE)) {
              const results = await client.batch<DecodedTx>(
                batch.map((p) => ({ method: 'getrawtransaction', params: [p.txid, true, p.hash] })),
              );
              txs.push(...results);
            }
            coinbaseMap = new Map(coinbasePairs.map((p, i) => [p.hash, txs[i]!]));
          }
        } catch {
          // Enrichment is best-effort; fall back to header-only data.
        }
      }

      const signaling: Bip110SignalingBlock[] = signalingHeaders.map((h) => {
        const block = blockMap.get(h.hash);
        const cbTx = coinbaseMap.get(h.hash);
        const sub = subsidySat(h.height);
        let totalFeesSat: number | null = null;
        let poolTag: string | null = null;
        if (cbTx) {
          const cbOutputSat = Math.round(
            cbTx.vout.reduce((sum, o) => sum + o.value, 0) * 1e8,
          );
          totalFeesSat = Math.max(0, cbOutputSat - sub);
          const scriptSig = cbTx.vin[0]?.coinbase;
          if (scriptSig) poolTag = extractPoolTag(scriptSig);
        }
        return {
          height: h.height,
          hash: h.hash,
          time_ms: h.time * 1000,
          version: h.version,
          version_hex: h.versionHex || `0x${h.version.toString(16).padStart(8, '0')}`,
          n_tx: block?.nTx ?? null,
          size_bytes: block?.size ?? null,
          weight: block?.weight ?? null,
          subsidy_sat: sub,
          total_fees_sat: totalFeesSat,
          pool_tag: poolTag,
        };
      });

      return {
        rpc_available: true,
        tip_height: tip,
        scanned: headers.length,
        signaling_count: signaling.length,
        signaling_pct: headers.length > 0 ? (signaling.length / headers.length) * 100 : 0,
        deployment,
        softfork_keys,
        signaling_blocks: signaling,
        error: null,
      };
    },
  );
}
