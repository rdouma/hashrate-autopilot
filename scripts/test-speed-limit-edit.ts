/**
 * Live-API test: does PUT /spot/bid accept `new_speed_limit_ph`?
 *
 * The OpenAPI spec says yes (SpotEditBidRequest.new_speed_limit_ph,
 * "If not provided, speed limit is not changed"), but we want
 * empirical confirmation before designing the target-hashrate change
 * flow around it.
 *
 * The test:
 *   1. List current owned bids, pick the first ACTIVE one
 *   2. Bump its speed_limit_ph by +0.01 PH/s (smallest safe delta)
 *   3. Re-fetch and verify the change took effect
 *   4. Revert to the original speed
 *   5. Re-fetch and verify revert
 *
 * Side effect: the daemon's autopilot may notice and try to react.
 * The two PUTs land back-to-back so the bid is at its original speed
 * within a few seconds, minimizing window for autopilot mischief.
 *
 * Usage:  pnpm tsx scripts/test-speed-limit-edit.ts
 */

import { resolve } from 'node:path';

import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { loadSecrets } from '../packages/daemon/src/config/secrets.js';

const SLEEP_MS = 1500;
const DELTA_PH = 0.01;

async function main() {
  const projectRoot = process.cwd();
  const secretsPath = resolve(projectRoot, '.env.sops.yaml');
  const ageKeyPath =
    process.env['SOPS_AGE_KEY_FILE'] ??
    `${process.env['HOME']}/Library/Application Support/sops/age/keys.txt`;

  console.log(`secrets: ${secretsPath}`);
  console.log(`age key: ${ageKeyPath}`);
  const secrets = await loadSecrets(secretsPath, {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath },
  });

  const owner = createBraiinsClient({ ownerToken: secrets.braiins_owner_token });

  console.log('\n→ GET /spot/bid/current');
  const bids = await owner.getCurrentBids();
  console.log(`account has ${bids.items?.length ?? 0} bid(s)`);
  for (const it of bids.items ?? []) {
    console.log(
      `  id=${it.bid.id}  status=${it.bid.status}  ` +
        `speed_limit=${it.bid.speed_limit_ph} PH/s  ` +
        `price=${it.bid.price_sat} sat/EH/day  ` +
        `avg_speed=${it.state_estimate.avg_speed_ph?.toFixed(3)} PH/s`,
    );
  }

  const target = (bids.items ?? []).find(
    (it) => it.bid.status === 'BID_STATUS_ACTIVE' && it.bid.id,
  );
  if (!target) {
    console.error('\nNo ACTIVE bid found — cannot test. Place a bid and retry.');
    process.exit(1);
  }

  const bidId = target.bid.id!;
  const original = target.bid.speed_limit_ph ?? 0;
  const bumped = round2(original + DELTA_PH);
  console.log(`\n→ PUT /spot/bid  bid_id=${bidId}  new_speed_limit_ph=${bumped}`);
  try {
    await owner.editBid({
      bid_id: bidId,
      // OptionalDouble is `{ value: number }` per OpenAPI, not a bare scalar.
      new_speed_limit_ph: { value: bumped },
    } as unknown as Parameters<typeof owner.editBid>[0]);
    console.log('  PUT returned OK');
  } catch (err) {
    const e = err as { status?: number; body?: unknown; message?: string };
    console.error('  PUT FAILED:', e.message);
    console.error('  status:', e.status, '  body:', JSON.stringify(e.body));
    process.exit(2);
  }

  await sleep(SLEEP_MS);

  console.log('\n→ GET /spot/bid/current  (verify bump)');
  const after = await owner.getCurrentBids();
  const updated = (after.items ?? []).find((it) => it.bid.id === bidId);
  if (!updated) {
    console.error('  bid disappeared from listing!');
    process.exit(3);
  }
  console.log(`  speed_limit_ph = ${updated.bid.speed_limit_ph} (expected ~${bumped})`);
  const accepted = Math.abs((updated.bid.speed_limit_ph ?? 0) - bumped) < 0.001;
  console.log(`  result: ${accepted ? '✓ change applied' : '✗ change ignored / partially applied'}`);

  console.log(`\n→ PUT /spot/bid  bid_id=${bidId}  new_speed_limit_ph=${original}  (revert)`);
  try {
    await owner.editBid({
      bid_id: bidId,
      new_speed_limit_ph: { value: original },
    } as unknown as Parameters<typeof owner.editBid>[0]);
    console.log('  PUT returned OK');
  } catch (err) {
    const e = err as { status?: number; body?: unknown; message?: string };
    console.error('  PUT FAILED on revert:', e.message);
    console.error('  status:', e.status, '  body:', JSON.stringify(e.body));
    process.exit(4);
  }

  await sleep(SLEEP_MS);

  console.log('\n→ GET /spot/bid/current  (verify revert)');
  const final = await owner.getCurrentBids();
  const reverted = (final.items ?? []).find((it) => it.bid.id === bidId);
  console.log(`  speed_limit_ph = ${reverted?.bid.speed_limit_ph} (expected ~${original})`);

  console.log('\n=== verdict ===');
  console.log(
    accepted
      ? 'Braiins accepts new_speed_limit_ph on PUT /spot/bid. Design A (in-place edit) is viable.'
      : 'Braiins ignored or partially applied new_speed_limit_ph. Use Design B (cancel + recreate).',
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('\nTest failed unexpectedly:');
  console.error(err);
  process.exit(99);
});
