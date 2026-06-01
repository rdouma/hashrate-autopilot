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
      // #88: blob + mime are write-only via the dedicated multipart
      // route; the JSON config endpoint never sees them.
      block_found_sound_custom_blob: _audioBlob,
      block_found_sound_custom_mime: _audioMime,
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
      show_share_log_on_hashrate_chart:
        rest.show_share_log_on_hashrate_chart === 1,
      notifications_muted: rest.notifications_muted === 1,
      notify_on_pool_block_credit: rest.notify_on_pool_block_credit === 1,
      notify_on_braiins_deposit: rest.notify_on_braiins_deposit === 1,
      // #226: payout lifecycle Telegram alerts stored 0/1, surfaced as boolean.
      notify_on_payout_initiated: rest.notify_on_payout_initiated === 1,
      notify_on_payout_confirmed: rest.notify_on_payout_confirmed === 1,
      notification_locale: rest.notification_locale as AppConfig['notification_locale'],
      // #227 follow-up: display format preferences. The TEXT column
      // accepts whatever the dashboard puts in; Zod will validate
      // against the preset enums on the next round-trip.
      display_number_locale: rest.display_number_locale as AppConfig['display_number_locale'],
      display_date_layout: rest.display_date_layout as AppConfig['display_date_layout'],
      // #238: pass through verbatim; the dashboard parses JSON and
      // drops malformed entries at render time.
      chart_color_overrides: rest.chart_color_overrides ?? '{}',
      // #106: stored as comma-separated TEXT; surface as string[].
      // Empty string -> empty array (no opt-outs).
      notification_disabled_event_classes: rest.notification_disabled_event_classes
        ? rest.notification_disabled_event_classes.split(',').filter(Boolean)
        : [],
      // Schema column is `TEXT NOT NULL DEFAULT 'off'`; the Zod enum
      // narrows valid values, but the row type is the broad SQL string.
      block_found_sound: rest.block_found_sound as AppConfig['block_found_sound'],
      // #111: SQL column is broad TEXT; Zod narrows to '' | 'noip'.
      ddns_provider: rest.ddns_provider as AppConfig['ddns_provider'],
      // #149: master toggle stored as 0/1, surfaced as boolean.
      solo_mining_enabled: rest.solo_mining_enabled === 1,
      // #170: backfill toggle stored as 0/1, surfaced as boolean.
      include_historical_payouts: rest.include_historical_payouts === 1,
      // #179: debug API toggle stored as 0/1, surfaced as boolean.
      debug_api_enabled: rest.debug_api_enabled === 1,
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
      show_share_log_on_hashrate_chart: (validated.show_share_log_on_hashrate_chart
        ? 1
        : 0) as 0 | 1,
      notifications_muted: (validated.notifications_muted ? 1 : 0) as 0 | 1,
      notify_on_pool_block_credit: (validated.notify_on_pool_block_credit ? 1 : 0) as 0 | 1,
      notify_on_braiins_deposit: (validated.notify_on_braiins_deposit ? 1 : 0) as 0 | 1,
      // #226: payout lifecycle Telegram alerts.
      notify_on_payout_initiated: (validated.notify_on_payout_initiated ? 1 : 0) as 0 | 1,
      notify_on_payout_confirmed: (validated.notify_on_payout_confirmed ? 1 : 0) as 0 | 1,
      notification_locale: validated.notification_locale,
      // #227 follow-up: write-through for display format preferences.
      display_number_locale: validated.display_number_locale,
      display_date_layout: validated.display_date_layout,
      // #238: chart color overrides written through as-is.
      chart_color_overrides: validated.chart_color_overrides,
      // #106: comma-join the opt-out list back to TEXT.
      notification_disabled_event_classes:
        validated.notification_disabled_event_classes.join(','),
      // #149: master toggle stored as 0/1.
      solo_mining_enabled: (validated.solo_mining_enabled ? 1 : 0) as 0 | 1,
      // #170: backfill toggle stored as 0/1.
      include_historical_payouts: (validated.include_historical_payouts ? 1 : 0) as 0 | 1,
      // #179: debug API toggle stored as 0/1.
      debug_api_enabled: (validated.debug_api_enabled ? 1 : 0) as 0 | 1,
      // Legacy NOT NULL columns still in the DB - provide harmless defaults
      // so INSERT succeeds.
      emergency_max_bid_sat_per_eh_day: validated.max_bid_sat_per_eh_day,
      below_floor_emergency_cap_after_minutes: 9999,
      hibernate_on_expensive_market: 0 as 0 | 1,
    };
    await this.db
      .insertInto('config')
      .values({ id: 1, ...row, updated_at: now })
      .onConflict((oc) => oc.column('id').doUpdateSet({ ...row, updated_at: now }))
      .execute();
  }
}
