import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { TickMetricsRepo, type InsertTickMetricArgs } from './tick_metrics.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function sampleRow(overrides: Partial<InsertTickMetricArgs> = {}): InsertTickMetricArgs {
  return {
    tick_at: 0,
    delivered_ph: 1.0,
    target_ph: 1.5,
    floor_ph: 1.0,
    owned_bid_count: 1,
    unknown_bid_count: 0,
    our_primary_price_sat_per_eh_day: 46_000_000,
    best_bid_sat_per_eh_day: 45_000_000,
    best_ask_sat_per_eh_day: 44_000_000,
    fillable_ask_sat_per_eh_day: null,
    hashprice_sat_per_eh_day: null,
    max_bid_sat_per_eh_day: null,
    available_balance_sat: 500_000,
    datum_hashrate_ph: null,
    ocean_hashrate_ph: null,
    spend_sat: null,
    run_mode: 'LIVE',
    action_mode: 'NORMAL',
    ...overrides,
  };
}

describe('TickMetricsRepo.listAggregated', () => {
  let handle: DatabaseHandle;
  let repo: TickMetricsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new TickMetricsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('returns raw rows when bucketMs = 0', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.insert(sampleRow({ tick_at: i * MINUTE, delivered_ph: i }));
    }
    const out = await repo.listAggregated(0, 0);
    expect(out).toHaveLength(5);
    expect(out.map((r) => r.delivered_ph)).toEqual([0, 1, 2, 3, 4]);
  });

  it('averages numeric fields within a bucket', async () => {
    // 5 rows, 1 minute apart, all fall into the same 5-minute bucket (0..5min).
    for (let i = 0; i < 5; i++) {
      await repo.insert(
        sampleRow({
          tick_at: i * MINUTE,
          delivered_ph: i, // 0, 1, 2, 3, 4 → avg = 2.0
          our_primary_price_sat_per_eh_day: 46_000_000 + i * 1_000,
        }),
      );
    }
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(1);
    expect(out[0]!.delivered_ph).toBeCloseTo(2.0, 5);
    expect(out[0]!.our_primary_price_sat_per_eh_day).toBeCloseTo(46_002_000, 0);
    // Anchor time is MAX(tick_at) within the bucket — i.e. 4 * MINUTE.
    expect(out[0]!.tick_at).toBe(4 * MINUTE);
  });

  it('splits rows spanning multiple buckets', async () => {
    // 10 rows, 1 min apart → two 5-min buckets.
    for (let i = 0; i < 10; i++) {
      await repo.insert(sampleRow({ tick_at: i * MINUTE, delivered_ph: i }));
    }
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(2);
    // First bucket: [0..4] → avg 2; second bucket: [5..9] → avg 7.
    expect(out[0]!.delivered_ph).toBeCloseTo(2.0, 5);
    expect(out[1]!.delivered_ph).toBeCloseTo(7.0, 5);
    expect(out[0]!.tick_at).toBe(4 * MINUTE);
    expect(out[1]!.tick_at).toBe(9 * MINUTE);
  });

  it('handles a partial last bucket (fewer than bucket-size rows at the end)', async () => {
    // 7 rows across two 5-min buckets: first bucket full (5 rows),
    // second bucket has just 2 rows.
    for (let i = 0; i < 7; i++) {
      await repo.insert(sampleRow({ tick_at: i * MINUTE, delivered_ph: i }));
    }
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(2);
    expect(out[0]!.delivered_ph).toBeCloseTo(2.0, 5); // avg(0,1,2,3,4)
    expect(out[1]!.delivered_ph).toBeCloseTo(5.5, 5); // avg(5,6)
  });

  it('returns an empty list when the window has no data', async () => {
    await repo.insert(sampleRow({ tick_at: 10 * MINUTE }));
    const out = await repo.listAggregated(20 * MINUTE, 5 * MINUTE);
    expect(out).toEqual([]);
  });

  it('single-row bucket averages that single value (no NaN)', async () => {
    await repo.insert(
      sampleRow({
        tick_at: 0,
        delivered_ph: 3,
        our_primary_price_sat_per_eh_day: 46_123_000,
      }),
    );
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(1);
    expect(out[0]!.delivered_ph).toBeCloseTo(3, 5);
    expect(out[0]!.our_primary_price_sat_per_eh_day).toBeCloseTo(46_123_000, 0);
  });

  it('filters by sinceMs so earlier rows do not contribute to the first bucket', async () => {
    // 5 rows before the window, 3 inside. Only the 3 inside should count.
    for (let i = 0; i < 5; i++) {
      await repo.insert(sampleRow({ tick_at: i * MINUTE, delivered_ph: 100 }));
    }
    for (let i = 0; i < 3; i++) {
      await repo.insert(sampleRow({ tick_at: (10 + i) * MINUTE, delivered_ph: i }));
    }
    const out = await repo.listAggregated(10 * MINUTE, 5 * MINUTE);
    // Only the three in-window rows contribute — one bucket, avg(0,1,2)=1.
    expect(out).toHaveLength(1);
    expect(out[0]!.delivered_ph).toBeCloseTo(1, 5);
  });

  it('uses 1 h buckets with realistic spacing', async () => {
    // Three ticks per hour for 2 hours → expect 2 buckets.
    for (let hour = 0; hour < 2; hour++) {
      for (let tickInHour = 0; tickInHour < 3; tickInHour++) {
        await repo.insert(
          sampleRow({
            tick_at: hour * HOUR + tickInHour * 20 * MINUTE,
            delivered_ph: hour + tickInHour * 0.1,
          }),
        );
      }
    }
    const out = await repo.listAggregated(0, HOUR);
    expect(out).toHaveLength(2);
    expect(out[0]!.delivered_ph).toBeCloseTo(0.1, 5); // avg(0, 0.1, 0.2)
    expect(out[1]!.delivered_ph).toBeCloseTo(1.1, 5); // avg(1, 1.1, 1.2)
  });

  it('preserves nulls: if every row in a bucket has null price, the avg is null', async () => {
    for (let i = 0; i < 3; i++) {
      await repo.insert(
        sampleRow({
          tick_at: i * MINUTE,
          our_primary_price_sat_per_eh_day: null,
        }),
      );
    }
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(1);
    expect(out[0]!.our_primary_price_sat_per_eh_day).toBeNull();
  });

  it('mixed-nulls: AVG ignores nulls (SQL behaviour)', async () => {
    await repo.insert(
      sampleRow({ tick_at: 0, our_primary_price_sat_per_eh_day: 40_000_000 }),
    );
    await repo.insert(
      sampleRow({ tick_at: 1 * MINUTE, our_primary_price_sat_per_eh_day: null }),
    );
    await repo.insert(
      sampleRow({ tick_at: 2 * MINUTE, our_primary_price_sat_per_eh_day: 50_000_000 }),
    );
    const out = await repo.listAggregated(0, 5 * MINUTE);
    expect(out).toHaveLength(1);
    // AVG of [40M, 50M] (null ignored) = 45M.
    expect(out[0]!.our_primary_price_sat_per_eh_day).toBeCloseTo(45_000_000, 0);
  });
});
