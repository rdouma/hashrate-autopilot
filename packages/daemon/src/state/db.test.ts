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
};

describe('openDatabase - migrations', () => {
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
      '0020_cheap_hashrate.sql',
      '0021_bitcoind_config.sql',
      '0022_payout_source.sql',
      '0023_tick_metrics_hashprice.sql',
      '0024_tick_metrics_max_bid.sql',
      '0025_lower_patience.sql',
      '0026_closed_bids_cache.sql',
      '0027_retention_config.sql',
      '0028_datum_api_url.sql',
      '0029_tick_metrics_datum_hashrate.sql',
      '0030_max_overpay_vs_hashprice.sql',
      '0031_persist_above_floor_since.sql',
      '0032_rename_above_floor_since_to_lower_ready_since.sql',
      '0033_block_explorer_url_template.sql',
      '0034_block_metadata.sql',
      '0035_tick_metrics_ocean_hashrate.sql',
      '0036_drop_block_metadata.sql',
      '0037_drop_monthly_budget_ceiling.sql',
      '0038_persist_below_target_since.sql',
      '0039_hashrate_smoothing.sql',
      '0040_tick_metrics_spend_sat.sql',
      '0041_tick_metrics_primary_bid_consumed.sql',
      '0042_price_smoothing.sql',
      '0043_drop_fill_strategy_knobs.sql',
      '0044_cheap_sustained_window.sql',
      '0045_add_overpay_sat_per_eh_day.sql',
      '0046_show_effective_rate_on_price_chart.sql',
      '0047_secrets_table.sql',
      '0048_tick_metrics_share_log_pct.sql',
      '0049_show_share_log_on_hashrate_chart.sql',
      '0050_btc_price_default_coingecko.sql',
      '0051_bump_retention_defaults.sql',
      '0052_block_found_sound.sql',
      '0053_tick_metrics_extended_capture.sql',
      '0054_btc_price_source_per_tick.sql',
      '0055_tick_metrics_pool_blocks.sql',
      '0056_tick_metrics_pool_hashrate_avg.sql',
      '0057_tick_metrics_pool_luck.sql',
      '0058_block_version_cache.sql',
      '0061_block_found_sound_filename.sql',
      '0062_telegram_notifications.sql',
      '0063_telegram_bot_token_on_config.sql',
      '0064_notification_disabled_event_classes.sql',
      '0065_pool_blocks.sql',
      '0066_paid_total_sat.sql',
      '0067_ddns.sql',
      '0068_ddns_update_url.sql',
      '0069_owned_bids_dest_url.sql',
      '0070_telegram_instance_label.sql',
      '0071_block_explorer_tx_url_template.sql',
      '0072_reward_events_txid_vout_unique.sql',
      '0073_notify_on_pool_block_credit.sql',
      '0074_reset_default_wallet_runway_alert_days.sql',
      '0075_rename_alert_severities.sql',
      '0076_alerts_retention.sql',
      '0077_bid_events_overpay_snapshot.sql',
      '0078_chart_max_markers.sql',
      '0079_rename_error_severity_to_important.sql',
      '0080_braiins_deposits.sql',
      '0081_notification_locale.sql',
      '0082_split_outage_thresholds.sql',
      '0083_drop_operator_available.sql',
      '0084_drop_snooze.sql',
      '0085_solo_miners.sql',
      '0086_solo_miner_best_diff.sql',
      '0087_solo_miner_hashrate_instant.sql',
      '0088_marketplace_empty_alert.sql',
      '0089_include_historical_payouts.sql',
      '0090_historical_payouts_offset.sql',
      '0091_tick_metrics_braiins_reachable.sql',
      '0092_debug_api_enabled.sql',
      '0093_tick_metrics_pool_luck_30d.sql',
      '0094_solo_best_difficulty.sql',
      '0095_tick_metrics_total_balance.sql',
      '0096_deposits_tx_timestamp.sql',
      '0097_deposits_credited_at.sql',
      '0098_fix_credited_at_backfill.sql',
      '0099_fee_halt_and_deadband.sql',
      '0100_tick_metrics_deadband_pct.sql',
      '0101_payout_notifications.sql',
      '0102_display_format_settings.sql',
      '0103_chart_color_overrides.sql',
      '0104_tick_metrics_synthetic.sql',
      '0105_runtime_state_last_backfilled_payout_address.sql',
      '0106_tick_metrics_braiins_shares.sql',
      '0107_scrub_orphan_acceptance_data.sql',
      '0108_dashboard_card_order.sql',
      '0109_ip_change_events.sql',
      '0110_dashboard_tiles.sql',
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
        'secrets',
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

describe('openDatabase - idempotency', () => {
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
    await repo.patch({ last_tick_at: 42, last_api_ok_at: 7 });
    const row = await repo.get();
    expect(row?.last_tick_at).toBe(42);
    expect(row?.last_api_ok_at).toBe(7);
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
