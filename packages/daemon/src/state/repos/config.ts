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
    const { id: _id, updated_at: _ua, hibernate_on_expensive_market, ...rest } = row;
    return {
      ...rest,
      hibernate_on_expensive_market: hibernate_on_expensive_market === 1,
      electrs_host: rest.electrs_host ?? null,
      electrs_port: rest.electrs_port ?? null,
    };
  }

  /**
   * Insert or replace the config row. Validates invariants before writing.
   */
  async upsert(cfg: AppConfig, now: number = Date.now()): Promise<void> {
    const validated = AppConfigInvariantsSchema.parse(cfg);
    const row = {
      ...validated,
      hibernate_on_expensive_market: (validated.hibernate_on_expensive_market ? 1 : 0) as 0 | 1,
    };
    await this.db
      .insertInto('config')
      .values({ id: 1, ...row, updated_at: now })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...row, updated_at: now }))
      .execute();
  }
}
