/**
 * Repository for the single-row `runtime_state` table.
 *
 * `run_mode` is set on each boot from `config.boot_mode` (daemon main).
 * The `last_*_ok_at` fields persist across restarts.
 */

import type { Kysely } from 'kysely';

import type { ActionMode, RunMode } from '@hashrate-autopilot/shared';

import type { Database, RuntimeStateTable } from '../types.js';

export interface RuntimeStateRow {
  run_mode: RunMode;
  action_mode: ActionMode;
  last_tick_at: number | null;
  last_api_ok_at: number | null;
  last_rpc_ok_at: number | null;
  last_pool_ok_at: number | null;
  below_floor_since_ms: number | null;
  lower_ready_since_ms: number | null;
  below_target_since_ms: number | null;
  above_floor_ticks: number;
  solo_best_difficulty_all_time: number | null;
  last_backfilled_payout_address: string | null;
  /** #373: persisted CREATE hold (churn breaker / blacklist), null when none. */
  create_hold_kind: string | null;
  create_hold_until_ms: number | null;
  create_hold_detail: string | null;
  create_hold_since_ms: number | null;
}

export class RuntimeStateRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async get(): Promise<RuntimeStateRow | null> {
    const row = await this.db
      .selectFrom('runtime_state')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirst();
    return row ? toDomain(row) : null;
  }

  /**
   * Initialize the row with safe defaults: DRY_RUN, NORMAL.
   * Idempotent - existing rows are left untouched. Used on first boot.
   */
  async initializeIfMissing(): Promise<void> {
    await this.db
      .insertInto('runtime_state')
      .values({
        id: 1,
        run_mode: 'DRY_RUN',
        action_mode: 'NORMAL',
        last_tick_at: null,
        last_api_ok_at: null,
        last_rpc_ok_at: null,
        last_pool_ok_at: null,
        below_floor_since_ms: null,
        lower_ready_since_ms: null,
        below_target_since_ms: null,
        above_floor_ticks: 0,
        solo_best_difficulty_all_time: null,
        last_backfilled_payout_address: null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /**
   * Patch a subset of fields on the row. Useful for incremental updates
   * from the control loop (e.g. bumping `last_tick_at`).
   */
  async patch(patch: Partial<Omit<RuntimeStateTable, 'id'>>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.db.updateTable('runtime_state').set(patch).where('id', '=', 1).execute();
  }
}

function toDomain(row: RuntimeStateTable): RuntimeStateRow {
  return {
    run_mode: row.run_mode,
    action_mode: row.action_mode,
    last_tick_at: row.last_tick_at,
    last_api_ok_at: row.last_api_ok_at,
    last_rpc_ok_at: row.last_rpc_ok_at,
    last_pool_ok_at: row.last_pool_ok_at,
    below_floor_since_ms: row.below_floor_since_ms,
    lower_ready_since_ms: row.lower_ready_since_ms,
    below_target_since_ms: row.below_target_since_ms,
    above_floor_ticks: row.above_floor_ticks,
    solo_best_difficulty_all_time: row.solo_best_difficulty_all_time ?? null,
    last_backfilled_payout_address: row.last_backfilled_payout_address ?? null,
    create_hold_kind: row.create_hold_kind ?? null,
    create_hold_until_ms: row.create_hold_until_ms ?? null,
    create_hold_detail: row.create_hold_detail ?? null,
    create_hold_since_ms: row.create_hold_since_ms ?? null,
  };
}
