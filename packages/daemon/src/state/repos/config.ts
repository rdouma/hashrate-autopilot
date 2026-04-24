/**
 * Repository for the single-row `config` table.
 *
 * SPEC §8 specifies these values are live-editable from the dashboard. Every
 * write is validated by the Zod invariants schema before it hits SQLite.
 */

import type { Kysely } from 'kysely';

import { AppConfigInvariantsSchema, type AppConfig } from '../../config/schema.js';
import type { Database } from '../types.js';

export class ConfigRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Return the single config row, or null if it hasn't been seeded yet.
   * Callers should treat `null` as "first-run setup not completed".
   */
  async get(): Promise<AppConfig | null> {
    const row = await this.db.selectFrom('config').selectAll().where('id', '=', 1).executeTakeFirst();
    if (!row) return null;
    const {
      id: _id,
      updated_at: _ua,
      // Legacy columns still in DB but no longer part of AppConfig.
      emergency_max_bid_sat_per_eh_day: _legacy1,
      below_floor_emergency_cap_after_minutes: _legacy2,
      hibernate_on_expensive_market: _legacy3,
      quiet_hours_start: _legacy4,
      quiet_hours_end: _legacy5,
      quiet_hours_timezone: _legacy6,
      confirmation_timeout_minutes: _legacy7,
      telegram_chat_id: _legacy8,
      ...rest
    } = row;
    return {
      ...rest,
      electrs_host: rest.electrs_host ?? null,
      electrs_port: rest.electrs_port ?? null,
      // SQLite stores booleans as 0/1; surface them as proper booleans
      // to the rest of the app.
      show_effective_rate_on_price_chart:
        rest.show_effective_rate_on_price_chart === 1,
    };
  }

  /**
   * Insert or replace the config row. Validates invariants before writing.
   */
  async upsert(cfg: AppConfig, now: number = Date.now()): Promise<void> {
    const validated = AppConfigInvariantsSchema.parse(cfg);
    const row = {
      ...validated,
      // SQLite boolean columns hold 0 / 1.
      show_effective_rate_on_price_chart: (validated.show_effective_rate_on_price_chart
        ? 1
        : 0) as 0 | 1,
      // Legacy NOT NULL columns still in the DB — provide harmless defaults
      // so INSERT succeeds.
      emergency_max_bid_sat_per_eh_day: validated.max_bid_sat_per_eh_day,
      below_floor_emergency_cap_after_minutes: 9999,
      hibernate_on_expensive_market: 0 as 0 | 1,
      quiet_hours_start: '00:00',
      quiet_hours_end: '00:00',
      quiet_hours_timezone: 'UTC',
      confirmation_timeout_minutes: 15,
      telegram_chat_id: '',
    };
    await this.db
      .insertInto('config')
      .values({ id: 1, ...row, updated_at: now })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...row, updated_at: now }))
      .execute();
  }
}
