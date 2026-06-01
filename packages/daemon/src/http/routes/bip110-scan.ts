/**
 * GET /api/bip110/scan?range=current|all
 *
 * Scans blocks for BIP 110 (Reduced Data Temporary Softfork)
 * signaling and returns deployment-level state plus the list of
 * signaling block hashes for the operator to verify the crown marker
 * (#94) renders correctly.
 *
 * Range semantics (#231 follow-up #3):
 *   - `current` (default): scan the in-progress difficulty epoch
 *     (from `floor(tip / 2016) * 2016` through `tip`). The
 *     signaling percentage is directly comparable to the 55% MASF
 *     activation threshold.
 *   - `all`: scan from BIP110_FIRST_SIGNALING_BLOCK_HEIGHT (the
 *     first known BIP 110 signaling block, height 938,903, found
 *     2026-03-01) through `tip`. Operator's explicit "show me
 *     everything" opt-in; ~13k blocks today, single-digit seconds.
 *
 * Both ranges always epoch-align: the response's per-epoch buckets
 * snap to multiples of 2016 so each row's percentage maps cleanly
 * to "this epoch's MASF progress."
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

const BLOCKS_PER_EPOCH = 2016;
/**
 * Height of the first known BIP 110 signaling block - found
 * 2026-03-01 on the mainnet. Anchors the `range=all` scan so the
 * historical view is bounded (instead of starting at genesis and
 * scanning ~1M empty blocks).
 */
export const BIP110_FIRST_SIGNALING_BLOCK_HEIGHT = 938_903;
const BATCH_SIZE = 200;

export type Bip110ScanRange = 'current' | 'all';

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

/**
 * Per-epoch signaling bucket. `start_height` is always a multiple of
 * 2016. For completed epochs, `end_height` is `start_height + 2015`
 * (and `in_progress` is false). For the current (in-progress) epoch,
 * `end_height` is the chain tip and `in_progress` is true; `scanned`
 * is therefore < 2016 and the percentage is "progress so far"
 * (directly comparable to the 55% MASF threshold).
 */
export interface Bip110EpochBucket {
  readonly start_height: number;
  readonly end_height: number;
  /**
   * Wall-clock timestamps of the first and last scanned headers in
   * the bucket. For completed epochs that's the actual first and last
   * block of the epoch (so the operator sees the date span the
   * difficulty was in force). For the in-progress epoch that's the
   * epoch start through "as of the chain tip we scanned." Both null
   * when no headers fell in the bucket (defensive - shouldn't happen
   * on a healthy node).
   */
  readonly start_time_ms: number | null;
  readonly end_time_ms: number | null;
  /**
   * #233: linear-extrapolated forecast for when the in-progress
   * epoch's 2016th block will be mined, based on the average block
   * time observed within the bucket so far. Null for completed
   * epochs (their actual end is in `end_time_ms`) and null when the
   * in-progress bucket has fewer than 2 scanned headers (can't
   * compute an average; falls back to a target-time estimate of
   * 600s × remaining).
   */
  readonly expected_end_time_ms: number | null;
  readonly scanned: number;
  readonly signaling_count: number;
  readonly signaling_pct: number;
  readonly in_progress: boolean;
}

