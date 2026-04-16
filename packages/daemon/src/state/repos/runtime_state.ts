/**
 * Repository for the single-row `runtime_state` table.
 *
 * `run_mode` is set on each boot from `config.boot_mode` (daemon main). Other
 * fields (`operator_available`, `last_*_ok_at`) persist across restarts.
 */

import type { Kysely } from 'kysely';

import type { ActionMode, RunMode } from '@braiins-hashrate/shared';

import type { Database, RuntimeStateTable } from '../types.js';

export interface RuntimeStateRow {
  run_mode: RunMode;
  action_mode: ActionMode;
  operator_available: boolean;
  last_tick_at: number | null;
  last_api_ok_at: number | null;
  last_rpc_ok_at: number | null;
  last_pool_ok_at: number | null;
  below_floor_since_ms: number | null;
  above_floor_ticks: number;
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
   * Initialize the row with safe defaults: DRY_RUN, NORMAL, not available.
   * Idempotent — existing rows are left untouched. Used on first boot.
   */
  async initializeIfMissing(): Promise<void> {
    await this.db
      .insertInto('runtime_state')
      .values({
        id: 1,
        run_mode: 'DRY_RUN',
        action_mode: 'NORMAL',
        operator_available: 0,
        last_tick_at: null,
        last_api_ok_at: null,
        last_rpc_ok_at: null,
        last_pool_ok_at: null,
        below_floor_since_ms: null,
        above_floor_ticks: 0,
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
    operator_available: row.operator_available === 1,
    last_tick_at: row.last_tick_at,
    last_api_ok_at: row.last_api_ok_at,
    last_rpc_ok_at: row.last_rpc_ok_at,
    last_pool_ok_at: row.last_pool_ok_at,
    below_floor_since_ms: row.below_floor_since_ms,
    above_floor_ticks: row.above_floor_ticks,
  };
}
