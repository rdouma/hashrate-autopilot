/**
 * Block-header version lookup with persistent + in-memory caching.
 *
 * Used by `/api/ocean` to mark BIP-110-signaling blocks with a
 * crown on the chart (#94). Block headers are immutable, so once
 * we've fetched a version for a hash we never need to re-fetch it.
 *
 * Backends, in preference order:
 *   1. bitcoind RPC (`getblockheader <hash>`) - one call, returns
 *      the parsed header including `version`. Preferred when the
 *      operator has a node configured (the common Umbrel case).
 *   2. Electrs (`blockchain.block.header <height>`) - returns the
 *      raw 80-byte header; we parse the first 4 bytes as a
 *      little-endian signed-int. Needs `height` since electrum's
 *      protocol is height-keyed.
 *   3. Neither configured: returns null. The chart degrades to the
 *      standard block marker for blocks we couldn't look up.
 *
 * Negative caching (5 min TTL): a single failure doesn't get cached
 * forever (so a bitcoind restart self-heals on the next refresh)
 * but we don't hammer the node every 30s for a hash we just failed.
 */

import type { Kysely } from 'kysely';
import type { BitcoindClient } from '@braiins-hashrate/bitcoind-client';

import type { Database } from '../state/types.js';
import type { ElectrsClient } from './electrs-client.js';

export interface BlockVersionLookupOptions {
  readonly db: Kysely<Database>;
  readonly bitcoind?: BitcoindClient | null;
  readonly electrs?: ElectrsClient | null;
  readonly log?: (msg: string) => void;
  readonly now?: () => number;
}

const NEGATIVE_CACHE_TTL_MS = 5 * 60_000;

export class BlockVersionService {
  private readonly db: Kysely<Database>;
  private readonly bitcoind: BitcoindClient | null;
  private readonly electrs: ElectrsClient | null;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly memCache = new Map<string, number>();
  private readonly negCache = new Map<string, number>();
  private warmed = false;

  constructor(opts: BlockVersionLookupOptions) {
    this.db = opts.db;
    this.bitcoind = opts.bitcoind ?? null;
    this.electrs = opts.electrs ?? null;
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Returns the block-header version for the given hash, or null
   * if neither backend is configured / both returned an error.
   * Caches positively forever (in-memory + persistent), negatively
   * for NEGATIVE_CACHE_TTL_MS.
   */
  async getVersion(hash: string, height: number | null): Promise<number | null> {
    if (!hash) return null;

    const cached = this.memCache.get(hash);
    if (cached !== undefined) return cached;

    if (!this.warmed) {
      await this.warmCacheFromDb();
    }
    const reCached = this.memCache.get(hash);
    if (reCached !== undefined) return reCached;

    const negAt = this.negCache.get(hash);
    if (negAt !== undefined && this.now() - negAt < NEGATIVE_CACHE_TTL_MS) {
      return null;
    }

    const version = await this.fetchFromBackend(hash, height);
    if (version === null) {
      this.negCache.set(hash, this.now());
      return null;
    }
    this.memCache.set(hash, version);
    this.negCache.delete(hash);
    try {
      await this.db
        .insertInto('block_version_cache')
        .values({ block_hash: hash, block_version: version, fetched_at: this.now() })
        .onConflict((oc) => oc.column('block_hash').doNothing())
        .execute();
    } catch (err) {
      this.log(`[block-version] persist failed for ${hash}: ${(err as Error).message}`);
    }
    return version;
  }

  private async fetchFromBackend(hash: string, height: number | null): Promise<number | null> {
    if (this.bitcoind) {
      try {
        const header = await this.bitcoind.getBlockHeader(hash);
        return header.version;
      } catch (err) {
        this.log(`[block-version] bitcoind ${hash}: ${(err as Error).message}`);
      }
    }
    if (this.electrs && height !== null) {
      try {
        return await this.electrs.getBlockVersionByHeight(height);
      } catch (err) {
        this.log(`[block-version] electrs ${height}: ${(err as Error).message}`);
      }
    }
    return null;
  }

  private async warmCacheFromDb(): Promise<void> {
    if (this.warmed) return;
    this.warmed = true;
    try {
      const rows = await this.db
        .selectFrom('block_version_cache')
        .select(['block_hash', 'block_version'])
        .execute();
      for (const r of rows) this.memCache.set(r.block_hash, r.block_version);
    } catch (err) {
      this.log(`[block-version] cache warm failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Detect BIP-110 signaling from a block-header version field.
 * BIP 9 deployment: top 3 bits == 0b001, then bit-4 set means
 * BIP 110 signaled. Returns null when version is null (unknown).
 */
export function signalsBip110(version: number | null): boolean | null {
  if (version === null) return null;
  // Top 3 bits must be 0b001 (BIP 9 version-bits format).
  const topBits = (version >>> 29) & 0b111;
  if (topBits !== 0b001) return false;
  // Bit 4 is the BIP 110 signaling bit.
  return (version & (1 << 4)) !== 0;
}
