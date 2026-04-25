# Configuration via environment variables

The daemon resolves configuration in priority order:

1. **Environment variables** — anything matching `BHA_*` (table below).
2. **SQLite database** (`data/state.db`) — written by the dashboard's
   Config page, by `pnpm setup`, or by the future first-run wizard
   (#57).
3. **Schema defaults** — see `packages/daemon/src/config/schema.ts`.

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
field. The `BHA_` (Braiins Hashrate Autopilot) prefix avoids collision
with the unrelated `BITCOIN_RPC_*` env vars Umbrel and Start9 inject
for bitcoind discovery — that integration is a separate concern, see
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
| `BHA_HANDOVER_WINDOW_MINUTES` | `handover_window_minutes` |

## Retention

| Env var | Schema field |
|---|---|
| `BHA_TICK_METRICS_RETENTION_DAYS` | `tick_metrics_retention_days` |
| `BHA_DECISIONS_UNEVENTFUL_RETENTION_DAYS` | `decisions_uneventful_retention_days` |
| `BHA_DECISIONS_EVENTFUL_RETENTION_DAYS` | `decisions_eventful_retention_days` |

## Optional integrations

| Env var | Schema field | Notes |
|---|---|---|
| `BHA_DATUM_API_URL` | `datum_api_url` | Empty string disables. |
| `BHA_ELECTRS_HOST` | `electrs_host` | Empty string disables. |
| `BHA_ELECTRS_PORT` | `electrs_port` | Empty string disables. |
| `BHA_BITCOIND_RPC_URL` | `bitcoind_rpc_url` | Also accepted in secrets; either works. |
| `BHA_BITCOIND_RPC_USER` | `bitcoind_rpc_user` | |
| `BHA_BITCOIND_RPC_PASSWORD` | `bitcoind_rpc_password` | |

## UI / display

| Env var | Schema field | Type |
|---|---|---|
| `BHA_BLOCK_EXPLORER_URL_TEMPLATE` | `block_explorer_url_template` | string with `{hash}` or `{height}` |
| `BHA_BRAIINS_HASHRATE_SMOOTHING_MINUTES` | `braiins_hashrate_smoothing_minutes` | int ≥ 1 |
| `BHA_DATUM_HASHRATE_SMOOTHING_MINUTES` | `datum_hashrate_smoothing_minutes` | int ≥ 1 |
| `BHA_BRAIINS_PRICE_SMOOTHING_MINUTES` | `braiins_price_smoothing_minutes` | int ≥ 1 |
| `BHA_SHOW_EFFECTIVE_RATE_ON_PRICE_CHART` | `show_effective_rate_on_price_chart` | `true`/`false`/`yes`/`no`/`1`/`0`/`on`/`off` |

## Process-level env vars (not config overrides)

These are read directly by the daemon entrypoint and have no `BHA_`
prefix — they predate the override layer:

| Env var | Default | Purpose |
|---|---|---|
| `HTTP_HOST` | `0.0.0.0` | Bind address for the HTTP server. |
| `HTTP_PORT` | `3010` | Bind port. |
| `TICK_INTERVAL_MS` | `60000` | Controller tick cadence. |
| `DASHBOARD_STATIC` | `packages/dashboard/dist` | Path to built dashboard assets. |
| `SECRETS_PATH` | `<repo>/.env.sops.yaml` | Override the SOPS file location. |
| `DB_PATH` | `<repo>/data/state.db` | Override the SQLite path. |
| `SOPS_AGE_KEY_FILE` | `~/.config/braiins-hashrate/age.key` | Age private key for SOPS decrypt. |
