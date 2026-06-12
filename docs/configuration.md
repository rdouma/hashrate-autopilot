# Configuration via environment variables

The daemon resolves configuration in priority order:

1. **Environment variables** - anything matching `BHA_*` (table below).
2. **SQLite database** (`data/state.db`) - written by the dashboard's
   Config page, by `pnpm setup`, or by the future first-run wizard
   (#57).
3. **Schema defaults** - see `packages/daemon/src/config/schema.ts`.

Env-var overrides are read **once at boot** and re-validated through
the same Zod schemas the dashboard uses, so a malformed value fails
loudly on startup rather than being silently ignored.

## Why this exists

Appliance environments (Umbrel, Start9, vanilla `docker run`) inject
configuration declaratively as environment variables. The
SOPS-encrypted file + interactive `setup.ts` flow stays for power
users; this layer makes "set these env vars and start the container"
a complete path.

## Naming convention

Every env-var is `BHA_<UPPER_SNAKE_CASE>` of the underlying schema
field. The `BHA_` prefix (historical, from early Braiins-only days) avoids collision
with the unrelated `BITCOIN_RPC_*` env vars Umbrel and Start9 inject
for bitcoind discovery - that integration is a separate concern, see
issue #60.

## Secrets

| Env var | Schema field | Notes |
|---|---|---|
| `BHA_BRAIINS_OWNER_TOKEN` | `braiins_owner_token` | Required. |
| `BHA_BRAIINS_READ_ONLY_TOKEN` | `braiins_read_only_token` | Optional. |
| `BHA_DASHBOARD_PASSWORD` | `dashboard_password` | Required. Basic Auth password for the dashboard. |
| `BHA_BITCOIND_RPC_URL` | `bitcoind_rpc_url` | Optional. Editable from the Config page. |
| `BHA_BITCOIND_RPC_USER` | `bitcoind_rpc_user` | Optional. |
| `BHA_BITCOIND_RPC_PASSWORD` | `bitcoind_rpc_password` | Optional. |
| `BHA_TELEGRAM_BOT_TOKEN` | `telegram_bot_token` | Legacy; retained for compat. |
| `BHA_TELEGRAM_WEBHOOK_SECRET` | `telegram_webhook_secret` | Legacy; retained for compat. |

## Targets and pricing

| Env var | Schema field | Type |
|---|---|---|
| `BHA_TARGET_HASHRATE_PH` | `target_hashrate_ph` | float, PH/s |
| `BHA_MINIMUM_FLOOR_HASHRATE_PH` | `minimum_floor_hashrate_ph` | float, PH/s |
| `BHA_MAX_BID_SAT_PER_EH_DAY` | `max_bid_sat_per_eh_day` | int, sat/EH/day |
| `BHA_MAX_OVERPAY_VS_HASHPRICE_SAT_PER_EH_DAY` | `max_overpay_vs_hashprice_sat_per_eh_day` | int or empty (disable) |
| `BHA_OVERPAY_SAT_PER_EH_DAY` | `overpay_sat_per_eh_day` | int, sat/EH/day |
| `BHA_BID_BUDGET_SAT` | `bid_budget_sat` | int sat; `0` = use full wallet balance per CREATE |
| `BHA_BID_EDIT_DEADBAND_PCT` | `bid_edit_deadband_pct` | float (%); default 20 (legacy `overpay/5` equivalent). EDIT_PRICE noise floor: `max(tick_size, overpay × pct / 100)` (#222, migration 0099) |
| `BHA_MAX_ACCEPTABLE_FEE_PCT` | `max_acceptable_fee_pct` | float (%); default 0 (any non-zero fee halts mutations). Mutation gate denies CREATE / EDIT / EDIT_SPEED when any active bid's `fee_rate_pct` exceeds this ceiling; CANCEL remains allowed (#222, migration 0099) |

## Pool destination

| Env var | Schema field |
|---|---|
| `BHA_DESTINATION_POOL_URL` | `destination_pool_url` |
| `BHA_DESTINATION_POOL_WORKER_NAME` | `destination_pool_worker_name` |
| `BHA_BTC_PAYOUT_ADDRESS` | `btc_payout_address` |

## Boot + run mode

| Env var | Schema field | Allowed values |
|---|---|---|
| `BHA_BOOT_MODE` | `boot_mode` | `ALWAYS_DRY_RUN` (default), `LAST_MODE`, `ALWAYS_LIVE` |
| `BHA_SPENT_SCOPE` | `spent_scope` | `autopilot`, `account` (default) |
| `BHA_BTC_PRICE_SOURCE` | `btc_price_source` | `none` (default), `coingecko`, `coinbase`, `bitstamp`, `kraken` |
| `BHA_PAYOUT_SOURCE` | `payout_source` | `none` (default), `electrs`, `bitcoind` |

## Cheap-mode (opportunistic scaling)

| Env var | Schema field |
|---|---|
| `BHA_CHEAP_TARGET_HASHRATE_PH` | `cheap_target_hashrate_ph` |
| `BHA_CHEAP_THRESHOLD_PCT` | `cheap_threshold_pct` |
| `BHA_CHEAP_SUSTAINED_WINDOW_MINUTES` | `cheap_sustained_window_minutes` |

## Alert thresholds

| Env var | Schema field |
|---|---|
| `BHA_WALLET_RUNWAY_ALERT_DAYS` | `wallet_runway_alert_days` |
| `BHA_BELOW_FLOOR_ALERT_AFTER_MINUTES` | `below_floor_alert_after_minutes` |
| `BHA_ZERO_HASHRATE_LOUD_ALERT_AFTER_MINUTES` | `zero_hashrate_loud_alert_after_minutes` |
| `BHA_POOL_OUTAGE_BLIP_TOLERANCE_SECONDS` | `pool_outage_blip_tolerance_seconds` |
| `BHA_API_OUTAGE_ALERT_AFTER_MINUTES` | `api_outage_alert_after_minutes` |
| `BHA_DATUM_UNREACHABLE_ALERT_AFTER_MINUTES` | `datum_unreachable_alert_after_minutes` |
| `BHA_SUSTAINED_PAUSED_ALERT_AFTER_MINUTES` | `sustained_paused_alert_after_minutes` |
| `BHA_MARKETPLACE_EMPTY_ALERT_AFTER_MINUTES` | `marketplace_empty_alert_after_minutes` |
| `BHA_HANDOVER_WINDOW_MINUTES` | `handover_window_minutes` |

## Retention

| Env var | Schema field |
|---|---|
| `BHA_TICK_METRICS_RETENTION_DAYS` | `tick_metrics_retention_days` |
| `BHA_DECISIONS_UNEVENTFUL_RETENTION_DAYS` | `decisions_uneventful_retention_days` |
| `BHA_DECISIONS_EVENTFUL_RETENTION_DAYS` | `decisions_eventful_retention_days` |
| `BHA_ALERTS_RETENTION_DAYS` | `alerts_retention_days` |
| `BHA_CHART_MAX_MARKERS` | `chart_max_markers` |

## Optional integrations

| Env var | Schema field | Notes |
|---|---|---|
| `BHA_DATUM_API_URL` | `datum_api_url` | Empty string disables. |
| `BHA_ELECTRS_HOST` | `electrs_host` | Empty string disables. Any Electrum-protocol server works: electrs, Fulcrum, ElectrumX. |
| `BHA_ELECTRS_PORT` | `electrs_port` | Empty string disables. |
| `BHA_BITCOIND_RPC_URL` | `bitcoind_rpc_url` | Also accepted in secrets; either works. |
| `BHA_BITCOIND_RPC_USER` | `bitcoind_rpc_user` | |
| `BHA_BITCOIND_RPC_PASSWORD` | `bitcoind_rpc_password` | |

## Notifications

| Env var | Schema field | Type |
|---|---|---|
| `BHA_TELEGRAM_CHAT_ID` | `telegram_chat_id` | string |
| `BHA_TELEGRAM_INSTANCE_LABEL` | `telegram_instance_label` | string |
| `BHA_NOTIFICATIONS_MUTED` | `notifications_muted` | boolean |
| `BHA_NOTIFICATION_RETRY_INTERVAL_MINUTES` | `notification_retry_interval_minutes` | int |
| `BHA_NOTIFICATION_DISABLED_EVENT_CLASSES` | `notification_disabled_event_classes` | comma-separated list |
| `BHA_NOTIFY_ON_POOL_BLOCK_CREDIT` | `notify_on_pool_block_credit` | boolean |
| `BHA_NOTIFY_ON_BRAIINS_DEPOSIT` | `notify_on_braiins_deposit` | boolean |
| `BHA_NOTIFY_ON_PAYOUT_INITIATED` | `notify_on_payout_initiated` | boolean (#226, migration 0101) |
| `BHA_NOTIFY_ON_PAYOUT_CONFIRMED` | `notify_on_payout_confirmed` | boolean (#226, migration 0101) |
| `BHA_NOTIFICATION_LOCALE` | `notification_locale` | `en`, `nl`, `es` |

## DDNS

| Env var | Schema field |
|---|---|
| `BHA_DDNS_PROVIDER` | `ddns_provider` |
| `BHA_DDNS_HOSTNAME` | `ddns_hostname` |
| `BHA_DDNS_USERNAME` | `ddns_username` |
| `BHA_DDNS_CREDENTIAL` | `ddns_credential` |
| `BHA_DDNS_UPDATE_URL` | `ddns_update_url` |

## Solo-mining monitoring

| Env var | Schema field | Type |
|---|---|---|
| `BHA_SOLO_MINING_ENABLED` | `solo_mining_enabled` | boolean |
| `BHA_SOLO_OVERHEATING_THRESHOLD_CELSIUS` | `solo_overheating_threshold_celsius` | int (°C; 0 = auto per model) |
| `BHA_SOLO_ZERO_HASHRATE_ALERT_AFTER_MINUTES` | `solo_zero_hashrate_alert_after_minutes` | int |
| `BHA_SOLO_SHARE_REJECTION_THRESHOLD_PCT` | `solo_share_rejection_threshold_pct` | int (%) |
| `BHA_SOLO_SHARE_REJECTION_WINDOW_MINUTES` | `solo_share_rejection_window_minutes` | int |

## Payout history

| Env var | Schema field | Type |
|---|---|---|
| `BHA_INCLUDE_HISTORICAL_PAYOUTS` | `include_historical_payouts` | boolean |
| `BHA_HISTORICAL_PAYOUTS_OFFSET_SAT` | `historical_payouts_offset_sat` | int (sat) |

## UI / display

| Env var | Schema field | Type |
|---|---|---|
| `BHA_BLOCK_EXPLORER_URL_TEMPLATE` | `block_explorer_url_template` | string with `{hash}` or `{height}` |
| `BHA_BLOCK_EXPLORER_TX_URL_TEMPLATE` | `block_explorer_tx_url_template` | string with `{txid}` or `{hash}` |
| `BHA_BRAIINS_HASHRATE_SMOOTHING_MINUTES` | `braiins_hashrate_smoothing_minutes` | int ≥ 1 |
| `BHA_DATUM_HASHRATE_SMOOTHING_MINUTES` | `datum_hashrate_smoothing_minutes` | int ≥ 1 |
| `BHA_BRAIINS_PRICE_SMOOTHING_MINUTES` | `braiins_price_smoothing_minutes` | int ≥ 1 |
| `BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART` | `show_effective_rate_on_price_chart` | boolean |
| `BHA_SHOW_SHARE_LOG_ON_HASHRATE_CHART` | `show_share_log_on_hashrate_chart` | boolean |
| `BHA_BLOCK_FOUND_SOUND` | `block_found_sound` | `off`, `cartoon-cowbell`, `glass-drop-and-roll`, `metallic-clank-1`, `metallic-clank-2`, `ocean-mining-found-block`, `custom` |
| `BHA_DISPLAY_NUMBER_LOCALE` | `display_number_locale` | `system` (default), `en-US`, `nl-NL`, `fr-FR`, `no-grouping` (#227 follow-up, migration 0102) |
| `BHA_DISPLAY_DATE_LAYOUT` | `display_date_layout` | `system` (default), `us`, `eu-spaced-24h`, `slash-dmy-24h`, `iso`, `slash-mdy-12h` (#227 follow-up, migration 0102) |
| `BHA_CHART_COLOR_OVERRIDES` | `chart_color_overrides` | JSON object keyed by series/marker name with `#RRGGBB` values, default `{}`. Covers 22 named slots (11 line series + 7 marker icons + 4 bid-event glyphs); see `docs/spec.md` §8 for the full key list. (#238 + v1.12 marker keys, migration 0103) |
| `BHA_DEBUG_API_ENABLED` | `debug_api_enabled` | boolean |

## Process-level env vars (not config overrides)

These are read directly by the daemon entrypoint and have no `BHA_`
prefix - they predate the override layer:

| Env var | Default | Purpose |
|---|---|---|
| `HTTP_HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `HTTP_PORT` | `3010` | Bind port. |
| `TICK_INTERVAL_MS` | `60000` | Controller tick cadence. |
| `DASHBOARD_STATIC` | `packages/dashboard/dist` | Path to built dashboard assets. |
| `SECRETS_PATH` | `<repo>/.env.sops.yaml` | Override the SOPS file location. |
| `DB_PATH` | `<repo>/data/state.db` | Override the SQLite path. |
| `SOPS_AGE_KEY_FILE` | `~/.config/hashrate-autopilot/age.key` | Age private key for SOPS decrypt. |
