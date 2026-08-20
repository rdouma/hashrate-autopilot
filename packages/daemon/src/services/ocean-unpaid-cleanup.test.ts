/**
 * #369: the boot-time unpaid-sat cleanup wiped an operator's entire
 * real unpaid history when the balance legitimately crossed the 1.5M
 * "bogus reconstruction" threshold (bigger target than the 1 PH/s the
 * threshold was sized for + a late Ocean payout batch). These tests
 * pin the fix: the heuristic only ever looks inside the 2026 spring
 * contamination era, and the restore pass heals wrongly-nulled rows
 * from the per-tick observed state kept in decisions.observed_json.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../state/db.js';
import { runOceanUnpaidCleanup, runOceanUnpaidRestore } from './ocean-unpaid-cleanup.js';

// Inside the contamination era (before 2026-05-09).
const ERA_MS = Date.UTC(2026, 3, 15); // 2026-04-15
// Well after the era - the incident regime.
const MODERN_MS = Date.UTC(2026, 7, 18); // 2026-08-18

let handle: DatabaseHandle;

beforeEach(async () => {
  handle = await openDatabase({ path: ':memory:' });
});

afterEach(async () => {
  await closeDatabase(handle);
});

async function insertTick(tickAt: number, unpaid: number | null): Promise<void> {
  await handle.db
    .insertInto('tick_metrics')
    .values({
      tick_at: tickAt,
      delivered_ph: 3,
      target_ph: 3,
      floor_ph: 1,
      owned_bid_count: 1,
      unknown_bid_count: 0,
      run_mode: 'LIVE',
      action_mode: 'NORMAL',
      ocean_unpaid_sat: unpaid,
    } as never)
    .execute();
}

async function insertDecision(tickAt: number, unpaid: number | null): Promise<void> {
  await handle.db
    .insertInto('decisions')
    .values({
      tick_at: tickAt,
      observed_json: JSON.stringify({ ocean_unpaid_sat: unpaid }),
      proposed_json: '[]',
      gated_json: '[]',
      executed_json: '[]',
      run_mode: 'LIVE',
      action_mode: 'NORMAL',
    } as never)
    .execute();
}

async function unpaidByTick(): Promise<Map<number, number | null>> {
  const rows = await handle.db
    .selectFrom('tick_metrics')
    .select(['tick_at', 'ocean_unpaid_sat'])
    .execute();
  return new Map(rows.map((r) => [r.tick_at, r.ocean_unpaid_sat]));
}

describe('runOceanUnpaidCleanup (#369 era bound)', () => {
  it('never treats a modern legitimately-high balance as contamination', async () => {
    // The incident shape: real balance climbs past 1.5M before a late
    // payout, plus older real history behind it.
    await insertTick(MODERN_MS - 60_000, 1_400_000);
    await insertTick(MODERN_MS, 1_700_000);
    await insertTick(MODERN_MS + 60_000, 100_000);

    await runOceanUnpaidCleanup({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(MODERN_MS - 60_000)).toBe(1_400_000);
    expect(m.get(MODERN_MS)).toBe(1_700_000);
    expect(m.get(MODERN_MS + 60_000)).toBe(100_000);
  });

  it('still nulls reconstructed garbage inside the contamination era', async () => {
    await insertTick(ERA_MS - 60_000, 9_000_000); // reconstructed garbage
    await insertTick(ERA_MS, 8_000_000); // reconstructed garbage (cutoff)
    await insertTick(ERA_MS + 60_000, 400_000); // post-cutoff, kept

    await runOceanUnpaidCleanup({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(ERA_MS - 60_000)).toBeNull();
    expect(m.get(ERA_MS)).toBeNull();
    expect(m.get(ERA_MS + 60_000)).toBe(400_000);
  });

  it('an era cutoff does not reach forward into modern rows', async () => {
    await insertTick(ERA_MS, 8_000_000); // era garbage -> cutoff at ERA_MS
    await insertTick(MODERN_MS, 250_000); // modern real value, after cutoff

    await runOceanUnpaidCleanup({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(ERA_MS)).toBeNull();
    expect(m.get(MODERN_MS)).toBe(250_000);
  });
});

describe('runOceanUnpaidRestore (#369 self-heal)', () => {
  it('restores wrongly-nulled rows from decisions.observed_json', async () => {
    await insertTick(MODERN_MS, null); // wiped by the pre-fix cleanup
    await insertDecision(MODERN_MS, 1_700_000);

    await runOceanUnpaidRestore({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(MODERN_MS)).toBe(1_700_000);
  });

  it('leaves legitimately-null rows alone (no decisions value)', async () => {
    // Ocean-unreachable tick: decisions row exists but carries null.
    await insertTick(MODERN_MS, null);
    await insertDecision(MODERN_MS, null);
    // Synthetic/gap tick: no decisions row at all.
    await insertTick(MODERN_MS + 60_000, null);

    await runOceanUnpaidRestore({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(MODERN_MS)).toBeNull();
    expect(m.get(MODERN_MS + 60_000)).toBeNull();
  });

  it('does not overwrite rows that already have a value', async () => {
    await insertTick(MODERN_MS, 123_456);
    await insertDecision(MODERN_MS, 999_999);

    await runOceanUnpaidRestore({ db: handle.db });

    const m = await unpaidByTick();
    expect(m.get(MODERN_MS)).toBe(123_456);
  });

  it('cleanup followed by restore round-trips the incident', async () => {
    // Pre-fix behavior had already nulled history; simulate by
    // inserting nulled ticks with intact decisions, then run both
    // passes as a boot would.
    for (let i = 0; i < 5; i++) {
      const t = MODERN_MS - i * 60_000;
      await insertTick(t, null);
      await insertDecision(t, 1_000_000 + i);
    }
    await runOceanUnpaidCleanup({ db: handle.db });
    await runOceanUnpaidRestore({ db: handle.db });

    const m = await unpaidByTick();
    for (let i = 0; i < 5; i++) {
      expect(m.get(MODERN_MS - i * 60_000)).toBe(1_000_000 + i);
    }
  });
});
