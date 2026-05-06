/**
 * Environment-variable overrides for {@link AppConfig} and
 * {@link Secrets}.
 *
 * Resolution priority is `env > db (or sops file) > schema defaults`.
 * The two `applyEnvOverridesToX` helpers take an already-loaded
 * config/secrets object and overlay any matching env-var values on
 * top, then re-validate via the canonical Zod schema. A missing or
 * blank env var leaves the underlying value unchanged.
 *
 * Why: appliance manifests (Umbrel, Start9, vanilla `docker run`)
 * inject configuration declaratively as environment variables. The
 * SOPS / `setup.ts` path stays for power users; this layer makes
 * "just set these env vars and run the container" a complete path.
 *
 * Naming convention: `BHA_<UPPER_SNAKE_FIELD_NAME>` for both config
 * and secret fields. `BHA_` (Braiins Hashrate Autopilot) prefix
 * keeps these out of collision with the unrelated `BITCOIN_RPC_*`
 * env vars Umbrel / Start9 inject for bitcoind discovery (#60).
 */

import {
  AppConfigInvariantsSchema,
  SecretsSchema,
  type AppConfig,
  type Secrets,
} from './schema.js';

// ---------------------------------------------------------------------------
// Per-field coercion table - AppConfig
// ---------------------------------------------------------------------------

/**
 * Coercer signature: take the raw string from the env, return the
 * value the schema expects (number, string, null, etc.). Throw on
 * anything that obviously won't pass schema validation - the surfaced
 * error is more actionable than a deeply-nested Zod failure.
 */
type Coercer = (raw: string, fieldName: string) => unknown;

