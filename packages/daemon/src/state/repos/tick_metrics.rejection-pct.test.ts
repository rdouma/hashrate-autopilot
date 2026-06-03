/**
 * #243: braiinsRejectionPctSince math verification. Origin
 * 2026-06-02: shipped builds 573-578 without checking the math
 * against realistic data shapes; operator caught discrepancies
 * (6h showed 0.04%, All showed 0.17% or 0.3% on what they
 * believed was the same data). These tests pin the cases so the
 * next change doesn't have to be operator-detected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { TickMetricsRepo } from './tick_metrics.js';

const MIN = 60_000;

/**
 * Insert a tick_metrics row with only the fields needed for the
 * rejection-rate test. Other fields are stubbed with sane defaults.
 */
async function insertTick(
  handle: DatabaseHandle,
  tickAt: number,
  purchased: number | null,
  rejected: number | null,
): Promise<void> {
  await handle.db
    .insertInto('tick_metrics')
    .values({
      tick_at: tickAt,
      delivered_ph: 3,
      target_ph: 3,
      floor_ph: 1,
      owned_bid_count: 1,
      unknown_bid_count: 0,
      our_primary_price_sat_per_eh_day: 46_000,
      best_bid_sat_per_eh_day: null,
      best_ask_sat_per_eh_day: null,
      fillable_ask_sat_per_eh_day: null,
      hashprice_sat_per_eh_day: null,
      max_bid_sat_per_eh_day: 50_000,
      available_balance_sat: null,
      total_balance_sat: null,
      datum_hashrate_ph: null,
      ocean_hashrate_ph: null,
      share_log_pct: null,
      spend_sat: null,
      primary_bid_consumed_sat: null,
      network_difficulty: null,
      estimated_block_reward_sat: null,
      pool_hashrate_ph: null,
      pool_active_workers: null,
      braiins_total_deposited_sat: null,
      braiins_total_spent_sat: null,
      ocean_unpaid_sat: null,
      paid_total_sat: null,
      btc_usd_price: null,
      btc_usd_price_source: null,
      primary_bid_last_pause_reason: null,
      primary_bid_fee_paid_sat: null,
      primary_bid_fee_rate_pct: null,
      bid_edit_deadband_pct: 20,
      pool_blocks_24h_count: null,
      pool_blocks_7d_count: null,
      pool_blocks_30d_count: null,
      pool_hashrate_ph_avg_24h: null,
      pool_hashrate_ph_avg_7d: null,
      pool_hashrate_ph_avg_30d: null,
      pool_luck_24h: null,
      pool_luck_7d: null,
      pool_luck_30d: null,
      braiins_reachable: 1,
      run_mode: 'LIVE',
      action_mode: 'NORMAL',
      primary_bid_shares_purchased_m: purchased,
      primary_bid_shares_accepted_m:
        purchased !== null && rejected !== null ? purchased - rejected : null,
      primary_bid_shares_rejected_m: rejected,
    })
    .execute();
}

