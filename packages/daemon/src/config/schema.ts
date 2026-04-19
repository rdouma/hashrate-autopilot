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
  // Hashprice-relative cap (issue #27). When set, the effective price
  // ceiling on each tick becomes min(max_bid, hashprice + this). Null
  // disables it, falling back to the fixed max_bid. Also falls back
  // when hashprice is unavailable (Ocean stats down). Stops the
  // autopilot from wildly overpaying when hashprice drops sharply and
  // the fixed max_bid alone would still allow it. 0 from the
  // dashboard is coerced to null so a blank field in the UI reads as
  // "disabled" end-to-end.
  max_overpay_vs_hashprice_sat_per_eh_day: z
    .preprocess(
      (v) => (v === 0 ? null : v),
      positiveInt.nullable(),
    )
    .default(null),

  // Budgeting
  monthly_budget_ceiling_sat: positiveInt,
  bid_budget_sat: positiveInt,

  // Alerting thresholds (SPEC §9)
  wallet_runway_alert_days: positiveInt,
  below_floor_alert_after_minutes: positiveInt,
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
  overpay_sat_per_eh_day: nonNegativeInt,
  // Escalation mode for upward price adjustments:
  // - 'market': jump directly to fillable + overpay (tracks market)
  // - 'dampened': step from current_bid + escalation_step (avoids chasing spikes)
  escalation_mode: z.enum(['market', 'dampened']).default('dampened'),
  // Minimum overpay (vs fillable + overpay target) before lowering.
  // Avoids micro-edits that burn the Braiins 10-min decrease cooldown for
  // a few sat of savings.
  min_lower_delta_sat_per_eh_day: nonNegativeInt,
  // How long (minutes) the autopilot must be continuously above floor
  // before it considers lowering the price. Prevents chasing short market
  // dips that reverse within minutes — each unnecessary lower burns the
  // Braiins 10-min price-decrease cooldown.
  lower_patience_minutes: nonNegativeInt,

  // Electrs (optional, for fast balance lookups)
  electrs_host: z.string().nullable().default(null),
  electrs_port: z.number().int().positive().nullable().default(null),

  // Boot mode — how the daemon chooses run_mode on startup.
  boot_mode: z
    .enum(['ALWAYS_DRY_RUN', 'LAST_MODE', 'ALWAYS_LIVE'])
    .default('ALWAYS_DRY_RUN'),

  // Money panel: which "spent" figure to display.
  // - 'autopilot': only bids the autopilot has tagged in owned_bids
  //   (correct number for "what has the autopilot itself spent",
  //   but ignores any bids that existed before it was switched on).
  // - 'account':  sum of every "(Partial) order settlement (brutto
  //   price)" entry from Braiins's /v1/account/transaction ledger,
  //   covering the full account history. Pairs honestly with Ocean's
  //   lifetime earnings on the income side.
  spent_scope: z.enum(['autopilot', 'account']).default('autopilot'),

  // BTC/USD price oracle. 'none' disables the price fetcher; other
  // values name the exchange API to poll. Feeds the dashboard's
  // denomination toggle (sats <-> USD).
  btc_price_source: z.enum(['none', 'coingecko', 'coinbase', 'bitstamp', 'kraken']).default('none'),

  // Opportunistic hashrate scaling (issue #13).
  // When the market price is cheap vs the break-even hashprice, scale
  // up to cheap_target_hashrate_ph instead of the normal target.
  // Both values must be non-zero to activate.
  cheap_target_hashrate_ph: z.number().nonnegative().default(0),
  cheap_threshold_pct: z.number().int().nonnegative().max(100).default(0),

  // Bitcoin Core RPC credentials (issue #14).
  // Seeded from secrets on first boot; editable from the dashboard afterwards.
  // Empty strings mean "not configured" — the daemon falls back to secrets.
  bitcoind_rpc_url: z.string().default(''),
  bitcoind_rpc_user: z.string().default(''),
  bitcoind_rpc_password: z.string().default(''),

  // Payout observation source — which backend to use for on-chain balance
  // tracking. 'none' disables tracking entirely; 'electrs' uses the fast
  // Electrum-style indexed lookup; 'bitcoind' falls back to scantxoutset.
  payout_source: z.enum(['none', 'electrs', 'bitcoind']).default('none'),

  // Retention windows for the append-only tables (issue #21).
  //
  // `tick_metrics` grows at 1 row/tick/day (~1,440/day). Chart data is
  // the only consumer; a week of history already covers every default
  // range on the dashboard. `decisions` similarly grows 1 row/tick/day
  // but with heavy JSON payloads; we retain "uneventful" (no-proposal)
  // rows for only a few days and keep decision-bearing rows longer
  // because those are the actionable forensic records.
  //
  // Set to 0 to disable pruning for that table (keep forever).
  tick_metrics_retention_days: nonNegativeInt.default(7),
  decisions_uneventful_retention_days: nonNegativeInt.default(7),
  decisions_eventful_retention_days: nonNegativeInt.default(90),

  // Optional Datum Gateway stats API (issue #19). When set, the daemon
  // polls {datum_api_url}/umbrel-api each tick to record Datum's view
  // of connection count and hashrate. Integration is informational
  // only — the control loop never depends on Datum being reachable.
  // See docs/setup-datum-api.md for the Umbrel-side port exposure.
  // Empty string is coerced to null so the dashboard's generic text
  // input can clear the field without tripping URL validation.
  datum_api_url: z
    .preprocess(
      (v) => (v === '' ? null : v),
      z.string().url().nullable(),
    )
    .default(null),
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
  // Dynamic hashprice-relative cap — disabled by default so existing
  // installs see no behaviour change. Operator opts in from Config.
  max_overpay_vs_hashprice_sat_per_eh_day: null,

  monthly_budget_ceiling_sat: 500_000,
  bid_budget_sat: 50_000,

  wallet_runway_alert_days: 3,
  below_floor_alert_after_minutes: 10,
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
  overpay_sat_per_eh_day: 500_000,
  escalation_mode: 'dampened',
  min_lower_delta_sat_per_eh_day: 200_000,
  lower_patience_minutes: 15,

  electrs_host: null,
  electrs_port: null,

  boot_mode: 'ALWAYS_DRY_RUN',
  spent_scope: 'autopilot',
  btc_price_source: 'none',

  cheap_target_hashrate_ph: 0,
  cheap_threshold_pct: 0,

  bitcoind_rpc_url: '',
  bitcoind_rpc_user: '',
  bitcoind_rpc_password: '',

  payout_source: 'none',

  tick_metrics_retention_days: 7,
  decisions_uneventful_retention_days: 7,
  decisions_eventful_retention_days: 90,

  datum_api_url: null,
};