const asNumber: Coercer = (raw, name) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env var ${name}: expected a number, got "${raw}"`);
  }
  return n;
};

const asInt: Coercer = (raw, name) => {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`env var ${name}: expected an integer, got "${raw}"`);
  }
  return n;
};

const asString: Coercer = (raw) => raw;

const asBoolean: Coercer = (raw, name) => {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new Error(`env var ${name}: expected a boolean (true/false), got "${raw}"`);
};

/** Empty string → null, otherwise number. Mirrors the schema's `null`-on-empty behaviour. */
const asIntOrNullOnEmpty: Coercer = (raw, name) => {
  if (raw === '') return null;
  return asInt(raw, name);
};

/** Empty string → null, otherwise the raw string. */
const asStringOrNullOnEmpty: Coercer = (raw) => (raw === '' ? null : raw);

// Entries are in the same order as schema.ts to make audits easy.
// Every key in AppConfig must appear here so `satisfies` catches drift.
const APP_CONFIG_ENV: {
  readonly [K in keyof AppConfig]: { varName: string; coerce: Coercer };
} = {
  target_hashrate_ph: { varName: 'BHA_TARGET_HASHRATE_PH', coerce: asNumber },
  minimum_floor_hashrate_ph: { varName: 'BHA_MINIMUM_FLOOR_HASHRATE_PH', coerce: asNumber },
  destination_pool_url: { varName: 'BHA_DESTINATION_POOL_URL', coerce: asString },
  destination_pool_worker_name: { varName: 'BHA_DESTINATION_POOL_WORKER_NAME', coerce: asString },
  max_bid_sat_per_eh_day: { varName: 'BHA_MAX_BID_SAT_PER_EH_DAY', coerce: asInt },
  max_overpay_vs_hashprice_sat_per_eh_day: {
    varName: 'BHA_MAX_OVERPAY_VS_HASHPRICE_SAT_PER_EH_DAY',
    coerce: asIntOrNullOnEmpty,
  },
  overpay_sat_per_eh_day: { varName: 'BHA_OVERPAY_SAT_PER_EH_DAY', coerce: asInt },
  bid_budget_sat: { varName: 'BHA_BID_BUDGET_SAT', coerce: asInt },
  wallet_runway_alert_days: { varName: 'BHA_WALLET_RUNWAY_ALERT_DAYS', coerce: asInt },
  below_floor_alert_after_minutes: {
    varName: 'BHA_BELOW_FLOOR_ALERT_AFTER_MINUTES',
    coerce: asInt,
  },
  zero_hashrate_loud_alert_after_minutes: {
    varName: 'BHA_ZERO_HASHRATE_LOUD_ALERT_AFTER_MINUTES',
    coerce: asInt,
  },
  pool_outage_blip_tolerance_seconds: {
    varName: 'BHA_POOL_OUTAGE_BLIP_TOLERANCE_SECONDS',
    coerce: asInt,
  },
  api_outage_alert_after_minutes: {
    varName: 'BHA_API_OUTAGE_ALERT_AFTER_MINUTES',
    coerce: asInt,
  },
  handover_window_minutes: { varName: 'BHA_HANDOVER_WINDOW_MINUTES', coerce: asInt },
  btc_payout_address: { varName: 'BHA_BTC_PAYOUT_ADDRESS', coerce: asString },
  electrs_host: { varName: 'BHA_ELECTRS_HOST', coerce: asStringOrNullOnEmpty },
  electrs_port: { varName: 'BHA_ELECTRS_PORT', coerce: asIntOrNullOnEmpty },
  boot_mode: { varName: 'BHA_BOOT_MODE', coerce: asString },
  spent_scope: { varName: 'BHA_SPENT_SCOPE', coerce: asString },
  btc_price_source: { varName: 'BHA_BTC_PRICE_SOURCE', coerce: asString },
  cheap_target_hashrate_ph: { varName: 'BHA_CHEAP_TARGET_HASHRATE_PH', coerce: asNumber },
  cheap_threshold_pct: { varName: 'BHA_CHEAP_THRESHOLD_PCT', coerce: asInt },
  cheap_sustained_window_minutes: {
    varName: 'BHA_CHEAP_SUSTAINED_WINDOW_MINUTES',
    coerce: asInt,
  },
  bitcoind_rpc_url: { varName: 'BHA_BITCOIND_RPC_URL', coerce: asString },
  bitcoind_rpc_user: { varName: 'BHA_BITCOIND_RPC_USER', coerce: asString },
  bitcoind_rpc_password: { varName: 'BHA_BITCOIND_RPC_PASSWORD', coerce: asString },
  payout_source: { varName: 'BHA_PAYOUT_SOURCE', coerce: asString },
  tick_metrics_retention_days: {
    varName: 'BHA_TICK_METRICS_RETENTION_DAYS',
    coerce: asInt,
  },
  decisions_uneventful_retention_days: {
    varName: 'BHA_DECISIONS_UNEVENTFUL_RETENTION_DAYS',
    coerce: asInt,
  },
  decisions_eventful_retention_days: {
    varName: 'BHA_DECISIONS_EVENTFUL_RETENTION_DAYS',
    coerce: asInt,
  },
  datum_api_url: { varName: 'BHA_DATUM_API_URL', coerce: asStringOrNullOnEmpty },
  block_explorer_url_template: {
    varName: 'BHA_BLOCK_EXPLORER_URL_TEMPLATE',
    coerce: asString,
  },
  braiins_hashrate_smoothing_minutes: {
    varName: 'BHA_BRAIINS_HASHRATE_SMOOTHING_MINUTES',
    coerce: asInt,
  },
  datum_hashrate_smoothing_minutes: {
    varName: 'BHA_DATUM_HASHRATE_SMOOTHING_MINUTES',
    coerce: asInt,
  },
  braiins_price_smoothing_minutes: {
    varName: 'BHA_BRAIINS_PRICE_SMOOTHING_MINUTES',
    coerce: asInt,
  },
  show_effective_rate_on_price_chart: {
    varName: 'BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART',
    coerce: asBoolean,
  },
  show_share_log_on_hashrate_chart: {
    varName: 'BHA_SHOW_SHARE_LOG_ON_HASHRATE_CHART',
    coerce: asBoolean,
  },
  block_found_sound: {
    varName: 'BHA_BLOCK_FOUND_SOUND',
    coerce: asString,
  },
};

// ---------------------------------------------------------------------------
// Per-field coercion table - Secrets
// ---------------------------------------------------------------------------

const SECRETS_ENV: {
  readonly [K in keyof Secrets]: { varName: string; coerce: Coercer };
} = {
  braiins_owner_token: { varName: 'BHA_BRAIINS_OWNER_TOKEN', coerce: asString },
  braiins_read_only_token: { varName: 'BHA_BRAIINS_READ_ONLY_TOKEN', coerce: asString },
  telegram_bot_token: { varName: 'BHA_TELEGRAM_BOT_TOKEN', coerce: asString },
  telegram_webhook_secret: {
    varName: 'BHA_TELEGRAM_WEBHOOK_SECRET',
    coerce: asString,
  },
  bitcoind_rpc_url: { varName: 'BHA_BITCOIND_RPC_URL', coerce: asString },
  bitcoind_rpc_user: { varName: 'BHA_BITCOIND_RPC_USER', coerce: asString },
  bitcoind_rpc_password: { varName: 'BHA_BITCOIND_RPC_PASSWORD', coerce: asString },
  dashboard_password: { varName: 'BHA_DASHBOARD_PASSWORD', coerce: asString },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Public list of every recognised env-var name across config and
 * secrets, in the order they appear in the schema. Surfaced here
 * (rather than buried inside the coercion tables) so the docs page
 * and any operator-facing tooling can introspect what's overridable.
 */
export const KNOWN_ENV_VARS: readonly string[] = [
  ...Object.values(APP_CONFIG_ENV).map((e) => e.varName),
  ...Object.values(SECRETS_ENV)
    .map((e) => e.varName)
    .filter((v) => !Object.values(APP_CONFIG_ENV).some((c) => c.varName === v)),
];

/**
 * Apply env-var overrides on top of an already-loaded `AppConfig`.
 * Re-validates via the canonical schema after merge so any malformed
 * env value surfaces a Zod error.
 *
 * Empty-string env values are treated as "set to empty" (matters for
 * nullable fields where `""` semantically means "clear"). To leave a
 * value untouched, simply don't set the env var.
 */
export function applyEnvOverridesToConfig(
  cfg: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const overrides: Record<string, unknown> = {};
  for (const [field, { varName, coerce }] of Object.entries(APP_CONFIG_ENV)) {
    const raw = env[varName];
    if (raw === undefined) continue;
    overrides[field] = coerce(raw, varName);
  }
  if (Object.keys(overrides).length === 0) return cfg;
  // Re-validate via the invariants schema (cross-field guards) so a
  // bad combination like `floor > target` injected from env still
  // fails loudly instead of silently corrupting the controller.
  return AppConfigInvariantsSchema.parse({ ...cfg, ...overrides });
}

/**
 * Apply env-var overrides on top of already-loaded `Secrets`.
 *
 * Same semantics as `applyEnvOverridesToConfig` - empty string
 * overrides the underlying value with `""`, which fails schema
 * validation for the required tokens (intentional: an operator who
 * sets `BHA_BRAIINS_OWNER_TOKEN=` to "blank it" should see an error,
 * not a silently-disabled daemon).
 */
export function applyEnvOverridesToSecrets(
  secrets: Secrets,
  env: NodeJS.ProcessEnv = process.env,
): Secrets {
  const overrides: Record<string, unknown> = {};
  for (const [field, { varName, coerce }] of Object.entries(SECRETS_ENV)) {
    const raw = env[varName];
    if (raw === undefined) continue;
    overrides[field] = coerce(raw, varName);
  }
  if (Object.keys(overrides).length === 0) return secrets;
  return SecretsSchema.parse({ ...secrets, ...overrides });
}

/**
 * Build a `Secrets` object purely from environment variables - used
 * by the wizard / NEEDS_SETUP path (#57) to decide whether the
 * appliance has provided enough secret material to skip the wizard
 * entirely. Returns `null` if any required field is missing.
 */
export function buildSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): Secrets | null {
  const candidate: Record<string, unknown> = {};
  for (const [field, { varName, coerce }] of Object.entries(SECRETS_ENV)) {
    const raw = env[varName];
    if (raw === undefined) continue;
    candidate[field] = coerce(raw, varName);
  }
  const parsed = SecretsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