export interface Bip110ScanResponse {
  readonly rpc_available: boolean;
  readonly tip_height: number | null;
  readonly scanned: number;
  readonly signaling_count: number;
  readonly signaling_pct: number;
  /** #231: per-epoch breakdown so the UI can show which epochs crossed
   *  the 55% MASF threshold. Ordered from earliest to latest. */
  readonly epochs: readonly Bip110EpochBucket[];
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

/**
 * Resolve `?range=current|all` + tip height to the inclusive height
 * range to scan. Returns `{ startHeight, currentEpochStart }` so the
 * caller can slice the per-epoch buckets without recomputing.
 *
 * - `current`: startHeight = currentEpochStart (the in-progress epoch).
 * - `all`: startHeight = BIP110_FIRST_SIGNALING_BLOCK_HEIGHT, then
 *   snapped down to its epoch boundary so the leftmost per-epoch
 *   bucket starts on a multiple of 2016 (the bucketing function
 *   floors heights into their epoch).
 *
 * Exported for testing.
 */
export function computeScanRange(
  tipHeight: number,
  range: Bip110ScanRange,
): { startHeight: number; currentEpochStart: number } {
  const currentEpochStart = Math.floor(tipHeight / BLOCKS_PER_EPOCH) * BLOCKS_PER_EPOCH;
  const startHeight =
    range === 'all'
      ? Math.floor(BIP110_FIRST_SIGNALING_BLOCK_HEIGHT / BLOCKS_PER_EPOCH) * BLOCKS_PER_EPOCH
      : currentEpochStart;
  return { startHeight, currentEpochStart };
}

/**
 * Bucket the scanned headers into per-epoch tallies. Iterates the
 * heights once and snaps each into `floor(height / 2016) * 2016`.
 * The bucket whose start equals `currentEpochStart` is marked
 * `in_progress`. Returned earliest-first.
 *
 * Exported for testing.
 */
export function bucketByEpoch(
  headers: readonly { height: number; version: number; time: number }[],
  startHeight: number,
  currentEpochStart: number,
  tipHeight: number,
): Bip110EpochBucket[] {
  const buckets = new Map<
    number,
    {
      signaling: number;
      scanned: number;
      minTimeSecs: number | null;
      maxTimeSecs: number | null;
    }
  >();
  for (const h of headers) {
    const epochStart = Math.floor(h.height / BLOCKS_PER_EPOCH) * BLOCKS_PER_EPOCH;
    const slot = buckets.get(epochStart) ?? {
      signaling: 0,
      scanned: 0,
      minTimeSecs: null,
      maxTimeSecs: null,
    };
    slot.scanned += 1;
    if (isBip110Signal(h.version)) slot.signaling += 1;
    slot.minTimeSecs = slot.minTimeSecs === null ? h.time : Math.min(slot.minTimeSecs, h.time);
    slot.maxTimeSecs = slot.maxTimeSecs === null ? h.time : Math.max(slot.maxTimeSecs, h.time);
    buckets.set(epochStart, slot);
  }
  // Seed any epoch starts that produced zero headers (defensive - a
  // healthy node shouldn't drop blocks but the bucket structure
  // shouldn't have holes).
  for (
    let start = Math.floor(startHeight / BLOCKS_PER_EPOCH) * BLOCKS_PER_EPOCH;
    start <= currentEpochStart;
    start += BLOCKS_PER_EPOCH
  ) {
    if (!buckets.has(start)) {
      buckets.set(start, {
        signaling: 0,
        scanned: 0,
        minTimeSecs: null,
        maxTimeSecs: null,
      });
    }
  }
  const sorted = Array.from(buckets.entries()).sort(([a], [b]) => a - b);
  return sorted.map(([start, { signaling, scanned, minTimeSecs, maxTimeSecs }]) => {
    const isCurrent = start === currentEpochStart;
    const endHeight = isCurrent ? tipHeight : start + BLOCKS_PER_EPOCH - 1;
    const startMs = minTimeSecs !== null ? minTimeSecs * 1000 : null;
    const endMs = maxTimeSecs !== null ? maxTimeSecs * 1000 : null;
    return {
      start_height: start,
      end_height: endHeight,
      start_time_ms: startMs,
      end_time_ms: endMs,
      expected_end_time_ms: isCurrent
        ? forecastEpochEnd(startMs, endMs, scanned)
        : null,
      scanned,
      signaling_count: signaling,
      signaling_pct: scanned > 0 ? (signaling / scanned) * 100 : 0,
      in_progress: isCurrent,
    };
  });
}

/**
 * #233: linear extrapolation of when the in-progress epoch's 2016th
 * block will be mined.
 *
 *   scanned >= 2: avg_block_time = (end - start) / (scanned - 1),
 *                 forecast = end + (2016 - scanned) * avg_block_time.
 *   scanned == 1: can't compute average; fall back to a target-time
 *                 estimate (600s × 2016 from start).
 *   scanned == 0 / null inputs: null.
 *
 * Exported for testing.
 */
export function forecastEpochEnd(
  startMs: number | null,
  endMs: number | null,
  scanned: number,
): number | null {
  if (startMs === null || endMs === null || scanned <= 0) return null;
  if (scanned === 1) {
    return startMs + BLOCKS_PER_EPOCH * 600 * 1000;
  }
  const avgBlockMs = (endMs - startMs) / (scanned - 1);
  // Defensive: clamp ridiculous averages (e.g. clock skew producing
  // 0 or negative deltas across two adjacent blocks). Bitcoin's
  // median-time-past rule means blocks can have non-monotone time
  // within reason; an aggregate over the whole epoch shouldn't hit
  // this, but we'd rather degrade than return a nonsensical date.
  if (!Number.isFinite(avgBlockMs) || avgBlockMs <= 0) {
    return startMs + BLOCKS_PER_EPOCH * 600 * 1000;
  }
  return endMs + (BLOCKS_PER_EPOCH - scanned) * avgBlockMs;
}

export async function registerBip110ScanRoute(
  app: FastifyInstance,
  deps: Bip110ScanDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string } }>(
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
        epochs: [],
        deployment: null,
        softfork_keys: null,
        signaling_blocks: [],
        error,
      });

      if (!rpcAvailable) {
        return empty('bitcoind RPC not configured');
      }

      const client = createBitcoindClient({ url, username: user, password });

      // #231 follow-up #3: range is now a two-option choice -
      // `current` (in-progress epoch) or `all` (everything since the
      // first known BIP 110 signaling block, 938,903). Anything else
      // resolves to `current` so a bad query param can't blow up
      // the scan.
      const range: Bip110ScanRange = req.query.range === 'all' ? 'all' : 'current';

      let info;
      try {
        info = await client.getBlockchainInfo();
      } catch (err) {
        return empty(`getblockchaininfo failed: ${(err as Error).message}`);
      }

      const tip = info.blocks;
      const { startHeight: start, currentEpochStart } = computeScanRange(tip, range);
      const heights = Array.from({ length: tip - start + 1 }, (_, i) => start + i);

      let deploymentSource: Record<string, unknown> | undefined = info.softforks;
      if (!deploymentSource) {
        try {
          const depInfo = await client.getDeploymentInfo();
          deploymentSource = depInfo.deployments;
        } catch {
          // getdeploymentinfo unavailable (older bitcoind build); proceed without.
        }
      }
      const deployment = findBip110Deployment(deploymentSource);
      const softfork_keys = deploymentSource ? Object.keys(deploymentSource).sort() : null;

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

      const epochs = bucketByEpoch(headers, start, currentEpochStart, tip);

      return {
        rpc_available: true,
        tip_height: tip,
        scanned: headers.length,
        signaling_count: signaling.length,
        signaling_pct: headers.length > 0 ? (signaling.length / headers.length) * 100 : 0,
        epochs,
        deployment,
        softfork_keys,
        signaling_blocks: signaling,
        error: null,
      };
    },
  );
}