describe('TickMetricsRepo.braiinsRejectionPctSince', () => {
  let handle: DatabaseHandle;
  let repo: TickMetricsRepo;
  const T0 = 1_780_000_000_000;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new TickMetricsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('returns null when no counter samples in range', async () => {
    await insertTick(handle, T0, null, null);
    await insertTick(handle, T0 + MIN, null, null);
    expect(await repo.braiinsRejectionPctSince(null)).toBeNull();
  });

  it('happy path: contiguous tracking, one bid', async () => {
    // 60 ticks of 60s, purchased grows linearly, rejected grows
    // at 0.5% of purchased.
    for (let i = 0; i < 60; i += 1) {
      await insertTick(handle, T0 + i * MIN, 1000 * (i + 1), 5 * (i + 1));
    }
    // Δp = 1000 * 60 - 1000 = 59000, Δr = 5 * 60 - 5 = 295.
    // Rate = 295 / 59000 * 100 = 0.5%.
    const pct = await repo.braiinsRejectionPctSince(null);
    expect(pct).not.toBeNull();
    expect(pct).toBeCloseTo(0.5, 5);
  });

  it('range slice gives same rate as full-range when data is uniform', async () => {
    for (let i = 0; i < 60; i += 1) {
      await insertTick(handle, T0 + i * MIN, 1000 * (i + 1), 5 * (i + 1));
    }
    const all = await repo.braiinsRejectionPctSince(null);
    const half = await repo.braiinsRejectionPctSince(T0 + 30 * MIN);
    expect(all).toBeCloseTo(0.5, 5);
    expect(half).toBeCloseTo(0.5, 5);
  });

  it('REPRO: sparse early data + continuous late data gives DIFFERENT rates for All vs 6h', async () => {
    // The Clarent scenario from 2026-06-02. Build 571's first
    // deploy got the columns added + wrote a few ticks before
    // crashing. Then build 570 ran without the writing code -
    // many ticks pass with NULL counter values. Then cherry-pick
    // restores writing, continuous data resumes.
    //
    // Early bursts (T0): purchased = 100_000, rejected = 300.
    // Long gap of NULL rows.
    // Late continuous (T0 + 10h onward): purchased grows from
    // 195_000 to 197_000 (about 7 ticks of activity, real-shape).
    //
    // 6h window from T0 + 10h + 6h would include only the late
    // data. Δp = 2000, Δr = 1, rate = 0.05%.
    // All would include both - first = 100_000, last = 197_000.
    // Δp = 97_000, Δr = 1 + 622 - 300 = 323, rate = 0.33%.
    await insertTick(handle, T0, 100_000, 300);
    await insertTick(handle, T0 + MIN, 100_005, 300.5);
    await insertTick(handle, T0 + 2 * MIN, 100_010, 301);
    // Gap of nulls.
    for (let i = 0; i < 600; i += 1) {
      await insertTick(handle, T0 + (10 + i) * MIN, null, null);
    }
    // Resume continuous data ~10h later.
    const lateBase = T0 + 700 * MIN;
    await insertTick(handle, lateBase, 195_000, 622);
    await insertTick(handle, lateBase + MIN, 195_500, 622.2);
    await insertTick(handle, lateBase + 2 * MIN, 196_000, 622.3);
    await insertTick(handle, lateBase + 3 * MIN, 196_500, 622.5);
    await insertTick(handle, lateBase + 4 * MIN, 196_900, 622.6);
    await insertTick(handle, lateBase + 5 * MIN, 197_000, 622.7);
    // Make `now` look like just after lateBase + 5min for the 6h
    // boundary. We pass sinceMs explicitly so the test doesn't
    // depend on real time.
    const all = await repo.braiinsRejectionPctSince(null);
    const sixH = await repo.braiinsRejectionPctSince(lateBase - 6 * 60 * MIN);
    // All: Δp = 197000 - 100000 = 97000, Δr = 622.7 - 300 = 322.7
    //      rate = 322.7 / 97000 * 100 ≈ 0.333%
    // 6h:  Δp = 197000 - 195000 = 2000, Δr = 622.7 - 622 = 0.7
    //      rate = 0.7 / 2000 * 100 = 0.035%
    expect(all).toBeCloseTo(0.333, 2);
    expect(sixH).toBeCloseTo(0.035, 3);
    // They DIFFER intentionally - the math is doing what it claims
    // and the operator's surprise was actually surfacing real
    // earlier data they'd forgotten about.
    expect(all).not.toBeCloseTo(sixH!, 2);
  });

  it('bid rotation in range (Δp < 0): returns null', async () => {
    await insertTick(handle, T0, 100_000, 300);
    await insertTick(handle, T0 + MIN, 100_500, 302);
    // Bid rotation: counter resets.
    await insertTick(handle, T0 + 2 * MIN, 5_000, 10);
    await insertTick(handle, T0 + 3 * MIN, 7_000, 12);
    // first = (100_000, 300), last = (7_000, 12). Δp = -93000.
    expect(await repo.braiinsRejectionPctSince(null)).toBeNull();
  });

  it('Δrejected < 0 (counter went down between first and last): returns null', async () => {
    // Pathological/aggregation-artifact scenario - first cumulative
    // rejected higher than last. Guard against negative rate.
    await insertTick(handle, T0, 100_000, 600);
    await insertTick(handle, T0 + MIN, 101_000, 500);
    expect(await repo.braiinsRejectionPctSince(null)).toBeNull();
  });

  it('Δpurchased = 0 (counter flat): returns null', async () => {
    // Two non-null rows with identical purchased values - no shares
    // cleared. Rate is undefined.
    await insertTick(handle, T0, 100_000, 300);
    await insertTick(handle, T0 + MIN, 100_000, 300);
    expect(await repo.braiinsRejectionPctSince(null)).toBeNull();
  });

  it('untilMs upper-bounds the last sample', async () => {
    for (let i = 0; i < 60; i += 1) {
      await insertTick(handle, T0 + i * MIN, 1000 * (i + 1), 5 * (i + 1));
    }
    // until = T0 + 30min. first = T0 (1000, 5). last = T0 + 30min
    // (31000, 155). Δp = 30000, Δr = 150. Rate = 0.5%.
    const pct = await repo.braiinsRejectionPctSince(null, T0 + 30 * MIN);
    expect(pct).toBeCloseTo(0.5, 5);
  });
});
