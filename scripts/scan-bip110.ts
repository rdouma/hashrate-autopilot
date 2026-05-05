/**
 * Scan recent blocks for BIP 110 (Reduced Data Temporary Softfork) signaling.
 *
 * Lookup target for testing the planned crown-marker UI (#94): given that
 * BIP 110 block-signaling is rare in early adoption, the operator needs
 * concrete heights/hashes to point the dashboard at.
 *
 * Detection:
 *   isBip110Signal = ((version & 0xe0000000) === 0x20000000)  // BIP 9 top-3 bits = 001
 *                 && ((version & (1 << 4)) !== 0)             // bit 4 set = BIP 110
 *
 * Why TypeScript over the prior bash/Electrum approach: bitcoind speaks
 * JSON-RPC batch (an array of requests in one HTTP call), so a 2016-block
 * scan is 2 round-trips instead of 2016. The bash loop over `nc -w 5`
 * pays a 5s idle timeout per block, ~3h for a full retarget window.
 *
 * Usage:
 *   BHA_BITCOIND_RPC_URL=http://192.168.1.121:8332 \
 *   BHA_BITCOIND_RPC_USER=user \
 *   BHA_BITCOIND_RPC_PASSWORD=pass \
 *     pnpm tsx scripts/scan-bip110.ts
 *
 *   pnpm tsx scripts/scan-bip110.ts --blocks 4032
 *   pnpm tsx scripts/scan-bip110.ts --rpc-url http://... --rpc-user u --rpc-pass p
 *
 * Credential resolution: env vars (same names the daemon uses) or CLI flags.
 * If you keep secrets in `.env.sops.yaml`, decrypt with `pnpm sops:edit` to
 * read them, then export the BHA_* vars in your shell before running.
 */

interface Args {
  rpcUrl: string;
  rpcUser: string;
  rpcPass: string;
  blocks: number;
  batchSize: number;
}

function parseArgs(argv: string[]): Args {
  let rpcUrl = process.env['BHA_BITCOIND_RPC_URL'] ?? '';
  let rpcUser = process.env['BHA_BITCOIND_RPC_USER'] ?? '';
  let rpcPass = process.env['BHA_BITCOIND_RPC_PASSWORD'] ?? '';
  let blocks = 2016;
  let batchSize = 200;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--rpc-url' && next) {
      rpcUrl = next;
      i += 1;
    } else if (a === '--rpc-user' && next) {
      rpcUser = next;
      i += 1;
    } else if (a === '--rpc-pass' && next) {
      rpcPass = next;
      i += 1;
    } else if (a === '--blocks' && next) {
      blocks = Number.parseInt(next, 10);
      i += 1;
    } else if (a === '--batch-size' && next) {
      batchSize = Number.parseInt(next, 10);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  if (!rpcUrl || !rpcUser || !rpcPass) {
    console.error('error: bitcoind RPC credentials missing');
    console.error('  set BHA_BITCOIND_RPC_URL, BHA_BITCOIND_RPC_USER, BHA_BITCOIND_RPC_PASSWORD');
    console.error('  or pass --rpc-url / --rpc-user / --rpc-pass');
    console.error("  see `pnpm tsx scripts/scan-bip110.ts --help`");
    process.exit(1);
  }
  if (!Number.isFinite(blocks) || blocks <= 0) {
    console.error('error: --blocks must be a positive integer');
    process.exit(1);
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    console.error('error: --batch-size must be a positive integer');
    process.exit(1);
  }
  return { rpcUrl, rpcUser, rpcPass, blocks, batchSize };
}

function printUsage(): void {
  console.log('Scan recent blocks for BIP 110 (Reduced Data Temporary Softfork) signaling.');
  console.log('');
  console.log('Usage:');
  console.log('  pnpm tsx scripts/scan-bip110.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --blocks N          number of blocks back from tip (default: 2016, one retarget window)');
  console.log('  --batch-size N      RPC batch size (default: 200)');
  console.log('  --rpc-url URL       override BHA_BITCOIND_RPC_URL');
  console.log('  --rpc-user USER     override BHA_BITCOIND_RPC_USER');
  console.log('  --rpc-pass PASS     override BHA_BITCOIND_RPC_PASSWORD');
  console.log('  -h, --help          show this and exit');
}

interface RpcRequest {
  jsonrpc: '1.0';
  id: number;
  method: string;
  params: unknown[];
}

interface RpcResponse<T> {
  id: number;
  result: T | null;
  error: { code: number; message: string } | null;
}

