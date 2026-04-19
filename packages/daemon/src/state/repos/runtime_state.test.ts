import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { RuntimeStateRepo } from './runtime_state.js';

describe('RuntimeStateRepo — floor-state persistence (#11)', () => {
  let handle: DatabaseHandle;
  let repo: RuntimeStateRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new RuntimeStateRepo(handle.db);
    await repo.initializeIfMissing();
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('starts with null below_floor_since_ms and 0 above_floor_ticks', async () => {
    const row = await repo.get();
    expect(row?.below_floor_since_ms).toBeNull();
    expect(row?.lower_ready_since_ms).toBeNull();
    expect(row?.above_floor_ticks).toBe(0);
  });

  it('round-trips lower_ready_since_ms (issue: patience window survives restart)', async () => {
    const sinceMs = 1_700_000_000_000;
    await repo.patch({ lower_ready_since_ms: sinceMs });
    const row = await repo.get();
    expect(row?.lower_ready_since_ms).toBe(sinceMs);

    // And a fresh repo against the same db reads it back — the
    // single-process approximation of a daemon restart.
    const reborn = new RuntimeStateRepo(handle.db);
    const rebornRow = await reborn.get();
    expect(rebornRow?.lower_ready_since_ms).toBe(sinceMs);
  });

  it('round-trips both fields via patch + get', async () => {
    const droughtStart = 1_700_000_000_000;
    await repo.patch({ below_floor_since_ms: droughtStart, above_floor_ticks: 3 });
    const row = await repo.get();
    expect(row?.below_floor_since_ms).toBe(droughtStart);
    expect(row?.above_floor_ticks).toBe(3);
  });

  it('survives a "restart" — second repo instance against the same db reads the persisted state', async () => {
    const droughtStart = 1_700_000_000_000;
    await repo.patch({ below_floor_since_ms: droughtStart, above_floor_ticks: 5 });

    // Same db handle, fresh repo instance — the closest single-test
    // approximation of a daemon restart against the same state.db.
    const reborn = new RuntimeStateRepo(handle.db);
    const row = await reborn.get();
    expect(row?.below_floor_since_ms).toBe(droughtStart);
    expect(row?.above_floor_ticks).toBe(5);
  });

  it('clears below_floor_since_ms when patched to null (recovery above floor)', async () => {
    await repo.patch({ below_floor_since_ms: 1_700_000_000_000, above_floor_ticks: 7 });
    await repo.patch({ below_floor_since_ms: null, above_floor_ticks: 0 });
    const row = await repo.get();
    expect(row?.below_floor_since_ms).toBeNull();
    expect(row?.above_floor_ticks).toBe(0);
  });
});
