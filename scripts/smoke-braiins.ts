/**
 * M1.4 smoke test: call the public Braiins market endpoint and print the
 * result. Proves the OpenAPI codegen → typed client → live API chain works
 * end-to-end, without needing any API key.
 *
 * Usage:  pnpm tsx scripts/smoke-braiins.ts
 */

import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

async function main() {
  const client = createBraiinsClient();

  console.log('→ GET /spot/stats');
  const stats = await client.getStats();
  console.log(JSON.stringify(stats, null, 2));

  console.log('\n→ GET /spot/orderbook');
  const orderbook = await client.getOrderbook();
  const bidCount = orderbook.bids?.length ?? 0;
  const askCount = orderbook.asks?.length ?? 0;
  const topBid = orderbook.bids?.[0];
  const topAsk = orderbook.asks?.[0];
  console.log(`bids: ${bidCount}   asks: ${askCount}`);
  if (topBid) console.log(`top bid: ${JSON.stringify(topBid)}`);
  if (topAsk) console.log(`top ask: ${JSON.stringify(topAsk)}`);
}

main().catch((err) => {
  console.error('\nSmoke test failed:');
  console.error(err);
  process.exit(1);
});
