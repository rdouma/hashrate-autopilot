/**
 * Electrum TCP JSON-RPC client for Electrs.
 *
 * Connects to a standard Electrs instance (port 50001, no SSL) and
 * queries address balance via `blockchain.scripthash.get_balance`.
 * Instant indexed lookups — no full-UTXO-set scan like scantxoutset.
 *
 * The `scripthash` that Electrum protocol requires is:
 *   SHA256(scriptPubKey) with bytes reversed → hex string.
 *
 * We compute that from the operator's bech32/bech32m BTC address
 * using the `bech32` package + Node crypto.
 */

import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

import { bech32, bech32m } from 'bech32';

export interface ElectrsConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

export interface ElectrsBalance {
  readonly confirmed: number;
  readonly unconfirmed: number;
}

export interface ElectrsClient {
  getBalance(address: string): Promise<ElectrsBalance>;
  /**
   * Fetch the 4-byte version field from the block header at the
   * given height. Returns the parsed signed-int. Used to detect
   * BIP-110 signaling for the chart's crown marker (#94). Electrs's
   * `blockchain.block.header(height)` returns the raw 80-byte header
   * as hex; the version sits in the first 4 bytes, little-endian.
   */
  getBlockVersionByHeight(height: number): Promise<number>;
  close(): void;
}

export async function createElectrsClient(config: ElectrsConfig): Promise<ElectrsClient> {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const socket = new Socket();
  let buffer = '';
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      resolve();
    });
    socket.once('error', (err) => reject(new Error(`Electrs connect failed: ${err.message}`)));
    socket.once('timeout', () => reject(new Error('Electrs connect timeout')));
    socket.connect(config.port, config.host);
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`Electrs RPC error: ${JSON.stringify(msg.error)}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // malformed line; ignore
      }
    }
  });

  function call<T>(method: string, params: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Electrs RPC ${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      socket.write(msg);
    });
  }

  // Handshake: server.version is required by most Electrum servers.
  await call<[string, string]>('server.version', ['braiins-autopilot', '1.4']);

  return {
    async getBalance(address: string): Promise<ElectrsBalance> {
      const scripthash = addressToScripthash(address);
      const result = await call<{ confirmed: number; unconfirmed: number }>(
        'blockchain.scripthash.get_balance',
        [scripthash],
      );
      return { confirmed: result.confirmed, unconfirmed: result.unconfirmed };
    },
    async getBlockVersionByHeight(height: number): Promise<number> {
      const headerHex = await call<string>('blockchain.block.header', [height]);
      // The header is at least 80 bytes (160 hex chars). First 4
      // bytes are the version field, little-endian.
      if (typeof headerHex !== 'string' || headerHex.length < 8) {
        throw new Error(`Electrs RPC blockchain.block.header(${height}): malformed header`);
      }
      const buf = Buffer.from(headerHex.slice(0, 8), 'hex');
      return buf.readInt32LE(0);
    },
    close() {
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Address → Electrum scripthash
// ---------------------------------------------------------------------------

export function addressToScripthash(address: string): string {
  const scriptPubKey = addressToScriptPubKey(address);
  const hash = createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

function addressToScriptPubKey(address: string): Buffer {
  if (address.startsWith('bc1p') || address.startsWith('tb1p')) {
    // Bech32m — P2TR (witness v1, 32-byte key)
    const decoded = bech32m.decode(address);
    const version = decoded.words[0]!;
    const program = Buffer.from(bech32m.fromWords(decoded.words.slice(1)));
    return witnessScript(version, program);
  }
  if (address.startsWith('bc1') || address.startsWith('tb1')) {
    // Bech32 — P2WPKH (v0, 20 bytes) or P2WSH (v0, 32 bytes)
    const decoded = bech32.decode(address);
    const version = decoded.words[0]!;
    const program = Buffer.from(bech32.fromWords(decoded.words.slice(1)));
    return witnessScript(version, program);
  }
  throw new Error(
    `Only bech32/bech32m (bc1…) addresses are supported. Got: ${address.slice(0, 8)}…`,
  );
}

function witnessScript(version: number, program: Buffer): Buffer {
  // OP_<version> <push_length> <program>
  const versionOpcode = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.concat([Buffer.from([versionOpcode, program.length]), program]);
}
