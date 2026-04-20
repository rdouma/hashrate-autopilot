/**
 * Local, privacy-preserving enrichment of Ocean pool blocks via the
 * operator's own bitcoind node — no external HTTP, no third-party
 * block-explorer ever learns about this node.
 *
 * For each block hash we issue a single `getblock <hash> 2` RPC
 * call, pull the coinbase scriptSig out of tx[0].vin[0], scan it
 * for printable-ASCII runs, and pick the first operator-meaningful
 * token as the `miner_tag`. `pool_name` is hardcoded to "OCEAN"
 * because the blocks are fed to us from Ocean's own API — they're
 * all Ocean blocks by construction.
 *
 * Coinbase layout: BIP34 height push + arbitrary "extra nonce" data
 * where miners embed self-identifying ASCII tags, typically as
 * `/SomeLabel/` slash-delimited segments. Stratum V2 / DATUM-template
 * miners on Ocean (Simple Mining, ORM, etc.) use the same convention.
 */

import type { BitcoindClient } from '@braiins-hashrate/bitcoind-client';

export interface BlockEnrichment {
  readonly pool_name: string | null;
  readonly miner_tag: string | null;
}

/**
 * Fetch a single block's enrichment. Returns `{ pool_name: null,
 * miner_tag: null }` rather than throwing when bitcoind returns an
 * error or the coinbase yields nothing useful — callers treat the
 * null as "retry next time".
 */
export async function enrichFromBitcoind(
  client: BitcoindClient,
  block_hash: string,
): Promise<BlockEnrichment> {
  try {
    const block = await client.getBlock(block_hash);
    const coinbaseHex = block.tx?.[0]?.vin?.[0]?.coinbase;
    if (!coinbaseHex) return { pool_name: 'OCEAN', miner_tag: null };
    const miner_tag = extractMinerTag(coinbaseHex);
    return { pool_name: 'OCEAN', miner_tag };
  } catch {
    return { pool_name: null, miner_tag: null };
  }
}

/**
 * Walk the coinbase scriptSig hex, decode each byte to ASCII, and
 * return the first meaningful operator token. "Meaningful" =
 * printable ASCII, length 2–40, alphanumeric + punctuation the
 * mining ecosystem uses for labels (space, `_`, `-`, `.`, `#`).
 * Segments that are purely numeric, look like paths, or are shorter
 * than 2 characters are skipped. The search prefers `/Foo/` style
 * slash-delimited tokens (the overwhelming convention) but falls
 * back to any printable run that passes the filters.
 *
 * Exported for tests.
 */
export function extractMinerTag(coinbaseHex: string): string | null {
  const bytes = hexToBytes(coinbaseHex);
  if (bytes.length === 0) return null;
  // Build an ASCII projection where non-printable bytes become
  // field separators — then we can split on non-printable runs and
  // have a nice segment list.
  let ascii = '';
  for (const b of bytes) {
    ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '\x00';
  }
  // First try slash-delimited tokens (mining convention).
  const slashTokens = ascii.split(/[\x00/]/).map((s) => s.trim()).filter(Boolean);
  for (const tok of slashTokens) {
    if (isMeaningfulToken(tok)) return tok;
  }
  // Fallback: any printable-ASCII run separated by non-printables.
  const runs = ascii.split('\x00').map((s) => s.trim()).filter(Boolean);
  for (const run of runs) {
    if (isMeaningfulToken(run)) return run;
  }
  return null;
}

function isMeaningfulToken(tok: string): boolean {
  if (tok.length < 2 || tok.length > 40) return false;
  if (/^\d+$/.test(tok)) return false;
  if (!/^[A-Za-z0-9 _\-.#]+$/.test(tok)) return false;
  // Reject tokens without at least one letter — those are usually
  // version numbers or junk, not operator identifiers.
  if (!/[A-Za-z]/.test(tok)) return false;
  return true;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
