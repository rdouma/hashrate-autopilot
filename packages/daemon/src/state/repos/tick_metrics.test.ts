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

describe('TickMetricsRepo.effectiveSatPerEhDayWindow', () => {
  let handle: DatabaseHandle;
  let repo: TickMetricsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new TickMetricsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  // The window is anchored to Date.now(), so all helper rows below
  // backdate from `now` to land inside the requested window.
  const now = () => Date.now();

  it('returns null on an empty window', async () => {
    const r = await repo.effectiveSatPerEhDayWindow(10 * MINUTE);
    expect(r).toBeNull();
  });

  it('returns null with only a single tick (no inter-tick delta available)', async () => {
    await repo.insert(
      sampleRow({ tick_at: now() - 30_000, primary_bid_consumed_sat: 100 }),
    );
    const r = await repo.effectiveSatPerEhDayWindow(10 * MINUTE);
    expect(r).toBeNull();
  });

  it('computes the duration-weighted rate across multiple ticks (well below bid)', async () => {
    // 10 evenly-spaced ticks, 60 s apart, each adding 100 sat at
    // delivered_ph = 4 PH. Σ delta = 9 × 100 = 900 sat,
    // Σ phms = 9 × 4 × 60_000 = 2_160_000.
    //   900 × 86.4e9 / 2_160_000 = 36_000_000 sat/EH/day.
    // Bid (46M) is well above the realised rate, so the cap is inert.
    const base = now() - 10 * MINUTE;
    for (let i = 0; i < 10; i++) {
      await repo.insert(
        sampleRow({
          tick_at: base + i * MINUTE,
          delivered_ph: 4,
          primary_bid_consumed_sat: 1000 + i * 100,
        }),
      );
    }
    const r = await repo.effectiveSatPerEhDayWindow(11 * MINUTE);
    expect(r).toBeCloseTo(36_000_000, -3);
  });

  it('caps at the weighted-average bid when delivered_ph lag inflates the raw ratio', async () => {
    // Reproduces the live failure mode: under pay-your-bid the bid is
    // a hard ceiling, but `delivered_ph` (a trailing avg_speed_ph)
    // lags real-time delivery. When Braiins meters faster than
    // avg_speed_ph reflects, Σ Δsat / Σ (delivered_ph × Δt) lands
    // above the bid — physically impossible. Cap must kick in.
    //
    // Construct: bid = 47_000_000, but charge 200 sat per 60 s at
    // delivered_ph = 2.93 (raw rate ~98M, way above bid). Result must
    // be the bid weighted by delivered_ph × Δt = 47_000_000 exactly.
    const base = now() - 10 * MINUTE;
    for (let i = 0; i < 10; i++) {
      await repo.insert(
        sampleRow({
          tick_at: base + i * MINUTE,
          delivered_ph: 2.93,
          our_primary_price_sat_per_eh_day: 47_000_000,
          primary_bid_consumed_sat: 1000 + i * 200,
        }),
      );
    }
    const r = await repo.effectiveSatPerEhDayWindow(11 * MINUTE);
    expect(r).toBeCloseTo(47_000_000, -3);
  });

  it('smooths through delivered_ph + spend jitter — average matches the steady-state rate', async () => {
    // Reproduces the live failure mode: alternating 2.93/3.67 PH and
    // 78–117 sat per-tick deltas, with an underlying steady-state rate
    // of ~40k sat/PH/day = 40e6 sat/EH/day.
    //
    // Construction: pair (low PH, low Δ) with (high PH, high Δ) so the
    // duration-weighted average lands on the steady rate even though
    // single-tick reads vary 2x.
    const base = now() - 10 * MINUTE;
    const samples = [
      { dph: 2.93, dsat: 81 },
      { dph: 3.67, dsat: 102 },
      { dph: 2.93, dsat: 81 },
      { dph: 3.67, dsat: 102 },
      { dph: 2.93, dsat: 81 },
      { dph: 3.67, dsat: 102 },
      { dph: 2.93, dsat: 81 },
      { dph: 3.67, dsat: 102 },
      { dph: 2.93, dsat: 81 },
      { dph: 3.67, dsat: 102 },
    ];
    let cum = 1000;
    for (let i = 0; i < samples.length; i++) {
      cum += samples[i]!.dsat;
      await repo.insert(
        sampleRow({
          tick_at: base + i * MINUTE,
          delivered_ph: samples[i]!.dph,
          primary_bid_consumed_sat: cum,
        }),
      );
    }
    const r = await repo.effectiveSatPerEhDayWindow(11 * MINUTE);
    expect(r).not.toBeNull();
    // 40e6 ± 5% — well inside the noise band a per-tick read would have.
    expect(r!).toBeGreaterThan(38_000_000);
    expect(r!).toBeLessThan(42_000_000);
  });

  it('skips zero-dip mid-sequence (counter resets to 0 then recovers)', async () => {
    // The "April 23 incident" pattern guarded against in
    // actualSpendSatSince: a zero in the middle of the counter trail
    // would otherwise make LAG report the recovery counter as fresh
    // spend, inflating the rate by orders of magnitude.
    const base = now() - 5 * MINUTE;
    await repo.insert(
      sampleRow({
        tick_at: base,
        delivered_ph: 4,
        primary_bid_consumed_sat: 1000,
      }),
    );
    await repo.insert(
      sampleRow({
        tick_at: base + MINUTE,
        delivered_ph: 4,
        primary_bid_consumed_sat: 0,
      }),
    );
    await repo.insert(
      sampleRow({
        tick_at: base + 2 * MINUTE,
        delivered_ph: 4,
        primary_bid_consumed_sat: 1100,
      }),
    );
    await repo.insert(
      sampleRow({
        tick_at: base + 3 * MINUTE,
        delivered_ph: 4,
        primary_bid_consumed_sat: 1200,
      }),
    );
    // Only the 1100 → 1200 step is a valid sample (delta = 100).
    // Σ phms = 4 × 60_000. Rate = 100 × 86.4e9 / 240_000 = 36e6.
    const r = await repo.effectiveSatPerEhDayWindow(10 * MINUTE);
    expect(r).toBeCloseTo(36_000_000, -3);
  });

  it('excludes ticks outside the window', async () => {
    // Two old ticks in a far-stale window encode a huge per-tick
    // delta (5000 sat) that would dominate the answer if leaked in.
    // Both must be excluded by the WHERE tick_at >= sinceMs guard.
    await repo.insert(
      sampleRow({
        tick_at: now() - 60 * MINUTE,
        delivered_ph: 4,
        primary_bid_consumed_sat: 1000,
      }),
    );
    await repo.insert(
      sampleRow({
        tick_at: now() - 59 * MINUTE,
        delivered_ph: 4,
        primary_bid_consumed_sat: 6000, // 5000-sat spike, but stale
      }),
    );
    const recentBase = now() - 5 * MINUTE;
    for (let i = 0; i < 5; i++) {
      await repo.insert(
        sampleRow({
          tick_at: recentBase + i * MINUTE,
          delivered_ph: 4,
          primary_bid_consumed_sat: 6000 + i * 100,
        }),
      );
    }
    const r = await repo.effectiveSatPerEhDayWindow(10 * MINUTE);
    // Only the 4 valid recent deltas (each 100 sat over 4 PH × 60 s)
    // should contribute. Σ delta = 400, Σ phms = 4 × 4 × 60_000 = 960_000.
    // Rate = 400 × 86.4e9 / 960_000 = 36e6.
    expect(r).toBeCloseTo(36_000_000, -3);
  });
});
