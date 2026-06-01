/**
 * #241: reproduce Taliesin's situation locally and verify gap-fill
 * actually inserts rows. After three rounds of blind-ship + "still
 * broken" iterations, the operator told me to run it locally with
 * real-shaped data instead of guessing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../state/db.js';
import { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import { runGapBackfill } from './gap-backfill.js';
import { runPoolLuckRecompute } from './pool-luck-recompute.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Block heights matching reality: Bitcoin block 951,552 is a retarget
// boundary (951,552 % 2016 === 0). Block 953,568 is the next retarget.
const RETARGET_A = 951_552;
const RETARGET_B = 953_568;

const RETARGET_A_TIME_MS = Date.UTC(2026, 4, 29, 10, 29, 46); // 2026-05-29 10:29:46 UTC
const RETARGET_B_TIME_MS = Date.UTC(2026, 5, 1, 20, 59, 34); // 2026-06-01 20:59:34 UTC

const DIFF_BEFORE = 134_000_000_000_000;
const DIFF_AFTER_A = 136_610_000_000_000;
const DIFF_AFTER_B = 138_960_000_000_000;

const PREV_TICK_AT = Date.UTC(2026, 4, 28, 12, 0, 0); // 2026-05-28 12:00 UTC
const LAST_TICK_AT = Date.UTC(2026, 5, 1, 22, 0, 0); // 2026-06-01 22:00 UTC

async function seedTickMetricsBoundary(
  handle: DatabaseHandle,
  tickAt: number,
  difficulty: number,
): Promise<void> {
  await handle.db
    .insertInto('tick_metrics')
    .values({
      tick_at: tickAt,
      delivered_ph: 3,
      target_ph: 1,
      floor_ph: 0.5,
      owned_bid_count: 1,
      unknown_bid_count: 0,
      our_primary_price_sat_per_eh_day: 46_000,
      best_bid_sat_per_eh_day: 61_000,
      best_ask_sat_per_eh_day: 45_000,
      fillable_ask_sat_per_eh_day: 47_000,
      hashprice_sat_per_eh_day: 45_500,
      max_bid_sat_per_eh_day: 49_000,
      available_balance_sat: 1_000_000,
      total_balance_sat: 1_000_000,
      datum_hashrate_ph: 3,
      ocean_hashrate_ph: 3,
      share_log_pct: 0.01,
      spend_sat: null,
      primary_bid_consumed_sat: null,
      network_difficulty: difficulty,
      estimated_block_reward_sat: 312_500_000,
      // Ocean pool hashrate ~24 EH/s = 24,000 PH/s. Don't put PH/s
      // value in EH/s magnitude or pool_share comes out > 1 and the
      // luck denominator blows up to a value that makes luck ~0.
      pool_hashrate_ph: 24_000,
      pool_active_workers: 60_000,
      braiins_total_deposited_sat: 0,
      braiins_total_spent_sat: 0,
      ocean_unpaid_sat: 491_682,
      paid_total_sat: 5_514_380,
      btc_usd_price: 76_000,
      btc_usd_price_source: 'coingecko',
      primary_bid_last_pause_reason: null,
      primary_bid_fee_paid_sat: 0,
      primary_bid_fee_rate_pct: 0,
      bid_edit_deadband_pct: 20,
      pool_blocks_24h_count: 8,
      pool_blocks_7d_count: 28,
      pool_blocks_30d_count: 110,
      pool_hashrate_ph_avg_24h: 24_000,
      pool_hashrate_ph_avg_7d: 24_000,
      pool_hashrate_ph_avg_30d: 24_000,
      pool_luck_24h: 1,
      pool_luck_7d: 1,
      pool_luck_30d: 1,
      braiins_reachable: 1,
      run_mode: 'DRY_RUN',
      action_mode: 'NORMAL',
    })
    .execute();
}

async function seedRecentPoolBlocks(handle: DatabaseHandle): Promise<void> {
  const repo = new PoolBlocksRepo(handle.db);
  // Spread some pool blocks: a few before the gap, some inside the gap
  // (to drive pool_luck step-changes that the chart should show), and
  // the latest one matches the screenshot ("last pool block #951,997
  // found 7h 45m ago" -> a few hours before LAST_TICK_AT).
  const blocks = [
    // Pre-gap blocks (so 30d window goes well back)
    { height: 940_000, timestamp_ms: PREV_TICK_AT - 30 * DAY },
    { height: 945_000, timestamp_ms: PREV_TICK_AT - 15 * DAY },
    { height: 950_000, timestamp_ms: PREV_TICK_AT - 3 * DAY },
    { height: 951_000, timestamp_ms: PREV_TICK_AT - 1 * DAY },
    // In-gap blocks (drive luck step-changes)
    { height: 951_600, timestamp_ms: RETARGET_A_TIME_MS + 30 * MIN },
    { height: 951_800, timestamp_ms: RETARGET_A_TIME_MS + 6 * HOUR },
    { height: 952_500, timestamp_ms: RETARGET_A_TIME_MS + 2 * DAY },
    { height: 953_000, timestamp_ms: RETARGET_B_TIME_MS - 6 * HOUR },
    { height: 953_500, timestamp_ms: RETARGET_B_TIME_MS - 30 * MIN },
    // Post-retarget-B block matching the screenshot label
    { height: 951_997, timestamp_ms: LAST_TICK_AT - 7 * HOUR - 45 * MIN },
  ].map((b) => ({
    ...b,
    block_hash: `dummy-hash-${b.height}`,
    total_reward_sat: 312_500_000,
    subsidy_sat: 312_500_000,
    fees_sat: 0,
    worker: null,
    username: null,
  }));
  await repo.upsertMany(blocks, Date.now());
}

describe('runGapBackfill - Taliesin reproduction (no bitcoindClient)', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    await seedTickMetricsBoundary(handle, PREV_TICK_AT, DIFF_BEFORE);
    await seedTickMetricsBoundary(handle, LAST_TICK_AT, DIFF_AFTER_B);
    await seedRecentPoolBlocks(handle);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('inserts synthetic ticks across the gap when bitcoindClient is undefined', async () => {
    const logs: string[] = [];
    await runGapBackfill({
      db: handle.db,
      poolBlocksRepo: new PoolBlocksRepo(handle.db),
      log: (msg) => logs.push(msg),
    });

    const syntheticRows = await handle.db
      .selectFrom('tick_metrics')
      .selectAll()
      .where('synthetic', '=', 1)
      .orderBy('tick_at', 'asc')
      .execute();

    console.log('Gap-backfill log lines:');
    for (const line of logs) console.log(`  ${line}`);
    console.log(`Synthetic rows inserted: ${syntheticRows.length}`);
    if (syntheticRows.length > 0) {
      console.log(`First: ${new Date(syntheticRows[0]!.tick_at).toISOString()}`);
      console.log(`Last:  ${new Date(syntheticRows.at(-1)!.tick_at).toISOString()}`);
      const diffs = new Set(syntheticRows.map((r) => r.network_difficulty));
      console.log(`Distinct difficulties: ${[...diffs].join(', ')}`);
    }

    // We expect SOMETHING to be inserted. If the count is 0, the bug
    // is reproduced and we have a debugging anchor.
    expect(syntheticRows.length).toBeGreaterThan(0);
  });

  it('recompute populates pool_luck_* on the inserted synthetics', async () => {
    await runGapBackfill({
      db: handle.db,
      poolBlocksRepo: new PoolBlocksRepo(handle.db),
    });
    await runPoolLuckRecompute({
      db: handle.db,
      poolBlocksRepo: new PoolBlocksRepo(handle.db),
    });

    const syntheticRows = await handle.db
      .selectFrom('tick_metrics')
      .selectAll()
      .where('synthetic', '=', 1)
      .orderBy('tick_at', 'asc')
      .execute();

    const withLuck30 = syntheticRows.filter((r) => r.pool_luck_30d !== null);
    const withCount30 = syntheticRows.filter((r) => r.pool_blocks_30d_count !== null);

    console.log(`Total synthetics: ${syntheticRows.length}`);
    console.log(`With pool_luck_30d non-null: ${withLuck30.length}`);
    console.log(`With pool_blocks_30d_count non-null: ${withCount30.length}`);
    if (withLuck30.length > 0) {
      const luckValues = withLuck30.map((r) => r.pool_luck_30d!).filter(Number.isFinite);
      console.log(`Distinct pool_luck_30d count: ${new Set(luckValues).size}`);
      console.log(`pool_luck_30d range: [${Math.min(...luckValues).toFixed(3)}, ${Math.max(...luckValues).toFixed(3)}]`);
    }

    expect(withLuck30.length).toBeGreaterThan(syntheticRows.length * 0.9);
    // The line should have visible structure - not a single value
    const distinctLuck = new Set(
      withLuck30.map((r) => Math.round((r.pool_luck_30d ?? 0) * 1000)),
    );
    expect(distinctLuck.size).toBeGreaterThan(10);
  });

  it('chart-API aggregation: 1w view (30-min buckets) reveals the marker', async () => {
    await runGapBackfill({
      db: handle.db,
      poolBlocksRepo: new PoolBlocksRepo(handle.db),
    });
    await runPoolLuckRecompute({
      db: handle.db,
      poolBlocksRepo: new PoolBlocksRepo(handle.db),
    });

    // Mimic the dashboard's 1w fetch: listAggregated with 30-min bucketMs.
    const sinceMs = PREV_TICK_AT - DAY;
    const bucketMs = 30 * MIN;
    const repo = new TickMetricsRepo(handle.db);
    const rows = await repo.listAggregated(sinceMs, bucketMs, 10_000);

    // Apply the chart's retarget detection (HashrateChart.tsx:564-609).
    const detected: { tick_at: number; prev: number; curr: number }[] = [];
    let prev: number | null = null;
    for (let i = 0; i < rows.length; i += 1) {
      const d = rows[i]!.network_difficulty;
      if (typeof d !== 'number' || !Number.isFinite(d)) continue;
      if (prev !== null && Math.abs(d - prev) / prev > 0.005) {
        // Find next non-null
        let next: number | null = null;
        for (let j = i + 1; j < rows.length; j += 1) {
          const nd = rows[j]!.network_difficulty;
          if (typeof nd === 'number' && Number.isFinite(nd)) {
            next = nd;
            break;
          }
        }
        if (next === null || Math.abs(next - d) / d <= 0.005) {
          detected.push({ tick_at: rows[i]!.tick_at, prev, curr: d });
        }
      }
      prev = d;
    }

    console.log(`30-min-bucket rows in 1w view: ${rows.length}`);
    console.log(`Retarget markers the chart would render: ${detected.length}`);
    for (const m of detected) {
      console.log(
        `  marker @ ${new Date(m.tick_at).toISOString()}: ${m.prev.toExponential(3)} -> ${m.curr.toExponential(3)} (+${(((m.curr - m.prev) / m.prev) * 100).toFixed(2)}%)`,
      );
    }

    expect(detected.length).toBeGreaterThanOrEqual(1);
  });
});
