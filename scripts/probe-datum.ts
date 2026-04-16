/**
 * Datum Gateway probe — discovers which API endpoints your local
 * Datum Gateway exposes and what data they return.
 *
 * Run from the same LAN as your Datum box:
 *   pnpm tsx scripts/probe-datum.ts
 *
 * Optional: override host/port via env:
 *   DATUM_HOST=192.168.1.50 DATUM_PORT=7152 pnpm tsx scripts/probe-datum.ts
 */

const HOST = process.env['DATUM_HOST'] ?? 'alkimia.mynetgear.com';
const PORT = Number(process.env['DATUM_PORT'] ?? '7152');
const BASE = `http://${HOST}:${PORT}`;

async function tryEndpoint(path: string, label: string): Promise<string | null> {
  const url = `${BASE}${path}`;
  console.log(`\n→ ${label}  (${url})`);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json, text/html' },
    });
    console.log(`  status: ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    console.log(`  content-type: ${ct}`);
    const body = await res.text();
    console.log(`  body length: ${body.length}`);
    if (body.length < 10_000) {
      console.log(body);
    } else {
      console.log(body.slice(0, 3_000) + '\n... (truncated)');
    }
    return body;
  } catch (err) {
    console.log(`  FAILED: ${(err as Error).message}`);
    return null;
  }
}

async function main() {
  console.log(`Probing Datum Gateway at ${BASE}\n`);

  // 1. Umbrel-API — the cleanest source if compiled in.
  const umbrel = await tryEndpoint('/umbrel-api', 'Umbrel API (JSON, conditional)');

  // 2. Homepage — always present, template-substituted HTML with hashrate.
  const home = await tryEndpoint('/', 'Homepage (HTML dashboard)');

  // 3. Clients page — per-worker table, may require admin auth.
  await tryEndpoint('/clients', 'Clients (per-worker, may need auth)');

  console.log('\n=== Summary ===');

  if (umbrel) {
    try {
      const parsed = JSON.parse(umbrel);
      console.log('✓ /umbrel-api returned valid JSON');
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('✗ /umbrel-api did not return valid JSON');
    }
  } else {
    console.log('✗ /umbrel-api not reachable');
  }

  if (home) {
    // Look for the hashrate estimate in the HTML.
    const hrMatch = home.match(/(\d+(?:\.\d+)?)\s*(?:Th\/s|Ph\/s|Eh\/s|Gh\/s)/i);
    if (hrMatch) {
      console.log(`✓ Homepage hashrate found: ${hrMatch[0]}`);
    } else {
      console.log('? Homepage reachable but no hashrate pattern found');
    }
  } else {
    console.log('✗ Homepage not reachable — Datum API may be disabled in your config');
    console.log('  Check datum_gateway_config.json → api.listen_port (default 7152)');
  }
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
