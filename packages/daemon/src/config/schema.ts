/**
 * Zod schemas for the two tiers of configuration:
 *
 * - {@link SecretsSchema} - values held in the sops-encrypted file on disk.
 *   Decrypted at startup, kept in memory, never re-written plain.
 *
 * - {@link AppConfigSchema} - live-editable tunables stored in the SQLite
 *   `config` table. Validated on every write (architecture §7) and on read
 *   via repository layer. Shape mirrors SPEC §8 and architecture §5.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Secrets (encrypted at rest)
// ---------------------------------------------------------------------------

// Braiins API tokens are opaque bearer strings; we require at minimum that
// they are non-empty. Read-only is optional - a user may only have one token.
const nonEmptyString = z.string().min(1, 'must be non-empty');

export const SecretsSchema = z.object({
  braiins_owner_token: nonEmptyString,
  braiins_read_only_token: nonEmptyString.optional(),

  // #100: Telegram bot token. Optional so installs without notifications
  // configured still parse; when set it's the authentication credential
  // for POST https://api.telegram.org/bot{token}/sendMessage.
  telegram_bot_token: nonEmptyString.optional(),

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

  // Destination pool (SPEC §8 - Datum-connected Ocean).
  // Empty string is allowed so the wizard can be completed before the
  // operator has a publicly reachable hostname (DDNS can be set up
  // later from Config). The control loop skips bid creation and pool
  // probing when this is empty.
  destination_pool_url: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.union([z.string().url(), z.literal('')]),
  ),
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

  // #222: EDIT_PRICE deadband as a percentage of overpay. The deadband
  // computed in decide.ts is `max(tick_size, overpay × pct / 100)`. If
  // the absolute difference from target to current bid sits below the
  // deadband, no EDIT_PRICE fires. Default 20 reproduces the legacy
  // hard-coded `overpay / 5` behaviour (1/5 = 20%). Raising to 50 ≈
  // halves the edit frequency and roughly doubles the price-jitter
  // tolerated before a re-price - useful to dampen chart noise today
  // and to reduce per-edit costs if Braiins ever introduces an EDIT
  // fee (see SpotMarketFeeType SPOT_FEE_TYPE_EDIT). The `tick_size`
  // floor is independent of this setting - Braiins rejects sub-tick
  // edits regardless.
  bid_edit_deadband_pct: z.number().nonnegative().default(20),

  // #222: maximum fee_rate_pct (carried per-bid in /spot/bid/current)
  // the operator is willing to tolerate before the mutation gate
  // halts new CREATE_BID / EDIT_PRICE / EDIT_SPEED. CANCEL_BID
  // remains allowed so the operator (or a Datum-down auto-cancel)
  // can still bail out of a fee-bearing bid. Default 0: halt the
  // moment Braiins exits beta and starts charging any fee at all,
  // matching the semantics of the existing `beta_exit` Telegram
  // alert. Raise to (say) 0.5 to tolerate a 0.5% fee without
  // tripping the halt. The halt clears automatically the next tick
  // every active bid is at-or-below the threshold - the threshold
  // *is* the operator's acknowledgement; no separate clear button.
  max_acceptable_fee_pct: z.number().nonnegative().default(0),

  // Budgeting - size of the `amount_sat` on each CREATE_BID. 0 is a
  // sentinel meaning "use the full available wallet balance on each
  // create" (resolved at decision time, clamped to Braiins' 1 BTC
  // per-bid hard cap). Positive integers set an explicit budget.
  // See issue #40.
  bid_budget_sat: nonNegativeInt,

  // Alerting thresholds (SPEC §9). wallet_runway_alert_days = 0
  // disables the wallet-runway notification end-to-end (no transition
  // arming, no Telegram POST, no alert row); cleaner than digging
  // into the per-class opt-out for the same effect. #116.
  // Fractional values allowed (e.g. 4.1 days) - the burn rate is
  // a continuous quantity and operators reasonably want sub-day
  // resolution near the threshold. 0 still disables.
  wallet_runway_alert_days: z.number().nonnegative(),
  below_floor_alert_after_minutes: positiveInt,
  zero_hashrate_loud_alert_after_minutes: positiveInt,
  pool_outage_blip_tolerance_seconds: nonNegativeInt,
  // #135: dedicated alert thresholds, split out from
  // pool_outage_blip_tolerance_seconds × 5. The dashboard's
  // reachability pill keeps using the blip tolerance; these two are
  // strictly the Telegram-alert thresholds and are tunable
  // independently per detector.
  datum_unreachable_alert_after_minutes: positiveInt.default(10),
  sustained_paused_alert_after_minutes: positiveInt.default(10),
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
  // enforced by gate.ts - no additional patience timer is needed.

  // Electrs (optional, for fast balance lookups)
  electrs_host: z.string().nullable().default(null),
  electrs_port: z.number().int().positive().nullable().default(null),

  // Boot mode - how the daemon chooses run_mode on startup.
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
  // Sustained-window check for cheap-mode engagement (#50 / #160).
  // 0 (default) = per-tick spot check (our bid vs hashprice, current tick only).
  // > 0 = cheap-mode engages only when EVERY tick in the last N minutes had
  //   `(fillable + overpay) < (cheap_threshold_pct / 100) * hashprice`
  //   AND there are at least N ticks of complete data (one per minute at the
  //   60 s tick cadence). Literal sustained-below semantics - one outlier
  //   doesn't trigger; one missing tick keeps engagement off.
  cheap_sustained_window_minutes: z.number().int().nonnegative().default(0),

  // Bitcoin Knots RPC credentials (issue #14).
  // Seeded from secrets on first boot; editable from the dashboard afterwards.
  // Empty strings mean "not configured" - the daemon falls back to secrets.
  bitcoind_rpc_url: z.string().default(''),
  bitcoind_rpc_user: z.string().default(''),
  bitcoind_rpc_password: z.string().default(''),

  // Payout observation source - which backend to use for on-chain balance
  // tracking. 'none' disables tracking entirely; 'electrs' uses the fast
  // Electrum-style indexed lookup; 'bitcoind' falls back to scantxoutset.
  payout_source: z.enum(['none', 'electrs', 'bitcoind']).default('none'),

  // Retention windows for the append-only tables (issues #21, #80).
  //
  // `tick_metrics` is a compact numeric time series (~1,440 rows/day)
  // that backs every dashboard chart. Cheap on disk, high value as
  // history. `decisions` is a forensic decision log split into:
  //   - uneventful (no-proposal ticks): heavy JSON state snapshots
  //     that are the main bloat lever; default 7 days.
  //   - eventful (>=1 proposal): rare (~10% of ticks) and high value
  //     for "why did the autopilot do that?" questions.
  // `alerts` (#119) is the Telegram notification log; small rows but
  // unbounded growth on a long-running install.
  //
  // Defaults: only `decisions_uneventful_retention_days` defaults to
  // a non-zero retention because its rows are large (multi-KB JSON
  // snapshots) and rarely useful past a week. Everything else
  // defaults to 0 (= keep forever); operators can opt into pruning
  // from the Config page if disk space pressure shows up. The
  // tick_metrics chart history is the most likely thing operators
  // will want to keep indefinitely, so 0 (= keep forever) is the
  // friendly default there.
  //
  // Set to 0 to disable pruning for that table (keep forever).
  tick_metrics_retention_days: nonNegativeInt.default(0),
  decisions_uneventful_retention_days: nonNegativeInt.default(7),
  decisions_eventful_retention_days: nonNegativeInt.default(0),
  alerts_retention_days: nonNegativeInt.default(0),

  // #123: count-based marker suppression on the price chart. 0 = no
  // count-based filter (existing per-range showEventKinds rule still
  // applies). When > 0 and the visible event count exceeds this, the
  // dashboard hides EDIT_PRICE markers first; if still over after
  // that, hides everything.
  chart_max_markers: nonNegativeInt.default(0),

  // Optional Datum Gateway stats API (issue #19). When set, the daemon
  // polls {datum_api_url}/umbrel-api each tick to record Datum's view
  // of connection count and hashrate. Integration is informational
  // only - the control loop never depends on Datum being reachable.
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

  // Transaction-URL counterpart to the block-URL template above.
  // Used for the on-chain payout dots on the Price chart's
  // `paid earnings (lifetime)` line - those need to deep-link to the
  // payout transaction, not the block. Kept as a separate template
  // because explorers don't follow a single replacement pattern
  // (blockchair uses /transaction/, btc.com uses /btc/transaction/).
  // The Config UI's preset buttons set both templates atomically.
  block_explorer_tx_url_template: z
    .string()
    .min(1)
    .refine(
      (v) => v.includes('{txid}') || v.includes('{hash}'),
      { message: 'must contain {txid} or {hash} placeholder' },
    )
    .default('https://mempool.space/tx/{txid}'),

  // Chart smoothing - rolling-mean minute window applied client-side
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
  // snapshots update asynchronously from avg_speed_ph - a rolling
  // mean lets the operator see the trend rather than per-tick
  // quantisation. Fillable / hashprice / max_bid are unaffected
  // (they're market-wide signals, not ours).
  braiins_price_smoothing_minutes: positiveInt.default(1),

  // Operator toggle for the emerald "effective" line on the price
  // chart. Off by default - the line's per-tick volatility auto-scales
  // the Y-axis and crushes the much flatter bid/fillable/hashprice
  // detail. The hero PRICE card + AVG COST / PH DELIVERED stat card
  // already surface the effective rate as a number. Flip on to inspect
  // the settlement rate directly; accept the loss of flatter-line
  // detail in exchange.
  show_effective_rate_on_price_chart: z.boolean().default(false),

  // Operator toggle for the violet `% of Ocean` line on the Hashrate
  // chart (issue #72). Off by default - the controller does not read
  // share_log_pct; adding a second Y-axis to a chart that already
  // carries 3-5 hashrate lines costs more glance-time than most
  // operators need. Flip on when you want to track how our slice of
  // the pool drifts as Ocean's total hashrate grows or our delivered
  // PH/s fluctuates.
  show_share_log_on_hashrate_chart: z.boolean().default(false),

  // Audible cue when a new pool block is detected (#88). 'off' is the
  // default so existing installs don't suddenly start playing audio
  // after upgrade. Values map to bundled MP3s under
  // packages/dashboard/public/sounds/{name}.mp3 plus 'custom' which
  // plays the operator-uploaded blob stored in the next two fields.
  // The custom blob/mime are write-only via POST /api/config/block-found-sound
  // and read-back via GET /api/config/block-found-sound (both serve the
  // raw audio bytes, never the JSON config); they are intentionally
  // omitted from this Zod schema so the dashboard's POST /api/config
  // round-trip can't accidentally clobber a 200 KB blob with null.
  block_found_sound: z
    .enum([
      'off',
      'cartoon-cowbell',
      'glass-drop-and-roll',
      'metallic-clank-1',
      'metallic-clank-2',
      'ocean-mining-found-block',
      'custom',
    ])
    .default('off'),

  // #100: Telegram chat id the notifier POSTs into. Empty string =
  // unconfigured (notifier short-circuits with delivery_status='failed'
  // and a clear error message).
  telegram_chat_id: z.string().default(''),

  // #100: live-editable Telegram bot token. Same dual-location pattern
  // as bitcoind_rpc_password: keep the secrets fallback (.env.sops.yaml /
  // first-run wizard) AND surface a config-side editable copy. Daemon
  // resolution at runtime: prefer config when non-empty, fall back to
  // secrets. Empty string means "not configured".
  telegram_bot_token: z.string().default(''),

  // Optional per-instance source label. When non-empty, the
  // TelegramSink prefixes every outbound message with `[<label>] `,
  // so an operator running more than one daemon against the same
  // bot/chat (e.g. dev box + Ubuntu deployment) can tell which
  // instance fired a given alert. Empty string = no prefix.
  telegram_instance_label: z.string().default(''),

  // #100: global mute toggle. When true the notifier skips the actual
  // Telegram POST but still records the alert row + retry ladder, so
  // the operator sees on /alerts what *would* have fired.
  notifications_muted: z.boolean().default(false),

  // #100: cadence between retry attempts while state stays bad.
  // Default 30 minutes; first attempt fires immediately, then up to 4
  // retries at this interval, then a final "giving up" message and
  // silence until recovery or fresh transition.
  notification_retry_interval_minutes: positiveInt.default(30),

  // #106: per-event-class opt-out. Stored as a string[] in the typed
  // config; on the SQLite side it's a comma-separated TEXT column.
  // Empty array = all event classes enabled (the default). The
  // AlertEvaluator short-circuits any class in this list - no alert
  // row, no timer arming, no recovery message. New event classes
  // default to enabled without a migration.
  notification_disabled_event_classes: z.array(z.string()).default([]),

  // #117: opt-in INFO Telegram message at every Ocean pool-block
  // credit (TIDES). Off by default - the audible cue + chart marker
  // already exist, and not every operator wants a phone buzz on
  // every block. Separate boolean rather than a notification_disabled
  // entry because new event classes default to enabled per #106's
  // design; a dedicated toggle keeps "off by default" load-bearing
  // even if the operator later un-mutes everything globally.
  notify_on_pool_block_credit: z.boolean().default(false),

  // #130: opt-in Telegram messages on Braiins deposit lifecycle. Off
  // by default. When on, fires INFO on Detected and Available, and
  // IMPORTANT on Returned (the bad-case "compliance bounced this back"
  // path). The Detected/Available/Returned events ride on the
  // alert-evaluator's standard plumbing including the per-event-class
  // opt-out (#106), so a global on / per-class off is also possible.
  // When off, the daemon still tracks deposits internally (so toggling
  // back on does NOT replay every historical deposit) - it just skips
  // the Telegram POST.
  notify_on_braiins_deposit: z.boolean().default(false),

  // #226: opt-in INFO Telegram alerts on the Ocean payout lifecycle.
  // - notify_on_payout_initiated: fires the tick we observe a sharp
  //   drop in ocean_unpaid_sat (>30% of prior) WITH the residual below
  //   the on-chain payout threshold (1,048,576 sat). At that moment
  //   Ocean has debited the balance and committed to including the
  //   payout in the coinbase of the next block it finds; the
  //   transaction hasn't hit the chain yet.
  // - notify_on_payout_confirmed: fires when the on-chain payout
  //   scanner writes a new row to reward_events (a coinbase output
  //   to the configured payout address has confirmed). Idempotent
  //   via the in-memory `lastNotifiedRewardEventId` watermark in the
  //   alert evaluator, same pattern as pool_block_credited.
  // Both default off so a fresh install / upgrade doesn't start
  // buzzing the operator's phone unannounced.
  notify_on_payout_initiated: z.boolean().default(false),
  notify_on_payout_confirmed: z.boolean().default(false),

  // #131: locale for Telegram message rendering. The dashboard has its
  // own locale picker (Lingui-driven) for the UI; this is the
  // separate, daemon-side locale that drives the language of every
  // Telegram message the alert manager fires. Default 'en'. The
  // catalog only ships en/nl/es today; values outside that set fall
  // back to en at render time.
  notification_locale: z.enum(['en', 'nl', 'es']).default('en'),

  // #227 follow-up: display format preferences promoted from the
  // dashboard's browser localStorage to daemon-managed config. The
  // Display & Logging tab has dropdowns for number format
  // (thousand/decimal separators) and date layout; these used to live
  // in `braiins.numberLocale` / `braiins.dateLayout` localStorage
  // keys, which the daemon couldn't see. Now mirrored here so the
  // Telegram render path can read them. Both default 'system'; the
  // daemon resolves 'system' to 'en-US' since there's no browser
  // context server-side. Values follow the same enums the dashboard
  // shows in its presets: number_locale ∈ {'system','en-US','nl-NL',
  // 'fr-FR','no-grouping'}, date_layout ∈ {'system','us',
  // 'eu-spaced-24h','slash-dmy-24h','iso','slash-mdy-12h'}. The
  // dashboard PATCHes these on change; the daemon caches stay in
  // sync as a write-through.
  display_number_locale: z
    .enum(['system', 'en-US', 'nl-NL', 'fr-FR', 'no-grouping'])
    .default('system'),
  display_date_layout: z
    .enum(['system', 'us', 'eu-spaced-24h', 'slash-dmy-24h', 'iso', 'slash-mdy-12h'])
    .default('system'),

  // #238: per-series chart color overrides. JSON object keyed by
  // canonical series name (e.g. "hashrate.delivered") with hex-string
  // values (`#RRGGBB`). Missing keys fall back to the built-in defaults
  // on the dashboard side, so an empty `{}` preserves the current look.
  // Schema validates as a string here (cheap, no JSON re-parse on every
  // tick); the dashboard's `parseOverrides()` validates and silently
  // drops malformed entries so a stray browser write can't break the
  // chart.
  chart_color_overrides: z.string().default('{}'),

  // #111: daemon-managed DDNS updater. When ddns_provider is non-empty
  // the daemon pushes the current public IP to the configured DDNS
  // provider every 5 minutes (and forces a heartbeat at least hourly,
  // so providers with "no update in 30 days = hostname expired" rules
  // - free No-IP - stay alive). Empty string disables the updater
  // entirely. v1 supports 'noip' only; dyndns2-generic and DuckDNS
  // are planned follow-ups. Driven by motivating incident on
  // 2026-05-07 when mynetgear.com DDNS drift caused a recurring
  // Stratum DOWN false-alarm and a 30+ minute manual diagnosis.
  ddns_provider: z.enum(['', 'noip', 'duckdns', 'dyndns2']).default(''),
  ddns_hostname: z.string().default(''),
  ddns_username: z.string().default(''),
  ddns_credential: z.string().default(''),
  // dyndns2 only: the provider-specific update endpoint, e.g.
  // https://api.dynu.com/nic/update or https://freedns.afraid.org/nic/update.
  // Empty when provider is not 'dyndns2'.
  ddns_update_url: z.string().default(''),
  // #149: solo-mining monitoring (Bitaxe / AxeOS).
  // Off by default - operator opts in via the Config -> Solo miners
  // master toggle. With this flag false the daemon does not poll
  // AxeOS at all and the entire feature surface is hidden from
  // the dashboard.
  solo_mining_enabled: z.boolean().default(false),
  // Global overheating ceiling override. 0 = use the per-ASIC-model
  // lookup table baked into the alert evaluator (BM1370=68, BM1368=70,
  // BM1366=70, BM1397=75, fallback=70). Non-zero = a single global
  // operator override that wins for every device regardless of model.
  // Per-device overrides are out of scope for v1.
  solo_overheating_threshold_celsius: z.number().int().nonnegative().default(0),
  // Consecutive bad-minutes before the solo_zero_hashrate alert fires.
  // "Bad" = hashRate_1m == 0 OR device unreachable.
  solo_zero_hashrate_alert_after_minutes: z.number().int().positive().default(5),
  // Share-rejection rate threshold (percent). Triggers solo_share_rejection
  // when Δrejected / (Δrejected + Δaccepted) over the rolling window
  // exceeds this value.
  solo_share_rejection_threshold_pct: z.number().nonnegative().default(10),
  // Rolling-window size in minutes over which solo share rejection
  // rate is computed.
  solo_share_rejection_window_minutes: z.number().int().positive().default(60),

  // #167: consecutive minutes the Braiins marketplace must have had no
  // hashrate available for our target AND delivery must be ~0 before the
  // `marketplace_empty` Telegram event fires (and the Status-page banner
  // shows). Two-condition gate keeps micro-gaps in the orderbook from
  // tripping a false alert.
  marketplace_empty_alert_after_minutes: z.number().int().positive().default(5),

  // #170: when ON, the payout-observer's electrs path enumerates EVERY
  // coinbase tx ever credited to the payout address and folds them
  // into reward_events, so the chart's lifetime-earnings line reflects
  // historical Ocean payouts even after they've been swept. When OFF,
  // only currently-unspent outputs are counted (pre-#170 behaviour).
  // Default ON because the typical user reuses their payout address;
  // operators with fresh-address discipline can flip it off.
  include_historical_payouts: z.boolean().default(true),

  // #170 follow-up: operator-entered offset for pre-installation /
  // off-chain earnings the payout-observer can't see (Lightning
  // payouts, pre-autopilot Ocean history that's already been swept,
  // etc.). Added to the lifetime-earnings chart's starting value AND
  // to the Status finance panel's net P&L so the picture stays
  // coherent without rotating the payout address. Always positive.
  historical_payouts_offset_sat: z.number().int().nonnegative().default(0),

  // #179: opt-in diagnostics endpoint. When ON, GET /api/debug/dump
  // returns a bundled JSON snapshot of tick_metrics, pool_blocks,
  // alerts, bid_events, reward_events, whitelisted config, and daemon
  // info. Off by default so the endpoint returns 404 and doesn't
  // expand the attack surface for operators who never need it.
  debug_api_enabled: z.boolean().default(false),
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
  // Dynamic hashprice-relative cap enabled by default - typical hashprice
  // today is ~46,000 sat/PH/day, so a 2,000 premium caps at ~48,000 which
  // is comfortably below the fixed cap without being overly tight.
  max_overpay_vs_hashprice_sat_per_eh_day: 2_000_000, // 2,000 sat/PH/day
  // Pay-your-bid overpay above fillable_ask (#53). 1,000 sat/PH/day.
  overpay_sat_per_eh_day: 1_000_000,
  // #222: 20 reproduces the legacy hard-coded overpay/5 = 20% deadband.
  bid_edit_deadband_pct: 20,
  // #222: 0 = halt on any non-zero fee_rate_pct (matches existing
  // beta_exit alert semantics). Set higher to tolerate known fees.
  max_acceptable_fee_pct: 0,

  bid_budget_sat: 0, // 0 = use full wallet balance per CREATE (#40)

  // 0 = disabled. Default off so a fresh install with low (or
  // not-yet-funded) Braiins balance doesn't immediately fire an ERROR
  // Telegram alert the moment the operator finishes the wizard. #116.
  wallet_runway_alert_days: 0,
  below_floor_alert_after_minutes: 10,
  zero_hashrate_loud_alert_after_minutes: 15,
  pool_outage_blip_tolerance_seconds: 120,
  datum_unreachable_alert_after_minutes: 10,
  sustained_paused_alert_after_minutes: 10,
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

  tick_metrics_retention_days: 0,
  decisions_uneventful_retention_days: 7,
  decisions_eventful_retention_days: 0,
  alerts_retention_days: 0,
  chart_max_markers: 0,

  datum_api_url: null,

  block_explorer_url_template: 'https://mempool.space/block/{hash}',
  block_explorer_tx_url_template: 'https://mempool.space/tx/{txid}',

  braiins_hashrate_smoothing_minutes: 1,
  datum_hashrate_smoothing_minutes: 1,
  braiins_price_smoothing_minutes: 1,

  show_effective_rate_on_price_chart: false,
  show_share_log_on_hashrate_chart: false,
  block_found_sound: 'off',

  telegram_chat_id: '',
  telegram_bot_token: '',
  telegram_instance_label: '',
  notifications_muted: false,
  notification_retry_interval_minutes: 30,
  notification_disabled_event_classes: [],
  notify_on_pool_block_credit: false,
  notify_on_braiins_deposit: false,
  // #226: payout lifecycle Telegram alerts - opt-in, default off.
  notify_on_payout_initiated: false,
  notify_on_payout_confirmed: false,
  notification_locale: 'en',
  // #227 follow-up: 'system' = "follow the operator's browser /
  // default", resolved daemon-side to 'en-US' since there's no
  // browser context. Operators who pick a non-system value on the
  // Display & Logging tab get the dashboard to PATCH the new value
  // and Telegram immediately renders with it.
  display_number_locale: 'system',
  display_date_layout: 'system',
  // #238: empty JSON object = "use every series's built-in default".
  chart_color_overrides: '{}',

  ddns_provider: '',
  ddns_hostname: '',
  ddns_username: '',
  ddns_credential: '',
  ddns_update_url: '',

  solo_mining_enabled: false,
  solo_overheating_threshold_celsius: 0,
  solo_zero_hashrate_alert_after_minutes: 5,
  solo_share_rejection_threshold_pct: 10,
  solo_share_rejection_window_minutes: 60,
  marketplace_empty_alert_after_minutes: 5,
  include_historical_payouts: true,
  historical_payouts_offset_sat: 0,
  debug_api_enabled: false,
};
