/**
 * Minimal JSON-RPC client for bitcoind. Used for payout observation on
 * the operator's local node (Umbrel etc.). We stay dependency-free and
 * stick to the subset we actually need.
 *
 * Methods exposed:
 *   - `getBlockchainInfo()` — for smoke checks and current chain height.
 *   - `scanTxoutSet(descriptor)` — sum of unspent outputs matching the
 *     descriptor (e.g. `addr(bc1…)`). Doesn't require the address to be
 *     imported in any wallet, which is why we prefer it over
 *     `listreceivedbyaddress` for the "collected BTC" card.
 *
 * Auth is HTTP Basic with `rpcuser:rpcpassword`. Targets the user's
 * Umbrel-style local node, so we keep retries conservative (one on 5xx /
 * network error).
 */

export interface BitcoindClientConfig {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class BitcoindError extends Error {
  public readonly code: number | null;
  public readonly rpcData: unknown;

  constructor(message: string, code: number | null = null, rpcData: unknown = null) {
    super(message);
    this.name = 'BitcoindError';
    this.code = code;
    this.rpcData = rpcData;
  }
}

interface JsonRpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
  id: string | number;
}

export interface BlockchainInfo {
  readonly chain: string;
  readonly blocks: number;
  readonly headers: number;
  readonly bestblockhash: string;
  readonly verificationprogress: number;
  readonly pruned: boolean;
  /**
   * Soft-fork deployment table. Vanilla Core reports a known set
   * (taproot, etc); Knots-patched builds add `bip110` (or similarly
   * named) when the BIP 110 patch is applied. Optional because the
   * shape varies and we only consume it as opaque data in the
   * BIP 110 scan route.
   */
  readonly softforks?: Record<string, unknown>;
}

export interface ScanTxoutSetResult {
  readonly success: boolean;
  readonly txouts: number;
  readonly height: number;
  readonly bestblock: string;
  readonly total_amount: number;
  readonly unspents: ReadonlyArray<{
    readonly txid: string;
    readonly vout: number;
    readonly scriptPubKey: string;
    readonly desc: string;
    readonly amount: number;
    readonly coinbase?: boolean;
    readonly height: number;
  }>;
}

export interface BlockHeader {
  /** 32-bit version field from the block header (signed-int range). */
  readonly version: number;
  readonly hash: string;
  readonly height: number;
  readonly time: number;
  readonly previousblockhash: string | null;
}

export interface BatchRequest {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export interface BitcoindClient {
  getBlockchainInfo(): Promise<BlockchainInfo>;
  scanTxoutSet(descriptors: readonly string[]): Promise<ScanTxoutSetResult>;
  /** Fetch the block header for a given block hash. Used to read
   *  the `version` field for soft-fork signaling detection (#94). */
  getBlockHeader(hash: string): Promise<BlockHeader>;
  /**
   * JSON-RPC batch: send N requests in a single HTTP round-trip and
   * receive results in the same order. Used by the BIP 110 scanner
   * (#95) to fetch 2016 block hashes / headers in two HTTP calls
   * instead of 2016. Throws on the first error in the batch.
   */
  batch<T>(requests: readonly BatchRequest[]): Promise<T[]>;
}

export function createBitcoindClient(config: BitcoindClientConfig): BitcoindClient {
  const fetchImpl = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');

  async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'braiins-autopilot', method, params });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new BitcoindError(`bitcoind RPC ${method}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401) {
      throw new BitcoindError('bitcoind RPC: 401 Unauthorized (check rpcuser/rpcpassword)', 401);
    }
    const text = await response.text();
    if (!response.ok && !text) {
      throw new BitcoindError(`bitcoind RPC ${method}: HTTP ${response.status}`, response.status);
    }

    let parsed: JsonRpcResponse<T>;
    try {
      parsed = JSON.parse(text) as JsonRpcResponse<T>;
    } catch {
      throw new BitcoindError(`bitcoind RPC ${method}: non-JSON response (HTTP ${response.status})`);
    }
    if (parsed.error) {
      throw new BitcoindError(
        `bitcoind RPC ${method}: ${parsed.error.message}`,
        parsed.error.code,
        parsed.error,
      );
    }
    return parsed.result as T;
  }

  async function batch<T>(requests: readonly BatchRequest[]): Promise<T[]> {
    if (requests.length === 0) return [];
    const body = JSON.stringify(
      requests.map((r, i) => ({
        jsonrpc: '1.0',
        id: i,
        method: r.method,
        params: r.params ?? [],
      })),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST',
        headers: {
          authorization: authHeader,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      throw new BitcoindError(`bitcoind RPC batch: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401) {
      throw new BitcoindError('bitcoind RPC: 401 Unauthorized (check rpcuser/rpcpassword)', 401);
    }
    const text = await response.text();
    if (!response.ok && !text) {
      throw new BitcoindError(`bitcoind RPC batch: HTTP ${response.status}`, response.status);
    }
    let parsed: JsonRpcResponse<T>[];
    try {
      parsed = JSON.parse(text) as JsonRpcResponse<T>[];
    } catch {
      throw new BitcoindError(`bitcoind RPC batch: non-JSON response (HTTP ${response.status})`);
    }
    if (!Array.isArray(parsed)) {
      throw new BitcoindError('bitcoind RPC batch: expected array response');
    }
    parsed.sort((a, b) => Number(a.id) - Number(b.id));
    return parsed.map((p) => {
      if (p.error) {
        throw new BitcoindError(`bitcoind RPC batch: ${p.error.message}`, p.error.code, p.error);
      }
      return p.result as T;
    });
  }

  return {
    getBlockchainInfo: () => call<BlockchainInfo>('getblockchaininfo'),
    scanTxoutSet: async (descriptors) => {
      // bitcoind only allows ONE concurrent scantxoutset. If a prior
      // scan orphaned (our HTTP timeout killed the fetch but the node
      // kept scanning), we abort it first. `abort` is idempotent —
      // harmless if nothing is running.
      try {
        await call<unknown>('scantxoutset', ['abort']);
      } catch {
        // abort fails if nothing is running; that's fine
      }
      const result = await call<ScanTxoutSetResult>('scantxoutset', ['start', descriptors]);
      return result;
    },
    getBlockHeader: (hash) => call<BlockHeader>('getblockheader', [hash, true]),
    batch,
  };
}
