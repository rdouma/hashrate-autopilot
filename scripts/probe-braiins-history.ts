/**
 * Read-only probe: figure out what historical-bid data Braiins
 * actually exposes. We need this before designing the
 * "account_lifetime" vs "autopilot_only" toggle on the Money panel.
 *
 * Prints the raw shape of:
 *   - /v1/account/transactions  (all-time money movements)
 *   - /v1/spot/bid/current      (currently-active bids only — for
 *                                comparison)
 *
 * Reveals which fields identify "spent on hashrate" vs other movements
 * (deposits, withdrawals, fees, payouts). No mutations.
 *
 * Usage:
 *   SOPS_AGE_KEY_FILE=~/.config/braiins-hashrate/age.key \
 *     pnpm tsx scripts/probe-braiins-history.ts
 */

import { resolve } from 'node:path';

import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { loadSecrets } from '../packages/daemon/src/config/secrets.js';

async function main() {
  const projectRoot = process.cwd();
  const secretsPath = resolve(projectRoot, '.env.sops.yaml');
  const ageKeyPath =
    process.env['SOPS_AGE_KEY_FILE'] ??
    `${process.env['HOME']}/Library/Application Support/sops/age/keys.txt`;

  const secrets = await loadSecrets(secretsPath, {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath },
  });

  const owner = createBraiinsClient({ ownerToken: secrets.braiins_owner_token });

  // Endpoint is /v1/account/transaction (singular) per the OpenAPI
  // spec. /transactions returns "Unknown path".
  console.log('=== /v1/account/transaction?limit=200 (raw fetch) ===');
  const txRes = await fetch(
    'https://hashpower.braiins.com/v1/account/transaction?limit=200',
    {
      headers: {
        apikey: secrets.braiins_owner_token,
        accept: 'application/json',
      },
    },
  );
  console.log(`status: ${txRes.status}`);
  const txBody = await txRes.text();
  console.log(`length: ${txBody.length} chars`);
  if (txBody.length < 80_000) {
    console.log(txBody);
  } else {
    console.log(txBody.slice(0, 8_000) + '\n... (truncated)');
  }

  console.log('\n=== /v1/spot/bid/current (typed) ===');
  const cur = await owner.getCurrentBids();
  console.log(`active bids: ${cur.items?.length ?? 0}`);
  for (const it of cur.items ?? []) {
    console.log(
      `  id=${it.bid.id}  status=${it.bid.status}  ` +
        `amount=${it.bid.amount_sat}  ` +
        `consumed=${it.counters_committed?.amount_consumed_sat}  ` +
        `created=${it.bid.created}`,
    );
  }
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
