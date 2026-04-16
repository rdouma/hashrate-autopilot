/**
 * Zod schemas for the two tiers of configuration:
 *
 * - {@link SecretsSchema} — values held in the sops-encrypted file on disk.
 *   Decrypted at startup, kept in memory, never re-written plain.
 *
 * - {@link AppConfigSchema} — live-editable tunables stored in the SQLite
 *   `config` table. Validated on every write (architecture §7) and on read
 *   via repository layer. Shape mirrors SPEC §8 and architecture §5.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Secrets (encrypted at rest)
// ---------------------------------------------------------------------------

// Braiins API tokens are opaque bearer strings; we require at minimum that
// they are non-empty. Read-only is optional — a user may only have one token.
const nonEmptyString = z.string().min(1, 'must be non-empty');

export const SecretsSchema = z.object({
  braiins_owner_token: nonEmptyString,
  braiins_read_only_token: nonEmptyString.optional(),

  telegram_bot_token: nonEmptyString,
  // Generated fresh during setup; used to verify inbound webhook calls.
  telegram_webhook_secret: nonEmptyString,

  bitcoind_rpc_url: z.string().url('must be a valid URL (http(s)://host:port)'),
  bitcoind_rpc_user: nonEmptyString,
  bitcoind_rpc_password: nonEmptyString,

  // Shared password for the dashboard (second-gate; Tailscale is the real
  // perimeter per architecture §12 risk register).
  dashboard_password: nonEmptyString,
});

export type Secrets = z.infer<typeof SecretsSchema>;

// ---------------------------------------------------------------------------
// App config (live-editable, stored in SQLite)
// ---------------------------------------------------------------------------

const positiveNumber = z.number().positive();
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

// ISO "HH:MM" 24-hour. Regex is cheap and clear; full ISO time would be overkill.
const hhmmString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24-hour)');

// IANA timezone string. We don't validate against a registry here — the DateTime
// library (Intl.DateTimeFormat) surfaces an error at runtime if invalid.
const timezoneString = nonEmptyString;

export const AppConfigSchema = z.object({
  // Hashrate targets (SPEC §8)
  target_hashrate_ph: positiveNumber,
  minimum_floor_hashrate_ph: positiveNumber,

  // Destination pool (SPEC §8 — Datum-connected Ocean)
  destination_pool_url: z.string().url(),
  destination_pool_worker_name: nonEmptyString,

  // Pricing ceilings (sat per EH per day)
  max_bid_sat_per_eh_day: positiveInt,
  emergency_max_bid_sat_per_eh_day: positiveInt,

  // Budgeting
  monthly_budget_ceiling_sat: positiveInt,
  bid_budget_sat: positiveInt,

  // Alerting thresholds (SPEC §9)
  wallet_runway_alert_days: positiveInt,
  below_floor_alert_after_minutes: positiveInt,
  below_floor_emergency_cap_after_minutes: positiveInt,
  zero_hashrate_loud_alert_after_minutes: positiveInt,
  pool_outage_blip_tolerance_seconds: nonNegativeInt,
  api_outage_alert_after_minutes: positiveInt,

  // 2FA / operator availability (SPEC §7)
  quiet_hours_start: hhmmString,
  quiet_hours_end: hhmmString,
  quiet_hours_timezone: timezoneString,
  confirmation_timeout_minutes: positiveInt,
  handover_window_minutes: positiveInt,

  // Accounting
  btc_payout_address: nonEmptyString,

  // Telegram wiring
  telegram_chat_id: nonEmptyString,

  // Strategy knobs (M4.6)
  fill_escalation_step_sat_per_eh_day: positiveInt,
  fill_escalation_after_minutes: positiveInt,
  max_overpay_sat_per_eh_day: nonNegativeInt,
  // Escalation mode for upward price adjustments:
  // - 'market': jump directly to fillable + max_overpay (tracks market)
  // - 'dampened': step from current_bid + escalation_step (avoids chasing spikes)
  escalation_mode: z.enum(['market', 'dampened']).default('dampened'),
  // Minimum overpay (vs fillable + max_overpay target) before lowering.
  // Avoids micro-edits that burn the Braiins 10-min decrease cooldown for
  // a few sat of savings.
  min_lower_delta_sat_per_eh_day: nonNegativeInt,
  hibernate_on_expensive_market: z.boolean(),

  // Electrs (optional, for fast balance lookups)
  electrs_host: z.string().nullable().default(null),
  electrs_port: z.number().int().positive().nullable().default(null),

  // Boot mode — how the daemon chooses run_mode on startup.
  boot_mode: z
    .enum(['ALWAYS_DRY_RUN', 'LAST_MODE', 'ALWAYS_LIVE'])
    .default('ALWAYS_DRY_RUN'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

/**
 * Cross-field invariants that Zod per-field refinements can't express cleanly.
 * Used via `.superRefine` or after the base parse.
 */
export const AppConfigInvariantsSchema = AppConfigSchema.superRefine((cfg, ctx) => {
  if (cfg.minimum_floor_hashrate_ph > cfg.target_hashrate_ph) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['minimum_floor_hashrate_ph'],
      message: 'floor must be <= target hashrate',
    });
  }
  if (cfg.max_bid_sat_per_eh_day > cfg.emergency_max_bid_sat_per_eh_day) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['emergency_max_bid_sat_per_eh_day'],
      message: 'emergency cap must be >= normal max bid',
    });
  }
  if (cfg.below_floor_alert_after_minutes >= cfg.below_floor_emergency_cap_after_minutes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['below_floor_emergency_cap_after_minutes'],
      message: 'emergency cap must fire strictly after the alert',
    });
  }
});

// ---------------------------------------------------------------------------
// Sensible defaults for first-run setup
// ---------------------------------------------------------------------------

export const APP_CONFIG_DEFAULTS: Omit<
  AppConfig,
  | 'destination_pool_url'
  | 'destination_pool_worker_name'
  | 'btc_payout_address'
  | 'telegram_chat_id'
> = {
  target_hashrate_ph: 1.0,
  minimum_floor_hashrate_ph: 0.5,

  // Sensible upper bound; operator will tune once live market data is in view.
  max_bid_sat_per_eh_day: 60_000_000,
  emergency_max_bid_sat_per_eh_day: 90_000_000,

  monthly_budget_ceiling_sat: 500_000,
  bid_budget_sat: 50_000,

  wallet_runway_alert_days: 3,
  below_floor_alert_after_minutes: 10,
  below_floor_emergency_cap_after_minutes: 30,
  zero_hashrate_loud_alert_after_minutes: 15,
  pool_outage_blip_tolerance_seconds: 120,
  api_outage_alert_after_minutes: 10,

  quiet_hours_start: '22:00',
  quiet_hours_end: '08:00',
  quiet_hours_timezone: 'Europe/Amsterdam',
  confirmation_timeout_minutes: 15,
  handover_window_minutes: 30,

  // Strategy knobs defaults derived from the first-run interview.
  // 300 sat/PH/day = 300_000 sat/EH/day.
  fill_escalation_step_sat_per_eh_day: 300_000,
  fill_escalation_after_minutes: 30,
  max_overpay_sat_per_eh_day: 500_000,
  escalation_mode: 'dampened',
  min_lower_delta_sat_per_eh_day: 200_000,
  hibernate_on_expensive_market: true,

  electrs_host: null,
  electrs_port: null,

  boot_mode: 'ALWAYS_DRY_RUN',
};