async function rpcBatch<T>(args: Args, requests: RpcRequest[]): Promise<T[]> {
  const auth = 'Basic ' + Buffer.from(`${args.rpcUser}:${args.rpcPass}`).toString('base64');
  const res = await fetch(args.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(requests),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`bitcoind RPC HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  const responses = (await res.json()) as RpcResponse<T>[];
  responses.sort((a, b) => a.id - b.id);
  return responses.map((r) => {
    if (r.error) throw new Error(`bitcoind RPC error: ${r.error.message}`);
    return r.result as T;
  });
}

async function rpcSingle<T>(args: Args, method: string, params: unknown[] = []): Promise<T> {
  const [result] = await rpcBatch<T>(args, [{ jsonrpc: '1.0', id: 1, method, params }]);
  return result as T;
}

interface BlockchainInfo {
  blocks: number;
  bestblockhash: string;
  softforks?: Record<
    string,
    {
      type: string;
      active: boolean;
      bip9?: {
        status: string;
        bit?: number;
        statistics?: { count: number; elapsed: number; threshold: number; period: number };
      };
    }
  >;
}

interface BlockHeader {
  hash: string;
  height: number;
  version: number;
  versionHex: string;
  time: number;
}

function isBip110Signal(version: number): boolean {
  return (version & 0xe000_0000) === 0x2000_0000 && (version & 0x10) !== 0;
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function formatTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`bitcoind RPC: ${args.rpcUrl}`);

  const info = await rpcSingle<BlockchainInfo>(args, 'getblockchaininfo');
  console.log(`tip height:  ${info.blocks}`);

  const candidateKeys = ['bip110', 'reduceddatasoftfork', 'reduceddata', 'reduced_data'];
  let softforkReport: { name: string; data: unknown } | null = null;
  for (const k of candidateKeys) {
    if (info.softforks?.[k]) {
      softforkReport = { name: k, data: info.softforks[k] };
      break;
    }
  }
  if (softforkReport) {
    console.log(`bip110 deployment (${softforkReport.name}):`);
    console.log('  ' + JSON.stringify(softforkReport.data, null, 2).replace(/\n/g, '\n  '));
  } else {
    console.log('bip110 deployment: not reported by node (vanilla Core; only Knots-patched');
    console.log('                   builds expose explicit signaling stats. Block-by-block');
    console.log('                   scan still works.)');
  }
  console.log('');

  const tip = info.blocks;
  const start = Math.max(0, tip - args.blocks + 1);
  const heights = Array.from({ length: tip - start + 1 }, (_, i) => start + i);

  console.log(`scanning ${heights.length} blocks: ${start}..${tip}`);

  console.log('phase 1: getblockhash...');
  const heightBatches = chunk(heights, args.batchSize);
  const hashes: string[] = [];
  for (let bi = 0; bi < heightBatches.length; bi += 1) {
    const batch = heightBatches[bi]!;
    const requests: RpcRequest[] = batch.map((h, idx) => ({
      jsonrpc: '1.0',
      id: idx,
      method: 'getblockhash',
      params: [h],
    }));
    const results = await rpcBatch<string>(args, requests);
    hashes.push(...results);
    process.stdout.write(`\r  batch ${bi + 1}/${heightBatches.length}  (${hashes.length}/${heights.length})`);
  }
  console.log('');

  console.log('phase 2: getblockheader...');
  const hashBatches = chunk(hashes, args.batchSize);
  const headers: BlockHeader[] = [];
  for (let bi = 0; bi < hashBatches.length; bi += 1) {
    const batch = hashBatches[bi]!;
    const requests: RpcRequest[] = batch.map((hash, idx) => ({
      jsonrpc: '1.0',
      id: idx,
      method: 'getblockheader',
      params: [hash, true],
    }));
    const results = await rpcBatch<BlockHeader>(args, requests);
    headers.push(...results);
    process.stdout.write(`\r  batch ${bi + 1}/${hashBatches.length}  (${headers.length}/${heights.length})`);
  }
  console.log('');
  console.log('');

  const signaling = headers.filter((h) => isBip110Signal(h.version));
  const pct = headers.length > 0 ? (signaling.length / headers.length) * 100 : 0;

  console.log(`scanned: ${headers.length} blocks`);
  console.log(`bip110 signaling: ${signaling.length}  (${pct.toFixed(2)}%)`);
  console.log('');

  if (signaling.length === 0) {
    console.log('no BIP 110 signaling blocks in scan range.');
    console.log('  - try a larger window: --blocks 8064 (4 retarget periods)');
    console.log("  - block-level signaling can be much rarer than node-level (~2.4% nodes,");
    console.log('    block rate depends on which mining pools have configured Knots).');
    return;
  }

  const HEIGHT = 9;
  const TIME = 22;
  const VER = 14;
  console.log(
    'height'.padEnd(HEIGHT) +
      'time (UTC)'.padEnd(TIME) +
      'version'.padEnd(VER) +
      'block hash / mempool.space',
  );
  console.log(
    '-'.repeat(HEIGHT - 1) +
      ' ' +
      '-'.repeat(TIME - 1) +
      ' ' +
      '-'.repeat(VER - 1) +
      ' ' +
      '-'.repeat(40),
  );
  for (const h of signaling) {
    const verHex = '0x' + h.version.toString(16).padStart(8, '0');
    console.log(
      String(h.height).padEnd(HEIGHT) +
        formatTime(h.time).padEnd(TIME) +
        verHex.padEnd(VER) +
        `https://mempool.space/block/${h.hash}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
