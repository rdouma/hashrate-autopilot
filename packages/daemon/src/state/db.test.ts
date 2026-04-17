import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS, type AppConfig } from '../config/schema.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from './db.js';
import { ConfigRepo } from './repos/config.js';
import { RuntimeStateRepo } from './repos/runtime_state.js';

const SAMPLE_CONFIG: AppConfig = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://datum.local:23334',
  destination_pool_worker_name: 'remco.rig1',
  btc_payout_address: 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxxxxxx',
  telegram_chat_id: '123456789',
};

describe('openDatabase — migrations', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('applies every bundled migration on a fresh DB', () => {
    expect(handle.migrations.applied).toEqual([
      '0001_initial.sql',
      '0002_strategy_knobs.sql',
      '0003_null_empty_cl_order_id.sql',
      '0004_tick_metrics.sql',
      '0005_electrs_config.sql',
      '0006_decisions_run_mode_index.sql',
      '0007_overpay_before_lowering.sql',
      '0008_boot_mode.sql',
      '0009_bid_events.sql',
      '0010_max_lowering_step.sql',
      '0011_pricing_simplification.sql',
      '0012_tick_metrics_fillable.sql',
      '0013_min_lower_delta.sql',
      '0014_persist_floor_state.sql',
      '0015_rename_max_overpay.sql',
      '0016_bid_events_allow_edit_speed.sql',
      '0017_owned_bids_consumed.sql',
      '0018_spent_scope.sql',
      '0019_btc_price_source.sql',
    ]);
    expect(handle.migrations.skipped).toEqual([]);
  });

  it('creates every table from architecture §5', () => {
    const tables = handle.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '_migrations',
        'alerts',
        'config',
        'decisions',
        'deferred_actions',
        'fee_schedule_cache',
        'market_settings_cache',
        'owned_bids',
        'reward_events',
        'runtime_state',
        'spend_events',
      ]),
    );
  });

  it('enables WAL mode', () => {
    // In-memory DBs report 'memory' journal_mode; that's expected.
    const mode = (handle.raw.pragma('journal_mode', { simple: true }) as string).toLowerCase();
    expect(['wal', 'memory']).toContain(mode);
  });
});

describe('openDatabase — idempotency', () => {
  it('skips already-applied migrations on a file-backed DB', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'braiins-db-test-'));
    const path = join(dir, 'state.db');

    const first = await openDatabase({ path });
    expect(first.migrations.applied.length).toBeGreaterThan(0);
    const appliedFirst = [...first.migrations.applied];
    await closeDatabase(first);

    const second = await openDatabase({ path });
    expect(second.migrations.applied).toEqual([]);
    expect(second.migrations.skipped).toEqual(appliedFirst);
    await closeDatabase(second);
  });
});

describe('ConfigRepo', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('returns null before the row is seeded', async () => {
    const repo = new ConfigRepo(handle.db);
    expect(await repo.get()).toBeNull();
  });

  it('upsert + get round-trips the config payload', async () => {
    const repo = new ConfigRepo(handle.db);
    await repo.upsert(SAMPLE_CONFIG, 1_700_000_000_000);
    const got = await repo.get();
    expect(got).toMatchObject(SAMPLE_CONFIG);
  });

  it('upsert replaces values on the existing row', async () => {
    const repo = new ConfigRepo(handle.db);
    await repo.upsert(SAMPLE_CONFIG);
    await repo.upsert({ ...SAMPLE_CONFIG, target_hashrate_ph: 2.5 });
    const got = await repo.get();
    expect(got?.target_hashrate_ph).toBe(2.5);
  });

  it('rejects a config that violates the invariants schema', async () => {
    const repo = new ConfigRepo(handle.db);
    await expect(
      repo.upsert({ ...SAMPLE_CONFIG, minimum_floor_hashrate_ph: 10, target_hashrate_ph: 1 }),
    ).rejects.toThrow();
  });
});

describe('RuntimeStateRepo', () => {
  let handle: DatabaseHandle;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('initializeIfMissing seeds DRY_RUN/NORMAL defaults', async () => {
    const repo = new RuntimeStateRepo(handle.db);
    await repo.initializeIfMissing();
    const row = await repo.get();
    expect(row).toMatchObject({
      run_mode: 'DRY_RUN',
      action_mode: 'NORMAL',
      operator_available: false,
    });
  });

  it('initializeIfMissing is idempotent', async () => {
    const repo = new RuntimeStateRepo(handle.db);
    await repo.initializeIfMissing();
    await repo.patch({ action_mode: 'QUIET_HOURS' });
    await repo.initializeIfMissing();
    const row = await repo.get();
    expect(row?.action_mode).toBe('QUIET_HOURS');
  });

  it('patch updates a subset of fields', async () => {
    const repo = new RuntimeStateRepo(handle.db);
    await repo.initializeIfMissing();
    await repo.patch({ last_tick_at: 42, operator_available: 1 });
    const row = await repo.get();
    expect(row?.last_tick_at).toBe(42);
    expect(row?.operator_available).toBe(true);
  });

  it('patch overrides run_mode on boot (replacing the old resetRunModeToDryRun helper)', async () => {
    // The daemon used to call a dedicated `resetRunModeToDryRun()` method on
    // every boot. With the `boot_mode` config knob that logic moved to
    // main.ts, which now uses `patch({ run_mode })` with whichever mode the
    // boot_mode config resolves to. Exercise the patch path directly.
    const repo = new RuntimeStateRepo(handle.db);
    await repo.initializeIfMissing();
    await repo.patch({ run_mode: 'LIVE' });
    await repo.patch({ run_mode: 'DRY_RUN' });
    const row = await repo.get();
    expect(row?.run_mode).toBe('DRY_RUN');
  });
});
