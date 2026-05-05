/**
 * Backfill pool_luck_24h / pool_luck_7d for every existing
 * tick_metrics row using the unified gap-extending formula
 * implemented in `services/pool-luck.ts`.
 *
 * Why a script and not pure SQL: the formula needs `elapsed since
 * last pool block in window`, and we never persisted block
 * timestamps per tick. This script fetches the current
 * `recent_blocks` list from Ocean (covers the last week or so of
 * pool blocks) and uses those timestamps to compute elapsed for
 * each historical tick.
 *
 * Safe to re-run: the UPDATE writes the freshly computed value
 * regardless of what was there before, so running it twice produces
 * the same end state.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-pool-luck.ts
 *   pnpm tsx scripts/backfill-pool-luck.ts --db /custom/state.db
 */

import { resolve } from 'node:path';

import {
  openDatabase,
  closeDatabase,
  computePoolLuck,
  createOceanClient,
} from '@braiins-hashrate/daemon';

const DAY_MS = 24 * 60 * 60 * 1000;

interface Args {
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const projectRoot = process.cwd();
  let dbPath = resolve(projectRoot, 'data/state.db');
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--db' && argv[i + 1]) {
      dbPath = resolve(argv[i + 1]!);
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: pnpm tsx scripts/backfill-pool-luck.ts [--db <path>]');
      process.exit(0);
    }
  }
  return { dbPath };
}

async function main(): Promise<void> {
  const { dbPath } = parseArgs(process.argv.slice(2));
  console.log(`opening ${dbPath}`);
  const handle = await openDatabase({ path: dbPath });

  try {
    // Pull config to find the payout address; Ocean's recent_blocks
    // list is keyed by user but the public endpoint returns the
    // pool-wide block list which is what we want.
    const cfg = (await handle.db
      .selectFrom('config')
      .selectAll()
      .executeTakeFirstOrThrow()) as { btc_payout_address: string | null };
    if (!cfg.btc_payout_address) {
      console.error('no btc_payout_address configured; aborting');
      process.exit(1);
    }

    const oceanClient = createOceanClient();
    const stats = await oceanClient.fetchStats(cfg.btc_payout_address);
    if (!stats || stats.recent_blocks.length === 0) {
      console.error('Ocean fetch failed or returned no blocks; aborting');
      process.exit(1);
    }
    const blockTimestamps = stats.recent_blocks
      .map((b) => b.timestamp_ms)
      .filter((t) => t > 0);
    console.log(`fetched ${blockTimestamps.length} pool block timestamps from Ocean`);

    const rows = (await handle.db
      .selectFrom('tick_metrics')
      .select([
        'id',
        'tick_at',
        'pool_blocks_24h_count',
        'pool_blocks_7d_count',
        'pool_hashrate_ph_avg_24h',
        'pool_hashrate_ph_avg_7d',
        'pool_hashrate_ph',
        'network_difficulty',
      ])
      .orderBy('tick_at', 'asc')
      .execute()) as ReadonlyArray<{
      id: number;
      tick_at: number;
      pool_blocks_24h_count: number | null;
      pool_blocks_7d_count: number | null;
      pool_hashrate_ph_avg_24h: number | null;
      pool_hashrate_ph_avg_7d: number | null;
      pool_hashrate_ph: number | null;
      network_difficulty: number | null;
    }>;
    console.log(`scanning ${rows.length} tick rows`);

    let updated = 0;
    let nullified = 0;
    for (const r of rows) {
      const luck24 = computePoolLuck({
        tickAt: r.tick_at,
        countInWindow: r.pool_blocks_24h_count,
        // Pre-0056 rows have no trailing average; fall back to the
        // per-tick snapshot. Same fallback the chart used during the
        // transition.
        poolHashrateAvgPh: r.pool_hashrate_ph_avg_24h ?? r.pool_hashrate_ph,
        networkDifficulty: r.network_difficulty,
        windowMs: DAY_MS,
        recentBlockTimestampsMs: blockTimestamps,
      });
      const luck7 = computePoolLuck({
        tickAt: r.tick_at,
        countInWindow: r.pool_blocks_7d_count,
        poolHashrateAvgPh: r.pool_hashrate_ph_avg_7d ?? r.pool_hashrate_ph,
        networkDifficulty: r.network_difficulty,
        windowMs: 7 * DAY_MS,
        recentBlockTimestampsMs: blockTimestamps,
      });
      await handle.db
        .updateTable('tick_metrics')
        .set({ pool_luck_24h: luck24, pool_luck_7d: luck7 })
        .where('id', '=', r.id)
        .execute();
      if (luck24 === null && luck7 === null) nullified += 1;
      else updated += 1;
    }

    console.log(`done: ${updated} rows recomputed, ${nullified} rows still null (missing inputs)`);
  } finally {
    await closeDatabase(handle);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
