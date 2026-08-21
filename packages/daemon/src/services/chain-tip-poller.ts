/**
 * #335: polls bitcoind for the Bitcoin chain tip and caches whether the
 * tip block was found by Ocean and whether it signals BIP-110, for the
 * "block height" dashboard tile.
 *
 * getblockchaininfo is cheap and runs every interval; the full tip block
 * (needed for the coinbase pool tag and header version) is only re-fetched
 * when the height actually changes, so a steady chain costs one RPC call
 * per interval. Only constructed when bitcoind RPC is configured - without
 * a node the tile is hidden, so there's nothing to poll.
 */

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import { extractCoinbaseTags, isBip110Signal } from '../http/routes/bip110-scan.js';
import { defaultPoolIdentifier, type PoolIdentifier } from './coinbase-pools.js';

export interface ChainTipSnapshot {
  readonly height: number;
  readonly hash: string;
  readonly foundByOcean: boolean;
  readonly signalsBip110: boolean;
  /** Pool tag from the coinbase ("Ocean", "Foundry USA Pool", ...), or null. */
  readonly poolTag: string | null;
  /** Inner miner tag (mainly Ocean's per-miner identity), or null. */
  readonly minerTag: string | null;
  readonly fetchedAtMs: number;
}

interface BlockVerbosity1 {
  readonly tx: readonly string[];
}
interface RawCoinbaseTx {
  readonly vin: readonly { readonly coinbase?: string }[];
  readonly vout?: readonly {
    readonly scriptPubKey?: { readonly address?: string; readonly addresses?: readonly string[] };
  }[];
}

/**
 * Fallback tidy for a coinbase run when mempool's DB has no match:
 * strip wrapping punctuation ("(/Foo Pool/" -> "Foo Pool") and a
 * trailing slogan ("#dropgold") or block counter. Best-effort only -
 * the curated DB is the real quality path.
 */
export function cleanRawPoolTag(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  s = s.replace(/^[^A-Za-z0-9]+/, ''); // leading push bytes / slashes / "("
  s = s.replace(/[^A-Za-z0-9)]+$/, ''); // trailing slashes / punctuation
  s = s.replace(/\s*#\S+\s*$/, ''); // trailing "#dropgold" slogan
  s = s.replace(/\/\d+$/, ''); // trailing "/595" block counter
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : null;
}

export class ChainTipPoller {
  private snapshot: ChainTipSnapshot | null = null;
  private lastHeight = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** #373: last successful getblockchaininfo round-trip (any tip). */
  private lastRpcOkMs: number | null = null;
  /** #373: when polling began - the never-succeeded baseline. */
  private startedAtMs: number | null = null;
  private inFlight = false;
  private readonly intervalMs: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly pools: PoolIdentifier;

  constructor(
    private readonly client: BitcoindClient,
    opts: {
      intervalMs?: number;
      log?: (m: string) => void;
      now?: () => number;
      pools?: PoolIdentifier;
    } = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? ((): number => Date.now());
    this.pools = opts.pools ?? defaultPoolIdentifier;
  }

  /**
   * #373: reference timestamp for the node-staleness check - the last
   * successful RPC round-trip, or the poller start time while the node
   * has never answered this run. Null before start() (staleness
   * unknowable, treated as healthy).
   */
  getNodeHealthRefMs(): number | null {
    return this.lastRpcOkMs ?? this.startedAtMs;
  }

  start(): void {
    if (this.timer) return;
    this.startedAtMs = this.now();
    // Prime once so the tile isn't blank for a full interval after boot.
    void this.runOnce();
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      this.runOnce().finally(() => {
        this.inFlight = false;
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): ChainTipSnapshot | null {
    return this.snapshot;
  }

  async runOnce(): Promise<void> {
    try {
      const info = await this.client.getBlockchainInfo();
      // #373: node-health timestamp. Deliberately NOT snapshot.fetchedAtMs
      // - that only moves on a NEW tip, so a slow block (or a near-frozen
      // chain like post-split BIP110) would read as a dead node. This
      // stamps every successful RPC round-trip regardless of tip change.
      this.lastRpcOkMs = this.now();
      const height = info.blocks;
      // Same tip as last poll: keep the cached Ocean/BIP-110 verdict.
      if (height === this.lastHeight && this.snapshot) return;

      const hash = info.bestblockhash;
      const header = await this.client.getBlockHeader(hash);
      const signalsBip110 = isBip110Signal(header.version);

      let foundByOcean = false;
      let poolTag: string | null = null;
      let minerTag: string | null = null;
      try {
        const [block] = await this.client.batch<BlockVerbosity1>([
          { method: 'getblock', params: [hash, 1] },
        ]);
        const cbTxid = block?.tx[0];
        if (cbTxid) {
          const [tx] = await this.client.batch<RawCoinbaseTx>([
            { method: 'getrawtransaction', params: [cbTxid, true, hash] },
          ]);
          const scriptSig = tx?.vin[0]?.coinbase;
          if (scriptSig) {
            const tags = extractCoinbaseTags(scriptSig);
            if (tags.pool === 'Ocean') {
              // Ocean is handled specially: the pool is "Ocean" and the
              // inner run is the per-miner identity (kept as the worker).
              poolTag = 'Ocean';
              minerTag = tags.miner;
              foundByOcean = true;
            } else {
              // Everyone else: resolve the canonical pool name from
              // mempool's curated DB (output-address or coinbase-tag
              // match), falling back to the tidied raw run. No worker -
              // a public pool's coinbase carries a slogan, not a miner.
              const outputAddresses = (tx?.vout ?? []).flatMap((o) => {
                const spk = o.scriptPubKey;
                if (!spk) return [];
                return spk.address ? [spk.address] : (spk.addresses ?? []);
              });
              const ident = this.pools.identify(scriptSig, outputAddresses);
              poolTag = ident?.name ?? cleanRawPoolTag(tags.pool);
              minerTag = null;
            }
          }
        }
      } catch {
        // Coinbase enrichment is best-effort; height + BIP-110 still cache.
      }

      this.snapshot = { height, hash, foundByOcean, signalsBip110, poolTag, minerTag, fetchedAtMs: this.now() };
      this.lastHeight = height;
    } catch (err) {
      this.log(`[chain-tip] poll failed: ${(err as Error).message}`);
    }
  }
}
