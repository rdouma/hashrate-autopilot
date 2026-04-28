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

  // Legacy — kept optional so old .env.sops.yaml files still parse.
  telegram_bot_token: nonEmptyString.optional(),
  telegram_webhook_secret: nonEmptyString.optional(),

  // bitcoind RPC is edited from the dashboard Config page (#14 moved these
  // out of the secrets file). Kept as optional so existing .env.sops.yaml
  // files still parse; the daemon prefers `config.bitcoind_rpc_*` and only
  // falls back to these if they're ever set.
  bitcoind_rpc_url: z.string().url('must be a valid URL (http(s)://host:port)').optional(),
  bitcoind_rpc_user: nonEmptyString.optional(),
  bitcoind_rpc_password: nonEmptyString.optional(),

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

  // Overpay above fillable_ask (#53 pay-your-bid redesign).
  // Each tick the controller targets `fillable_ask + overpay_sat_per_eh_day`,
  // clamped to the effective cap. The one knob that tunes how hard we
  // chase the market: higher = more headroom against tick-to-tick
  // upward moves (safer fills, bigger premium); lower = closer to the
  // cheapest fillable price (lower cost, more sensitive to noise).
  // Default 1_000_000 sat/EH/day = 1,000 sat/PH/day.
  overpay_sat_per_eh_day: positiveInt.default(1_000_000),

  // Budgeting — size of the `amount_sat` on each CREATE_BID. 0 is a
  // sentinel meaning "use the full available wallet balance on each
  // create" (resolved at decision time, clamped to Braiins' 1 BTC
  // per-bid hard cap). Positive integers set an explicit budget.
  // See issue #40.
  bid_budget_sat: nonNegativeInt,

  // Alerting thresholds (SPEC §9)
  wallet_runway_alert_days: positiveInt,
  below_floor_alert_after_minutes: positiveInt,
  zero_hashrate_loud_alert_after_minutes: positiveInt,
  pool_outage_blip_tolerance_seconds: nonNegativeInt,
  api_outage_alert_after_minutes: positiveInt,

  handover_window_minutes: positiveInt,

  // Accounting
  btc_payout_address: nonEmptyString,

  // The elaborate fill-strategy machinery (escalation modes, lowering
  // patience, min-lower-delta, fill-escalation-step/after) was retired
  // in #49 under a CLOB assumption and NOT brought back under the
  // pay-your-bid correction (#53). The new controller targets
  // `fillable_ask + overpay_sat_per_eh_day` directly every tick; the
  // old timers were a way to simulate that target under a mistaken
  // mental model. Braiins' own 10-min price-decrease cooldown is
  // enforced by gate.ts — no additional patience timer is needed.

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
  spent_scope: z.enum(['autopilot', 'account']).default('account'),

  // BTC/USD price oracle. 'none' disables the price fetcher; other
  // values name the exchange API to poll. Feeds the dashboard's
  // denomination toggle (sats <-> USD).
  btc_price_source: z.enum(['none', 'coingecko', 'coinbase', 'bitstamp', 'kraken']).default('coingecko'),

  // Opportunistic hashrate scaling (issue #13).
  // When the market price is cheap vs the break-even hashprice, scale
  // up to cheap_target_hashrate_ph instead of the normal target.
  // Both values must be non-zero to activate.
  cheap_target_hashrate_ph: z.number().nonnegative().default(0),
  cheap_threshold_pct: z.number().int().nonnegative().max(100).default(0),
  // Rolling-average window for the cheap-mode engagement check (#50).
  // 0 (default) = per-tick spot check on best_ask (legacy behaviour).
  // > 0 = cheap-mode engages only when avg(best_ask) over this many
  // minutes is below cheap_threshold_pct * avg(hashprice) over the
  // same window. Avoids flapping on single-tick market spikes. The
  // window pattern gives implicit hysteresis — cheap-mode only flips
  // when the window as a whole crosses the threshold.
  cheap_sustained_window_minutes: z.number().int().nonnegative().default(0),

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

  // Block explorer URL template used for click-through from the Ocean
  // panel's "last pool block" row and the cube tooltips on the Hashrate
  // chart (issue #22). `{hash}` and `{height}` are substituted; at least
  // one placeholder is required so the link actually points somewhere.
  // Default = mempool.space so a fresh install has working links
  // without a config step.
  block_explorer_url_template: z
    .string()
    .min(1)
    .refine(
      (v) => v.includes('{hash}') || v.includes('{height}'),
      { message: 'must contain {hash} or {height} placeholder' },
    )
    .default('https://mempool.space/block/{hash}'),

  // Chart smoothing — rolling-mean minute window applied client-side
  // to the hashrate chart's Braiins-delivered and Datum-received
  // series (issue #42). 1 = no smoothing. Ocean is excluded because
  // its /user_hashrate endpoint already returns a 5-min average.
  // Display-only; not read by the control loop.
  braiins_hashrate_smoothing_minutes: positiveInt.default(1),
  datum_hashrate_smoothing_minutes: positiveInt.default(1),
  // Rolling-mean minute window applied client-side to the price
  // chart's `our bid` (amber) and `effective` (emerald) series (#49
  // follow-up). 1 = no smoothing. The effective line in particular
  // is noisy at tick resolution because Braiins' amount_consumed_sat
  // snapshots update asynchronously from avg_speed_ph — a rolling
  // mean lets the operator see the trend rather than per-tick
  // quantisation. Fillable / hashprice / max_bid are unaffected
  // (they're market-wide signals, not ours).
  braiins_price_smoothing_minutes: positiveInt.default(1),

  // Operator toggle for the emerald "effective" line on the price
  // chart. Off by default — the line's per-tick volatility auto-scales
  // the Y-axis and crushes the much flatter bid/fillable/hashprice
  // detail. The hero PRICE card + AVG COST / PH DELIVERED stat card
  // already surface the effective rate as a number. Flip on to inspect
  // the settlement rate directly; accept the loss of flatter-line
  // detail in exchange.
  show_effective_rate_on_price_chart: z.boolean().default(false),

  // Operator toggle for the violet `% of Ocean` line on the Hashrate
  // chart (issue #72). Off by default — the controller does not read
  // share_log_pct; adding a second Y-axis to a chart that already
  // carries 3-5 hashrate lines costs more glance-time than most
  // operators need. Flip on when you want to track how our slice of
  // the pool drifts as Ocean's total hashrate grows or our delivered
  // PH/s fluctuates.
  show_share_log_on_hashrate_chart: z.boolean().default(false),
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
> = {
  target_hashrate_ph: 1.0,
  minimum_floor_hashrate_ph: 0.5,

  // Pricing caps. sat/EH/day internally; the dashboard displays them
  // in sat/PH/day (1 sat/PH/day = 1,000 sat/EH/day).
  max_bid_sat_per_eh_day: 49_000_000, // 49,000 sat/PH/day
  // Dynamic hashprice-relative cap enabled by default — typical hashprice
  // today is ~46,000 sat/PH/day, so a 2,000 premium caps at ~48,000 which
  // is comfortably below the fixed cap without being overly tight.
  max_overpay_vs_hashprice_sat_per_eh_day: 2_000_000, // 2,000 sat/PH/day
  // Pay-your-bid overpay above fillable_ask (#53). 1,000 sat/PH/day.
  overpay_sat_per_eh_day: 1_000_000,

  bid_budget_sat: 0, // 0 = use full wallet balance per CREATE (#40)

  wallet_runway_alert_days: 3,
  below_floor_alert_after_minutes: 10,
  zero_hashrate_loud_alert_after_minutes: 15,
  pool_outage_blip_tolerance_seconds: 120,
  api_outage_alert_after_minutes: 10,

  handover_window_minutes: 30,

  // Strategy knobs. sat/EH/day internally; 100 sat/PH/day = 100,000 sat/EH/day.

  electrs_host: null,
  electrs_port: null,

  boot_mode: 'ALWAYS_DRY_RUN',
  spent_scope: 'account',
  btc_price_source: 'coingecko',

  cheap_target_hashrate_ph: 0,
  cheap_threshold_pct: 0,
  cheap_sustained_window_minutes: 0,

  bitcoind_rpc_url: '',
  bitcoind_rpc_user: '',
  bitcoind_rpc_password: '',

  payout_source: 'none',

  tick_metrics_retention_days: 7,
  decisions_uneventful_retention_days: 7,
  decisions_eventful_retention_days: 90,

  datum_api_url: null,

  block_explorer_url_template: 'https://mempool.space/block/{hash}',

  braiins_hashrate_smoothing_minutes: 1,
  datum_hashrate_smoothing_minutes: 1,
  braiins_price_smoothing_minutes: 1,

  show_effective_rate_on_price_chart: false,
  show_share_log_on_hashrate_chart: false,
};
