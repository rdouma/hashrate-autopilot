# Hashrate Autopilot - Architecture (v1.16)

> Concretion of `docs/spec.md` into module boundaries, data flow, deployment shape, and a
> milestone-ordered build plan.
>
> v1.0 was built around a 2FA gate on mutations that, on empirical verification, turns out not to
> apply to the owner-token API path. v1.1 removed the confirmation bot, quiet-hours buffering,
> pending-confirmation / confirmation-timeout action modes, and operator-availability flag. v1.2 added
> the simulator and the depth-aware pricing machinery. v1.3 was a spec-consistency sweep. v1.4
> (2026-04-24) aligned the architecture doc with spec v2.1: the simulator has been retired,
> `overpay_sat_per_eh_day` is back as the single pricing knob. v1.5 (2026-04-25) covered the
> appliance-packaging release. v1.6 (2026-05-02) caught up on schema additions through migration
> 0051. v1.7 (2026-05-18) was a comprehensive catch-up with spec v2.5: adds the
> Telegram notification subsystem (NotificationSink + TelegramSink + AlertEvaluator + inline-ack),
> DDNS updater, solo-mining monitoring, deposit lifecycle tracking, marketplace-empty alert, debug
> API endpoint, historical-payout backfill, six new tables (pool_blocks, bid_events, solo_miners,
> solo_miner_samples, braiins_deposits, block_version_cache), ~30 new config columns, the /alerts
> dashboard page, and corrects the retention defaults to match the running schema. v1.8
> (2026-05-21) adds migrations 0093-0094: pool luck 30d columns on tick_metrics (#201)
> and the solo_best_difficulty_events table + runtime_state high-water mark (#204). v1.9
> (2026-05-22) corrects the §5 DDL for five tables (pool_blocks, bid_events,
> braiins_deposits, solo_miners, solo_miner_samples) that had drifted from the actual migrations.
> v1.10 (2026-05-25) fixes `tick_metrics.network_difficulty` type (REAL -> INTEGER
> to match migration 0053), adds missing columns (`paid_total_sat` from 0066, `block_found_sound*`
> from 0052/0061), removes the dropped `operator_available` column from `runtime_state`, and adds
> `total_balance_sat` to `tick_metrics` (migration 0095, #211). v1.11 (2026-05-25) updated
> braiins-deposit-watcher annotation and route listing. v1.12 (2026-05-25) added the `deposits` route.
> v1.13 (2026-05-29) covers the v1.10.0 release window: migration 0099 adds
> `bid_edit_deadband_pct` and `max_acceptable_fee_pct` to the `config` table (#222); migration 0100
> adds `bid_edit_deadband_pct` to `tick_metrics` so EDIT_PRICE event tooltips can render the deadband
> in effect at any historical event (#224, default 20 backfills existing rows to the legacy `overpay/5`
> equivalent). Mutation gate gains a new `FEE_THRESHOLD_EXCEEDED` denial reason that blocks CREATE /
> EDIT / EDIT_SPEED when any active bid's `fee_rate_pct` exceeds `config.max_acceptable_fee_pct`;
> CANCEL_BID remains allowed.
> **v1.14** (2026-06-02) covers the v1.11.0 release window. Migration 0101 adds two
> notify-on-payout config toggles (`notify_on_payout_initiated`, `notify_on_payout_confirmed`) for
> Ocean payout-lifecycle Telegram alerts (#226); 0102 adds `display_number_locale` and
> `display_date_layout` config columns so Telegram render path reads operator-set formatting (#227
> follow-up); 0103 adds `chart_color_overrides` JSON to config for the Display & Logging chart-color
> picker (#238). Migration 0104 adds `tick_metrics.synthetic INTEGER NOT NULL DEFAULT 0` to mark rows
> inserted by `runGapBackfill` for offline-gap reconstruction (#241). Migration 0105 adds
> `runtime_state.last_backfilled_payout_address TEXT` so the daemon can detect operator
> address-change mid-run on boot and force a re-backfill against the live `cfg.btc_payout_address`
> (#240 follow-up). New boot-time backfill service `runGapBackfill` walks all `synthetic = 0` rows
> in the last 365 days, finds every consecutive pair where the delta exceeds 10 min, and processes
> each gap independently: clears stale synthetic rows in the gap, collects retarget metadata
> (multi-retarget walk via bitcoind when configured, single nearest-pool-block estimate as a
> fallback), then inserts a synthetic tick every 5 min across the gap plus one at each retarget
> canonical time. Skips cadence ticks colliding with a canonical retarget's 30-min bucket so the
> chart's bucket-AVG aggregation doesn't smear the marker. Downstream `runPoolLuckRecompute` was
> updated in the same release to bypass its 30d-eligibility gate for `synthetic = 1` rows so fresh
> installs with shallow pool_blocks history still get pool_luck populated on gap synthetics.
>
> **v1.15** (2026-06-04, covers the v1.12.0 release window).
> Migration 0106 (#243) adds `tick_metrics.primary_bid_shares_purchased_m / _accepted_m /
> _rejected_m` (REAL nullable) for per-tick snapshots of the primary owned bid's
> cumulative-since-bid-creation share counters from Braiins's `/spot/bid/detail.counters_committed`
> block; one extra GET per tick because the bids list response doesn't carry counters. Drives the
> dashboard's Braiins rejection-rate card row and the hashrate chart right-axis series, both
> computed server-side via `TickMetricsRepo.braiinsRejectionPctSince(since_ms, until_ms)` which
> queries raw rows for first/last cumulative values across the selected chart range. Migration 0107
> NULLs those three columns for rows older than 2026-05-08 UTC to scrub orphan data left over from
> the reverted #90 acceptance-ratio infrastructure (which had used the same column names on its
> brief life on May 5-6); no-op on clean installs. The migration runner now catches
> `duplicate column name` / `already exists` errors and stamps `_migrations` as applied, so a
> half-applied schema state self-heals on the next boot instead of crash-looping. Migration 0108
> adds `dashboard_card_order TEXT NOT NULL DEFAULT '[]'` for the dashboard drag-to-reorder feature
> (#244). The column is currently dormant: the operator chose per-device ordering, so the
> dashboard stores the chosen block order in browser localStorage and does not write the column.
> It is kept in place (cheaper than reverting an already-shipped migration, and avoids schema
> divergence) with the plumbing ready should cross-device sync be wanted later. Migration 0109 adds
> the `ip_change_events` table (#250): an append-only log of public-IP rotations written from the
> `PublicIpService.onIpChange` hook (60 s poll cadence, dropped from 5 min in this release),
> surfaced as an "IP last changed" line in the DDNS card and router-icon markers on the hashrate
> chart, so the operator can line a public-IP rotation up against a rejection-rate spike. The same
> release renames every user-facing "Solo miners" string to "Bitaxe miners" (the integration only
> ever supported AxeOS firmware); internal table/field names retain the `solo_*` prefix.
> Migration 0110 adds `config.dashboard_tiles` (#266, configurable StatsBar tiles - JSON id array,
> `'[]'` = default set). Migration 0111 rebuilds `bid_events` to widen the `kind` CHECK with three
> lifecycle kinds (#287): `MODE_CHANGE` (operator/boot run-mode switches), `BID_PAUSED` and
> `BID_RESUMED` (Braiins-side bid status flips observed per tick, with Braiins'
> `last_pause_reason` in `reason`). The three are excluded from the Stats page `mutation_count`
> and never inherit a bid id from the orphan-CREATE coalesce; they render as Timeline rows,
> always-visible price-chart markers, and feed the idle-state background bands on both charts
> (run-mode bands from per-tick `tick_metrics.run_mode`, now exposed raw + worst-in-bucket via
> `/api/metrics`; bid-pause bands from BID_PAUSED→BID_RESUMED event pairs).
> Chart bucket scaling was rewritten from a 4-tier ladder to a continuous formula
> (`bucketMs = ceil(spanMs / 1440)` clamped to the 60 s tick floor) to remove the 30× cliff when a
> chart viewport span crossed 24 h. Five new `chart_color_overrides` keys cover BIP-110-signalling,
> retarget, IP-change, on-chain payout, and Braiins deposit markers; the parser carries a one-key
> alias (`price.unpaid → price.marker_deposit`) so saved overrides under the old name transparently
> migrate.
> Migration 0112 adds `tick_metrics.max_overpay_vs_hashprice_sat_per_eh_day` (#312), snapshotting
> the dynamic-cap premium in effect at each tick so the price chart's effective-cap line is drawn
> from per-tick history instead of re-applying the current config value backwards across all of it.
> Migration 0113 (#312 follow-up) backfills the leading block of pre-0112 NULL rows - which still
> fell back to live config - with the earliest premium ever recorded (the value in effect when
> per-tick recording began), carried backward; no-op when the dynamic cap was never enabled.
> Migration 0114 (#318) adds `system_events` (config changes + daemon boots) for the unified
> Timeline log: `config_change` rows (one per changed field, written by the config-save route via
> `SystemEventsRepo`) and `daemon_started` rows (written on boot). Served by `GET /api/system-events`;
> `GET /api/retargets` (#317) derives difficulty retargets from `tick_metrics.network_difficulty`.

## 1. High-level shape

Two long-running processes on the always-on box, composed in a single Node daemon:

```
┌────────────────────────────────────────────────────────────┐
│                  Always-on LAN box                         │
│                                                            │
│          ┌─────────────┐    ┌──────────────┐               │
│          │   daemon    │◄───┤  dashboard   │               │
│          │  (control)  │    │   (React)    │               │
│          └──────┬──────┘    └──────┬───────┘               │
│                 │                  │                       │
│                 └────────┬─────────┘                       │
│                          │                                 │
│                   ┌──────▼──────┐                          │
│                   │   SQLite    │  (single file, WAL mode) │
│                   │   state.db  │                          │
│                   └─────────────┘                          │
└──────────┬───────────────────────────────────┬─────────────┘
           │                                   │
   ┌───────┴────────┐              ┌───────────┴───────────┐
   │                │              │                       │
   ▼                ▼              ▼                       ▼
Braiins API   Datum Gateway   bitcoind RPC       Electrs
(internet)    (LAN, :23334    (LAN, optional)    (LAN, optional)
               + :7152 rec.)
```

The **daemon** is the control loop and the only writer to SQLite. The **dashboard** is a read-mostly React SPA backed
by a thin HTTP API the daemon exposes (same Node process). The operator interacts through the dashboard and - since
v1.5 (#100) - via **Telegram notifications**. The notification subsystem is built around a `NotificationSink`
interface (currently only `TelegramSink`; future Nostr / ntfy / email backends can slot in). An `AlertEvaluator`
detects state transitions each tick, the `AlertManager` writes rows to the `alerts` table with a retry ladder, and
a `TelegramReceiver` long-polls `getUpdates` to process inline-keyboard acknowledgements from the operator's phone.
Alerts and their delivery state are also surfaced on a dedicated `/alerts` dashboard page. **#316:** alert openers that arrive as open/recovery pairs (`hashrate_below_floor`, `zero_hashrate`, `datum_unreachable`, `api_unreachable`, `wallet_runway`, `solo_overheating`) are also exposed as timeline spans via `GET /api/alert-spans` (`AlertsRepo.conditionSpansSince`): each opener is matched to its recovery via the recovery row's `paired_alert_id` (the span carries the recovery alert's body as `recovery_body`, #322 - null for implicit closes - so the Timeline can render recoveries as their own rows), and an orphan opener with no recovery is bounded - closed at the next same-class opener, kept open-ended only if it started within 6 h of now, else capped at start + 6 h - so a stale alert can't render as an infinite band. The shared `CONDITION_SPAN_CLASSES` taxonomy (in `packages/shared`) names each class, its chart target(s), and its color slot. These spans feed both the chart background bands and the Timeline-feed alert rows.

## 2. Repository layout

TypeScript monorepo via **pnpm workspaces**.

```
hashrate-autopilot/
├── package.json                    (root, pnpm workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.sops.yaml                  (encrypted secrets)
├── docs/
│   ├── spec.md
│   ├── architecture.md
│   ├── research.md
│   └── permissions-log.md
│
├── packages/
│   ├── shared/                     types, enums, pure utils shared daemon↔dashboard
│   │   ├── src/types.ts
│   │   ├── src/units.ts            (sat/EH/day conversions etc.)
│   │   └── src/decision.ts         (canMutate gate, pure function)
│   │
│   ├── braiins-client/             Braiins Hashpower API client (generated types + thin wrapper)
│   │   ├── src/generated/          (openapi-typescript output)
│   │   ├── src/client.ts           (incl. DELETE-with-body implementation)
│   │   ├── src/auth.ts             (owner vs read-only token selector)
│   │   └── src/errors.ts           (grpc-message header decoding)
│   │
│   ├── bitcoind-client/            minimal JSON-RPC wrapper for payout observation
│   │   └── src/client.ts
│   │
│   ├── daemon/                     control loop + HTTP API + persistence
│   │   ├── src/index.ts            (entry point)
│   │   ├── src/main.ts             (graceful shutdown wiring)
│   │   ├── src/config/             (sops decrypt + Zod schema)
│   │   ├── src/state/
│   │   │   ├── db.ts               (better-sqlite3 + migrations)
│   │   │   ├── migrations/
│   │   │   ├── repos/              (config, secrets, decisions, owned_bids, runtime_state, tick_metrics + braiinsRejectionPctSince, bid_events, ip_change_events, reward_events, ocean_payouts, braiins_deposits, solo_miners, pool_blocks, closed_bids_cache, alerts, system_events)
│   │   │   └── stale-bid-prune.ts  (#295 - marks active ledger bids absent from a confirmed-successful Braiins list as cancelled)
│   │   ├── src/services/
│   │   │   ├── braiins-service.ts
│   │   │   ├── payout-observer.ts  (Electrs-preferred; bitcoind fallback; on-chain corroboration only since #323)
│   │   │   ├── ocean-payouts-service.ts (#323 - syncs Ocean earnpay payouts into ocean_payouts; source of truth for P&L collected)
│   │   │   ├── deduced-payouts.ts  (#343 - deduces Lightning payouts, which earnpay omits, from confirmed unpaid-series drops; runs after each successful earnpay sync)
│   │   │   ├── pool-health.ts      (TCP probe of Datum Gateway :23334)
│   │   │   ├── ocean.ts            (Ocean pool REST client: stats, blocks, earnings; chain-gated on ocean_chain=bip110, #363)
│   │   │   ├── datum.ts            (optional /umbrel-api poller - gateway-measured hashrate + workers)
│   │   │   ├── hashprice-cache.ts  (in-memory hashprice cache, fed from Ocean)
│   │   │   ├── hashprice-refresher.ts (#33 - in-daemon 10-min Ocean hashprice poll; the cache no longer depends on dashboard traffic)
│   │   │   ├── pool-luck.ts        (per-tick pool-luck computation - 24h/7d/30d gap-based luck)
│   │   │   ├── btc-price.ts        (BTC/USD oracle - CoinGecko / Coinbase / Bitstamp / Kraken)
│   │   │   ├── btc-price-refresher.ts (in-daemon 4-min oracle poll so tick_metrics.btc_usd_price stays live with the dashboard closed)
│   │   │   ├── account-spend.ts    (whole-account spend ledger from /v1/account/transaction)
│   │   │   ├── notifier.ts         (#100 - NotificationSink interface + TelegramSink)
│   │   │   ├── alert-manager.ts    (#100 - alerts table writer; retry ladder; recovery pairing)
│   │   │   ├── alert-evaluator.ts  (#100 - per-tick state-diff that detects transitions)
│   │   │   ├── braiins-deposit-watcher.ts (#143/#210 - on-chain endpoint poller; all three deposit events)
│   │   │   ├── axeos.ts            (#149 - AxeOS REST client types + per-device fetch)
│   │   │   ├── axeos-poller.ts     (#149 - per-tick fleet poll; Promise.allSettled; 2 s per-device timeout)
│   │   │   ├── axeos-scanner.ts    (#149 / #156 - /24 subnet sweep with operator-supplied CIDR override for docker / Umbrel installs)
│   │   │   ├── public-ip.ts        (#250 - polls api.ipify.org every 60 s; emits onIpChange to DDNS updater + writes ip_change_events row)
│   │   │   ├── ddns-updater.ts     (#221 - No-IP / DuckDNS / dyndns2 push; hourly heartbeat + immediate on IP change)
│   │   │   ├── telegram-receiver.ts (#109 - long-poll getUpdates; inline-keyboard ack buttons)
│   │   │   ├── solo-hashing.ts     (#291 - halted-Bitaxe detection heuristic: flag + GH/s-per-watt plausibility)
│   │   │   ├── block-version.ts    (block-header version lookups backing the BIP-110 markers; block_version_cache)
│   │   │   ├── electrs-client.ts   (Electrum-protocol TCP client for the payout observer)
│   │   │   ├── gap-backfill.ts     (boot-time tick_metrics gap fill - see §3 boot sequence)
│   │   │   ├── pool-luck-recompute.ts (boot-time luck recompute after gap fill)
│   │   │   ├── pool-blocks-backfill.ts (#108 - boot-time Ocean /v1/blocks history backfill)
│   │   │   ├── network-difficulty-backfill.ts (#230 - boot-time difficulty backfill from bitcoind)
│   │   │   ├── ocean-unpaid-cleanup.ts (one-shot scrub of bogus reconstructed ocean_unpaid_sat rows)
│   │   │   └── retention.ts        (hourly pruner for tick_metrics + decisions + alerts)
│   │   ├── src/controller/
│   │   │   ├── loop.ts             (tick driver)
│   │   │   ├── tick.ts
│   │   │   ├── observe.ts
│   │   │   ├── decide.ts           (pure; emits Proposal[] given State)
│   │   │   ├── gate.ts             (applies §7.2 mutation-gate rule + cooldowns)
│   │   │   └── execute.ts          (calls Braiins API with dry-run/live split)
│   │   └── src/http/               (Fastify; dashboard API)
│   │       ├── server.ts
│   │       └── routes/             (status, config, security [#332 - /api/security/state,
│   │                                /api/security/password, /api/security/braiins-token],
│   │                                decisions, actions, metrics [+ /api/retargets +
│   │                                /api/system-events], run-mode, finance, stats, storage-estimate,
│   │                                bid-events [+ /api/bid-history, /api/bid-history/:order_id/events,
│   │                                /api/bid-history-events - the #256 v2 flat Timeline feed], ocean,
│   │                                payouts, btc-price, bip110-scan, bitcoind-test, electrs-test,
│   │                                block-found-sound, build, reward-events, payout-ledger, deposits, ip-changes,
│   │                                alerts [+ /api/alert-spans], notifications-test,
│   │                                notifications-test-event, ddns, ddns-test, datum-test, pool-url-test,
│   │                                stale-urls, solo-miners, debug-dump, diagnostics [#272 support bundle])
│   │
│   └── dashboard/                  React SPA
│       ├── src/main.tsx
│       ├── src/pages/              (Status, Config, Alerts, Setup, Login)
│       ├── src/components/
│       ├── src/lib/                (api, auth, format, labels, locale)
│       └── vite.config.ts
│
└── scripts/                        operator-facing helpers
    ├── setup.ts                    (power-user CLI setup with sops; the dashboard's
    │                                first-run wizard is the appliance-friendly path)
    ├── smoke-braiins.ts
    ├── regen-openapi-types.sh
    ├── sops-edit.sh
    └── start.sh / stop.sh / restart.sh / status.sh / logs.sh
```

Rationale for the split:

- `shared` is the contract layer - any type or conversion used on both sides lives here.
- `braiins-client` and `bitcoind-client` are separable packages because they could be reused by future projects (or
  replaced with test doubles during dry-run).
- `daemon` owns SQLite writes exclusively.
- `dashboard` never speaks to Braiins directly; always through the daemon. Secrets stay on the backend.

## 3. Daemon process model

Single Node process. Inside it, two runtime concerns share the event loop:

1. **Control loop** - a `setInterval`-driven tick (default 60s). On each tick: observe, decide, gate, execute.
2. **HTTP server** - Fastify serving the dashboard API.

Sharing a process (rather than splitting into two services) keeps the SQLite write-path single-threaded and avoids
inter-process coordination headaches.

### 3.1 Tick shape

```
async function tick() {
  const state = await observe();       // read-only; API + RPC + DB
  const proposed = decide(state);      // pure function; emits Proposal[]
  const gated = gate(proposed, state); // applies §7.2 rule + price-decrease cooldown
  const executed = await execute(gated); // real mutations in LIVE; no-op in DRY_RUN
  await persistTick(state, proposed, gated, executed);
}
```

`decide()` and `gate()` are pure and individually unit-testable. `observe()` and `execute()` hold all the side
effects. This separation makes DRY-RUN trivial: in DRY-RUN, `execute()` is a no-op that records what it would have
done.

### 3.2 State inputs the tick consumes

- `MarketSettings`, `FeeSchedule` (cached, refreshed every N ticks): tick size, cooldowns, limits, fees.
- `/v1/spot/stats` + `/v1/spot/orderbook` - current market.
- `/v1/spot/bid/current` + per-bid `/v1/spot/bid/detail/{id}` - our active bids.
- `/v1/account/balance` - wallet (and reward income via Electrs/bitcoind separately).
- Pool reachability (TCP connect to Datum Gateway:23334).
- Payout observer: recent on-chain payout transactions to the BTC payout address since the last check (Ocean settles via batched sweep transactions, not coinbase-direct).
- Local DB: ownership ledger, config, last-decrease timestamps, run mode, manual-override windows.

### 3.3 Config reload without restart

Two tiers of config:

- **Secrets** (tokens, RPC creds, dashboard password): loaded once at startup from one of three sources, in
  priority order: `BHA_*` environment variables > `.env.sops.yaml` (sops-decrypted) > the `secrets` table in
  `state.db` (populated by the first-run web onboarding wizard). Restart required to change.
- **Live tunables** (§8 of SPEC): stored in SQLite. The HTTP API writes them; the control loop reads the current row
  at the start of every tick. No watcher / pub-sub - cheap enough to re-read each tick.

## 4. Dashboard architecture

- **Framework**: React 18 + Vite. Served as static files from Fastify in production, or a Vite dev server against the
  daemon API in development.
- **State management**: TanStack Query for server state; Zustand for transient UI state.
- **Routing**: `react-router`. Pages: `/status`, `/config`, `/alerts`, `/setup`, `/login`. Per-decision inspection is on the Status page: clicking a marker on the price chart pins its tooltip and exposes a "copy JSON" button that copies the underlying bid event. The `/alerts` page is a chronological audit trail of every notification the daemon evaluated (see spec.md 12.3).
- **Auth**: single shared password, checked by Fastify middleware; session cookie. Tailscale/VPN is the real
  perimeter; the password is a second factor against someone on the LAN.
- **CORS: same-origin only (#358).** The `Origin` header is reflected back only when its host matches the `Host`
  the request arrived on; any other origin gets no CORS headers, and requests carrying no `Origin` (curl, scripts,
  monitoring) are untouched, since CORS is enforced by browsers and never gated them. Matching on `Host` rather
  than a fixed allowlist is deliberate: operators reach the dashboard on a LAN IP, a `.local` name, a dynamic-DNS
  hostname, a VPN address or through a reverse proxy, and in every one of those cases the page and the API share
  an origin, so a static list would break real setups. Nothing legitimate is cross-origin - in production Fastify
  serves the dashboard and the API from one origin, and in development the Vite config proxies `/api` server-side
  (`changeOrigin`), so the browser only ever talks to Vite. The previous `origin: true` reflected ANY origin and,
  paired with `credentials: true`, told browsers that any website could make credentialed calls and read the
  replies; because browsers attach cached HTTP-auth credentials to cross-origin fetches, a page in another tab
  could drive authenticated endpoints while an operator had a live session. The policy is exported as
  `sameOriginCorsDelegator` from `http/server.ts` so its tests exercise the registered code rather than a copy.
  The NEEDS_SETUP server registers the same policy.
- **Auth decision follows the matched route (GHSA-35jm-xg76-3hh4).** The auth and rate-limit `onRequest` hooks
  decide on `req.routeOptions.url` (the route pattern the router matched, after percent-decoding), not on the raw
  `req.url`, so an encoded target like `/%61pi/config` cannot reach an `/api/*` handler without the password. Only
  a matched `/api/health` is public. See `requiresDashboardAuth` / `isApiRequest` in `http/server.ts`.
- **Write-only credentials stay pinned to their address.** `GET /api/config` and the setup server's
  `/api/setup-info` blank `bitcoind_rpc_password`, `ddns_credential` and `telegram_bot_token`; a blank value on save
  keeps the stored one. A save that changes where a credential is sent (`bitcoind_rpc_url`; `ddns_provider` /
  `ddns_update_url`) while leaving it blank is refused, so a stored secret can never be redirected to a new host.
- **Live updates**: polling via TanStack Query (`refetchInterval` ~5s on status screens). No WebSocket/SSE in v1.

## 5. Data model (SQLite, better-sqlite3)

Core tables, WAL-mode, single file at `data/state.db`. Migration scripts live in
`packages/daemon/src/state/migrations/`.

```sql
-- Live-editable configuration (single-row pattern)
-- Reflects the current schema after all migrations through 0117.
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Hashrate targets
  target_hashrate_ph REAL NOT NULL,
  minimum_floor_hashrate_ph REAL NOT NULL,
  destination_pool_url TEXT NOT NULL,
  destination_pool_worker_name TEXT NOT NULL,  -- must be <btc-addr>.<label>
  -- Pricing (pay-your-bid fillable-tracking - bid = min(fillable_ask + overpay, effective_cap))
  max_bid_sat_per_eh_day INTEGER NOT NULL,
  max_overpay_vs_hashprice_sat_per_eh_day INTEGER,  -- dynamic cap; null = disabled
  overpay_sat_per_eh_day INTEGER NOT NULL,          -- premium above fillable_ask (#53)
  -- Fee protection (#222, migration 0099)
  bid_edit_deadband_pct REAL NOT NULL DEFAULT 20,   -- EDIT_PRICE deadband as % of overpay (legacy /5 = 20%)
  max_acceptable_fee_pct REAL NOT NULL DEFAULT 0,   -- 0 = halt on any non-zero fee_rate_pct on an active bid
  -- Budget
  bid_budget_sat INTEGER NOT NULL,                   -- 0 = use full wallet balance
  wallet_runway_alert_days INTEGER NOT NULL,
  -- Outage tolerance
  below_floor_alert_after_minutes INTEGER NOT NULL,
  zero_hashrate_loud_alert_after_minutes INTEGER NOT NULL,
  pool_outage_blip_tolerance_seconds INTEGER NOT NULL,
  api_outage_alert_after_minutes INTEGER NOT NULL,
  -- Manual override
  -- handover_window_minutes dropped by 0115 (retired §7.3 manual-override system)
  -- Cheap-mode opportunistic scaling
  cheap_target_hashrate_ph REAL NOT NULL DEFAULT 0,
  cheap_threshold_pct INTEGER NOT NULL DEFAULT 0,
  cheap_sustained_window_minutes INTEGER NOT NULL DEFAULT 0,
  -- Daemon startup
  boot_mode TEXT NOT NULL DEFAULT 'ALWAYS_DRY_RUN',
  -- Integrations
  btc_payout_address TEXT NOT NULL,
  electrs_host TEXT,
  electrs_port INTEGER,
  bitcoind_rpc_url TEXT,
  bitcoind_rpc_user TEXT,
  bitcoind_rpc_password TEXT,
  payout_source TEXT NOT NULL DEFAULT 'none',       -- 'none' | 'electrs' | 'bitcoind'
  btc_price_source TEXT NOT NULL DEFAULT 'coingecko', -- 'none' | 'coingecko' | 'coinbase' | 'bitstamp' | 'kraken' (#77, migration 0050)
  datum_api_url TEXT,                               -- optional Datum Gateway /umbrel-api URL
  -- Outage tolerance (split thresholds, migration 0082)
  datum_unreachable_alert_after_minutes INTEGER NOT NULL DEFAULT 10,
  sustained_paused_alert_after_minutes INTEGER NOT NULL DEFAULT 10,
  marketplace_empty_alert_after_minutes INTEGER NOT NULL DEFAULT 5,   -- #167, migration 0088
  -- Telegram notifications (#100, migrations 0063/0070/0064/0073/0076/0081)
  telegram_bot_token TEXT NOT NULL DEFAULT '',
  telegram_chat_id TEXT NOT NULL DEFAULT '',
  telegram_instance_label TEXT NOT NULL DEFAULT '',
  notifications_muted INTEGER NOT NULL DEFAULT 0,                    -- bool (0 | 1)
  notification_retry_interval_minutes INTEGER NOT NULL DEFAULT 30,
  notification_disabled_event_classes TEXT NOT NULL DEFAULT '',       -- comma-separated
  notify_on_pool_block_credit INTEGER NOT NULL DEFAULT 0,            -- bool (0 | 1)
  notify_on_braiins_deposit INTEGER NOT NULL DEFAULT 0,              -- bool (0 | 1)
  -- #226 (migration 0101): payout lifecycle Telegram alerts.
  notify_on_payout_initiated INTEGER NOT NULL DEFAULT 0,             -- bool (0 | 1)
  notify_on_payout_confirmed INTEGER NOT NULL DEFAULT 0,             -- bool (0 | 1)
  notification_locale TEXT NOT NULL DEFAULT 'en',                    -- 'en' | 'nl' | 'es'
  -- Display & Logging preferences promoted from browser-only localStorage
  -- so the Telegram render path can read them (#227 follow-up, migration 0102).
  display_number_locale TEXT NOT NULL DEFAULT 'system',              -- 'system' | 'en-US' | 'nl-NL' | 'fr-FR' | 'no-grouping'
  display_date_layout TEXT NOT NULL DEFAULT 'system',                -- 'system' | 'us' | 'eu-spaced-24h' | 'slash-dmy-24h' | 'iso' | 'slash-mdy-12h'
  -- Per-series chart color overrides (#238, migration 0103). JSON object
  -- keyed by canonical series name with `#RRGGBB` values. Missing keys
  -- fall back to the documented defaults in lib/chartColors.ts on the
  -- dashboard side; `'{}'` preserves the current look. Malformed JSON,
  -- unknown keys, non-string values, and non-hex strings are silently
  -- dropped at parse time on the dashboard.
  chart_color_overrides TEXT NOT NULL DEFAULT '{}',
  -- Dashboard block display order (#244, migration 0108). RESERVED /
  -- dormant: the operator chose per-device ordering, so the dashboard
  -- persists the drag-chosen order in browser localStorage and does not
  -- write this column (it stays at `'[]'`). Kept in place for forward
  -- compatibility / optional cross-device sync later.
  dashboard_card_order TEXT NOT NULL DEFAULT '[]',
  -- Configurable StatsBar tiles (#266, migration 0110). JSON array of
  -- catalogue ids; '[]' means "use the default set". Unknown ids are
  -- dropped at parse time on the dashboard so stale blobs degrade
  -- cleanly.
  dashboard_tiles TEXT NOT NULL DEFAULT '[]',
  -- Dynamic DNS (#111, migrations 0067-0068)
  ddns_provider TEXT NOT NULL DEFAULT '',                            -- '' | 'noip' | 'duckdns' | 'dyndns2'
  ddns_hostname TEXT NOT NULL DEFAULT '',
  ddns_username TEXT NOT NULL DEFAULT '',
  ddns_credential TEXT NOT NULL DEFAULT '',
  ddns_update_url TEXT NOT NULL DEFAULT '',                          -- dyndns2-generic only
  -- Chart smoothing (display-only, not read by control loop)
  braiins_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  datum_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  braiins_price_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  show_effective_rate_on_price_chart INTEGER NOT NULL DEFAULT 0,     -- bool (0 | 1)
  show_share_log_on_hashrate_chart INTEGER NOT NULL DEFAULT 0,       -- bool (0 | 1); migration 0049
  chart_max_markers INTEGER NOT NULL DEFAULT 0,                      -- 0 = no cap; migration 0078
  -- Retention
  tick_metrics_retention_days INTEGER NOT NULL DEFAULT 0,             -- 0 = forever
  decisions_uneventful_retention_days INTEGER NOT NULL DEFAULT 7,
  decisions_eventful_retention_days INTEGER NOT NULL DEFAULT 0,       -- 0 = forever
  alerts_retention_days INTEGER NOT NULL DEFAULT 0,                   -- 0 = forever; migration 0076
  -- Accounting
  spent_scope TEXT NOT NULL DEFAULT 'account',                       -- 'autopilot' | 'account'
  -- Block explorer
  block_explorer_url_template TEXT NOT NULL DEFAULT 'https://mempool.space/block/{hash}',
  block_explorer_tx_url_template TEXT NOT NULL DEFAULT 'https://mempool.space/tx/{txid}', -- migration 0071
  -- Payout features (#170, migrations 0089-0090)
  include_historical_payouts INTEGER NOT NULL DEFAULT 1,             -- bool (0 | 1)
  historical_payouts_offset_sat INTEGER NOT NULL DEFAULT 0,
  -- Solo-mining monitoring (#149, migration 0085)
  solo_mining_enabled INTEGER NOT NULL DEFAULT 0,                    -- bool (0 | 1)
  solo_overheating_threshold_celsius INTEGER NOT NULL DEFAULT 0,     -- 0 = 75 C (firmware default)
  solo_zero_hashrate_alert_after_minutes INTEGER NOT NULL DEFAULT 5,
  solo_share_rejection_threshold_pct INTEGER NOT NULL DEFAULT 10,
  solo_share_rejection_window_minutes INTEGER NOT NULL DEFAULT 60,
  -- Block-found sound (#88, migrations 0052/0061)
  block_found_sound TEXT NOT NULL DEFAULT 'off',                     -- 'off' | bundled name | 'custom'
  block_found_sound_custom_blob BLOB,                                -- operator-uploaded MP3, <=200 KB
  block_found_sound_custom_mime TEXT,
  block_found_sound_custom_filename TEXT,                             -- migration 0061
  -- Debug API (#179, migration 0092)
  debug_api_enabled INTEGER NOT NULL DEFAULT 0,                      -- bool (0 | 1)
  -- Legacy columns still in the table (kept for NOT NULL + historical
  -- schema continuity) but no longer read or written by the app.
  hibernate_on_expensive_market INTEGER NOT NULL DEFAULT 0,
  --
  updated_at INTEGER NOT NULL
);

-- Persistent runtime state (single-row pattern)
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_mode TEXT NOT NULL,                 -- 'DRY_RUN' | 'LIVE' | 'PAUSED'
  action_mode TEXT NOT NULL,              -- Legacy v1.0 state - always 'NORMAL' in v2.x
  -- operator_available dropped in migration 0083 (#148)
  last_tick_at INTEGER,
  last_api_ok_at INTEGER,
  last_rpc_ok_at INTEGER,                 -- last successful bitcoind RPC call
  last_pool_ok_at INTEGER,                -- last successful Datum Gateway TCP probe
  below_floor_since_ms INTEGER,           -- alert timer start (debounced by FLOOR_DEBOUNCE_TICKS)
  above_floor_ticks INTEGER NOT NULL,     -- debounce counter for below_floor_since_ms
  lower_ready_since_ms INTEGER,           -- DEPRECATED (v2.0 retired lowering-patience)
  below_target_since_ms INTEGER,          -- DEPRECATED (v2.0 retired above_market escalation)
  solo_best_difficulty_all_time REAL,     -- fleet-wide all-time best share difficulty (migration 0094, #204)
  last_backfilled_payout_address TEXT     -- migration 0105 (#240 follow-up): address that was last
                                          -- historical-backfilled into reward_events. On boot, mismatch
                                          -- vs cfg.btc_payout_address triggers DELETE FROM reward_events
                                          -- + runHistoricalBackfill so a mid-run address change wiped
                                          -- on a pre-build-564 daemon's stale closure can self-heal.
);
-- Note: run_mode is set on startup from config.boot_mode:
--   ALWAYS_DRY_RUN (default) → always boots in DRY_RUN (safest)
--   LAST_MODE                → keeps whatever mode was active pre-restart; PAUSED → DRY_RUN
--   ALWAYS_LIVE              → boots directly into LIVE (for trusted redeployments)

-- Ownership ledger - which Braiins order IDs we created
CREATE TABLE owned_bids (
  braiins_order_id TEXT PRIMARY KEY,
  cl_order_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  first_seen_active_at INTEGER,
  last_known_status TEXT,
  price_sat INTEGER,
  amount_sat INTEGER,
  speed_limit_ph REAL,
  last_price_decrease_at INTEGER,
  abandoned INTEGER NOT NULL DEFAULT 0,
  amount_consumed_sat INTEGER NOT NULL DEFAULT 0, -- migration 0017: lifetime consumed budget per bid (feeds finance spent)
  dest_url TEXT                            -- migration 0069 (#113): the dest_upstream.url the bid was created with, for stale-URL detection
);

-- Decision log (every tick produces a row)
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL,
  observed_json TEXT NOT NULL,
  proposed_json TEXT NOT NULL,
  gated_json TEXT NOT NULL,
  executed_json TEXT NOT NULL,
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL
);

-- Tick metrics (time-series for the hashrate + price charts)
CREATE TABLE tick_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL,
  delivered_ph REAL NOT NULL,             -- Braiins-reported avg_speed_ph (lagged rolling average)
  target_ph REAL NOT NULL,
  floor_ph REAL NOT NULL,
  owned_bid_count INTEGER NOT NULL,
  unknown_bid_count INTEGER NOT NULL,
  our_primary_price_sat_per_eh_day INTEGER,
  best_bid_sat_per_eh_day INTEGER,
  best_ask_sat_per_eh_day INTEGER,        -- cheapest single ask (cheap-mode reference)
  fillable_ask_sat_per_eh_day INTEGER,    -- depth-aware ask at target (controller anchor)
  hashprice_sat_per_eh_day INTEGER,       -- Ocean break-even hashprice
  max_bid_sat_per_eh_day INTEGER,         -- snapshot of config cap used this tick
  max_overpay_vs_hashprice_sat_per_eh_day INTEGER, -- snapshot of dynamic-cap premium this tick (migration 0112, #312); null = disabled
  available_balance_sat INTEGER,
  total_balance_sat INTEGER,              -- available + blocked; migration 0095; null pre-0095
  datum_hashrate_ph REAL,                 -- gateway-measured hashrate (null if not configured)
  ocean_hashrate_ph REAL,                 -- Ocean's credited 5-min hashrate for our payout address
  share_log_pct REAL,                     -- our slice of Ocean's TIDES window (e.g. 0.0182 for 0.0182%);
                                          -- migration 0048; null pre-0048 / when Ocean off
  spend_sat REAL,                         -- LEGACY column (bid × delivered model); no longer written
  primary_bid_consumed_sat INTEGER,       -- per-tick snapshot of the primary bid's consumed counter;
                                          -- deltas are the authoritative actual spend series that
                                          -- drives the per-day P&L panel, the effective-rate line,
                                          -- the UPTIME stat, and counter-derived delivered hashrate
  -- #89 (migrations 0053-0054): extended capture from already-polled sources
  network_difficulty INTEGER,              -- Ocean /pool_stat
  estimated_block_reward_sat INTEGER,     -- subsidy + fees, sat
  pool_hashrate_ph INTEGER,               -- Ocean total pool hashrate, PH/s (INTEGER in 0053; SQLite affinity makes this cosmetic)
  pool_active_workers INTEGER,            -- Ocean active worker count
  braiins_total_deposited_sat INTEGER,    -- Braiins lifetime deposits; spike marks a top-up
  braiins_total_spent_sat INTEGER,        -- Braiins lifetime settled spend
  ocean_unpaid_sat INTEGER,               -- Ocean unpaid earnings; sharp drop = TIDES payout
  btc_usd_price REAL,                     -- BTC/USD oracle reading at tick (sats/USD denom toggle)
  btc_usd_price_source TEXT,              -- which oracle ('coingecko' / 'coinbase' / 'bitstamp' / 'kraken')
  primary_bid_last_pause_reason TEXT,     -- Braiins last_pause_reason on the primary bid
  primary_bid_fee_paid_sat INTEGER,       -- primary bid cumulative fees paid
  primary_bid_fee_rate_pct REAL,          -- primary bid fee rate at creation
  -- #224 (migration 0100): snapshot of config.bid_edit_deadband_pct so EDIT_PRICE event tooltips
  -- can render the deadband that was in effect at any historical edit. DEFAULT 20 backfills
  -- existing rows to the legacy `overpay / 5` equivalent.
  bid_edit_deadband_pct REAL NOT NULL DEFAULT 20,
  -- #92 (migrations 0055-0057): pool-block / pool-luck plot
  -- #243 (migration 0106): per-tick snapshot of the primary owned
  -- bid's cumulative-since-bid-creation share counters from Braiins
  -- /spot/bid/detail.counters_committed. The bids list response
  -- doesn't include counters, hence one extra GET per tick.
  primary_bid_shares_purchased_m REAL,    -- cumulative shares purchased
  primary_bid_shares_accepted_m REAL,     -- cumulative shares accepted by target
  primary_bid_shares_rejected_m REAL,     -- cumulative shares rejected by target
  pool_blocks_24h_count INTEGER,          -- pool blocks observed in last 24h
  pool_blocks_7d_count INTEGER,           -- pool blocks observed in last 7d
  pool_hashrate_ph_avg_24h REAL,          -- trailing 24h mean of pool_hashrate_ph (luck denominator)
  pool_hashrate_ph_avg_7d REAL,           -- trailing 7d mean
  pool_luck_24h REAL,                     -- gap-based per-tick luck = (600 / pool_share) / elapsed
  pool_luck_7d REAL,
  pool_luck_30d REAL,                     -- 30d trailing luck (migration 0093, #201)
  pool_blocks_30d_count INTEGER,          -- pool blocks observed in last 30d
  pool_hashrate_ph_avg_30d REAL,          -- trailing 30d mean of pool_hashrate_ph
  paid_total_sat INTEGER,                 -- cumulative on-chain payouts to payout address (migration 0066, #102)
  braiins_reachable INTEGER,              -- 1 = API reachable this tick, 0 = unreachable; NULL pre-0091
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL,
  -- #241 (migration 0104): marks rows inserted by runGapBackfill to reconstruct
  -- offline-period state. 0 = real polled row, 1 = synthetic gap-fill row.
  -- Gap-detection queries filter `synthetic = 0` so a previous run's synthetic
  -- can't poison the boundary lookup. runPoolLuckRecompute's 30d-eligibility
  -- gate is bypassed for synthetic=1 rows so fresh installs (shallow pool_blocks
  -- history) still get pool_luck populated on gap synthetics.
  synthetic INTEGER NOT NULL DEFAULT 0
);

-- Accounting - spend (sourced from Braiins)
CREATE TABLE spend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bid_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  amount_consumed_sat INTEGER NOT NULL,
  fee_paid_sat INTEGER NOT NULL,
  shares_purchased_m REAL,
  shares_accepted_m REAL,
  shares_rejected_m REAL
);

-- Accounting - income (sourced from bitcoind/Electrs)
CREATE TABLE reward_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  value_sat INTEGER NOT NULL,
  detected_at INTEGER NOT NULL,
  reorged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (txid, vout)
);

-- Ocean payout ledger from the /v1/earnpay endpoint (#323, migration
-- 0116). Source of truth for P&L "collected" - covers BOTH on-chain
-- (on_chain_txid set) and Lightning (on_chain_txid null) settlements,
-- which reward_events (on-chain scanner) structurally cannot. Written
-- by OceanPayoutsService (full backfill on first run per address, then
-- a slow trailing-window refresh). dedup_key is the idempotency key:
-- `<address>|oc:<txid>` for on-chain, `<address>|ln:<ts>:<net_sat>` for
-- Lightning (a UNIQUE on on_chain_txid can't dedup null-txid Lightning
-- rows). enriched_alert gates the stage-2 payout_confirmed Telegram.
CREATE TABLE ocean_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  ts INTEGER NOT NULL,                 -- settlement time, ms epoch
  on_chain_txid TEXT,                  -- null = Lightning
  net_sat INTEGER NOT NULL,            -- total_satoshis_net_paid
  is_generation INTEGER NOT NULL DEFAULT 0,
  rail TEXT NOT NULL,                  -- 'onchain' | 'lightning'
  dedup_key TEXT NOT NULL,
  enriched_alert INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ocean_payouts_dedup ON ocean_payouts (dedup_key);
CREATE INDEX idx_ocean_payouts_addr_ts ON ocean_payouts (address, ts);

-- Alerts. v1.6 (#100) added external delivery via Telegram; the
-- columns below cover both the v1.0 audit trail and the channel-
-- agnostic delivery state added in migration 0062. Channel-specific
-- identifiers (Telegram message_id today; future channels later)
-- are JSON-blob'd into delivery_meta_json so swapping NotificationSink
-- backends doesn't need another schema bump.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,                    -- 'INFO' | 'WARNING' | 'IMPORTANT'
                                             -- (renamed from INFO/WARN/LOUD in
                                             --  migration 0079, #129)
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,                      -- legacy: 'BUFFERED' | 'SENT' | 'FAILED'
  sent_at INTEGER,
  -- #100 delivery state, channel-agnostic:
  event_class TEXT,                          -- e.g. 'datum_unreachable'
  delivery_status TEXT NOT NULL DEFAULT 'pending',
                                             -- 'pending' | 'sent' | 'failed' |
                                             -- 'muted' | 'gave_up'
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_ms INTEGER,
  next_retry_at_ms INTEGER,                  -- per-tick retry scheduler reads this
  snoozed_until_ms INTEGER,                  -- legacy column; snooze removed post-v1.5
  paired_alert_id INTEGER REFERENCES alerts(id),
                                             -- recovery row -> originating alert
  delivery_meta_json TEXT,                   -- {message_id: ...} for Telegram
  acknowledged_at_ms INTEGER
);

-- Cached market settings and fee schedule
CREATE TABLE market_settings_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

CREATE TABLE fee_schedule_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  cached_at INTEGER NOT NULL
);

-- Pool blocks observed from Ocean (#108, migration 0065)
CREATE TABLE pool_blocks (
  height INTEGER PRIMARY KEY,
  block_hash TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  total_reward_sat INTEGER NOT NULL,
  subsidy_sat INTEGER NOT NULL,
  fees_sat INTEGER NOT NULL,
  worker TEXT,
  username TEXT,
  observed_at_ms INTEGER NOT NULL
);
CREATE INDEX idx_pool_blocks_timestamp_ms ON pool_blocks (timestamp_ms);

-- Bid events (create/edit/cancel audit trail; migrations 0009, 0016, 0077)
CREATE TABLE bid_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('AUTOPILOT', 'OPERATOR')),
  kind TEXT NOT NULL CHECK (
    -- 4 bid-mutation kinds + 3 lifecycle kinds (#287, migration 0111):
    -- MODE_CHANGE logs operator/boot run-mode switches, BID_PAUSED /
    -- BID_RESUMED log Braiins-side bid status flips observed per tick.
    kind IN ('CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID',
             'MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED')
  ),
  braiins_order_id TEXT,
  old_price_sat INTEGER,
  new_price_sat INTEGER,
  speed_limit_ph REAL,
  amount_sat INTEGER,
  reason TEXT,
  overpay_sat_per_eh_day INTEGER,                -- migration 0077; snapshot at write time
  max_overpay_vs_hashprice_sat_per_eh_day INTEGER -- migration 0077; snapshot at write time
);
CREATE INDEX idx_bid_events_occurred_at ON bid_events (occurred_at);

-- #250 (migration 0109): append-only log of public-IP rotations. One
-- row per observed change of the box's public IPv4, written from the
-- public-IP poll's onIpChange hook. Drives the "IP last changed" line
-- in the Dynamic DNS card and the router-icon markers on the hashrate /
-- price charts (to correlate IP rotations against rejection-rate spikes).
CREATE TABLE ip_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  old_ip TEXT,                      -- nullable; populated in practice (hook fires only on non-null -> different)
  new_ip TEXT NOT NULL
);
CREATE INDEX idx_ip_change_events_occurred_at ON ip_change_events (occurred_at);

-- Block-header version cache for BIP 110 detection (#94, migration 0058)
CREATE TABLE block_version_cache (
  block_hash TEXT PRIMARY KEY,
  block_version INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Braiins deposit lifecycle tracking (#130/#143, migration 0080)
CREATE TABLE braiins_deposits (
  tx_id TEXT PRIMARY KEY,
  amount_sat INTEGER NOT NULL,
  address TEXT,
  last_seen_status INTEGER NOT NULL,              -- DepositStatus enum (0..5; exact mapping undocumented)
  last_seen_return_tx_id TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  notified_detected INTEGER NOT NULL DEFAULT 0 CHECK (notified_detected IN (0, 1)),
  notified_available INTEGER NOT NULL DEFAULT 0 CHECK (notified_available IN (0, 1)),
  notified_returned INTEGER NOT NULL DEFAULT 0 CHECK (notified_returned IN (0, 1))
);
CREATE INDEX idx_braiins_deposits_first_seen_at ON braiins_deposits (first_seen_at_ms);

-- Solo-mining device registry (#149, migration 0085)
CREATE TABLE solo_miners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  ip TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Solo-mining per-tick per-device samples (#149, migrations 0085-0087, 0094)
CREATE TABLE solo_miner_samples (
  device_id INTEGER NOT NULL REFERENCES solo_miners(id) ON DELETE CASCADE,
  tick_at INTEGER NOT NULL,
  reachable INTEGER NOT NULL,
  hashrate_1m_ghs REAL,
  hashrate_10m_ghs REAL,
  hashrate_1h_ghs REAL,
  hashrate_instant_ghs REAL,                      -- migration 0087; firmware fallback
  expected_hashrate_ghs REAL,
  temp_c REAL,
  vr_temp_c REAL,
  power_w REAL,
  voltage_v REAL,
  current_a REAL,
  shares_accepted INTEGER,
  shares_rejected INTEGER,
  uptime_seconds INTEGER,
  asic_model TEXT,
  version TEXT,
  stratum_url TEXT,
  stratum_port INTEGER,
  stratum_user TEXT,
  best_diff_text TEXT,                             -- migration 0086
  best_session_diff_text TEXT,                     -- migration 0086
  best_diff_numeric REAL,                          -- migration 0094; parsed numeric for fleet MAX()
  PRIMARY KEY (device_id, tick_at)
);
CREATE INDEX solo_miner_samples_tick_idx ON solo_miner_samples(tick_at);

-- Solo-mining fleet best-difficulty records (#204, migration 0094)
CREATE TABLE solo_best_difficulty_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at INTEGER NOT NULL,
  difficulty REAL NOT NULL,
  previous_difficulty REAL,
  device_label TEXT NOT NULL,
  device_ip TEXT NOT NULL
);
CREATE INDEX idx_solo_best_diff_events_recorded_at
  ON solo_best_difficulty_events(recorded_at);
```

Migration history in `packages/daemon/src/state/migrations/` - forward-only, applied in filename order
on startup. See `packages/daemon/src/state/db.test.ts` for the authoritative expected list. Grouped by
concern (not by order; the file names are authoritative):

- **Baseline (0001-0004):** initial schema, strategy knobs, `cl_order_id` unique-constraint fix,
  `tick_metrics` time-series.
- **Payout observation (0005, 0021-0022):** electrs config, bitcoind RPC in the config table,
  `payout_source` selector.
- **Runtime state + alerting (0006, 0008, 0014, 0031, 0032, 0038):** `run_mode` index, `boot_mode`,
  persistent floor state. Migrations 0031 → 0032 renamed the above-floor counter column; 0038 added
  `below_target_since_ms` for an above-market escalation mode that was retired in v2.0 (column remains
  as nullable). All fill-strategy timers are now defunct under v2.1.
- **Pricing v1.x (0007, 0010-0011, 0013, 0015):** overpay-before-lowering, lowering-step dampener,
  v1.6 formula rewrite, `min_lower_delta`, `max_overpay_sat_per_eh_day` rename. **Retired by 0043.**
- **Bid events + ownership (0009, 0016-0017, 0026):** bid-event log, edit-speed kind, `owned_bids`
  consumed column, terminal-bid cache.
- **Accounting (0018-0019, 0037):** `spent_scope` toggle (`autopilot` vs `account`), BTC/USD price
  source, `monthly_budget_ceiling_sat` drop.
- **Block metadata (0033-0036):** block-explorer URL template, `tick_metrics_ocean_hashrate`, two
  block-metadata migrations (added 0034, dropped 0036 - feature removed).
- **Ocean / hashprice (0012, 0023-0024):** `fillable_ask_sat_per_eh_day`, per-tick hashprice,
  per-tick max-bid snapshot.
- **Cheap-mode scaling (0020, 0044):** `cheap_target_hashrate_ph` + `cheap_threshold_pct` in 0020,
  `cheap_sustained_window_minutes` in 0044 (sustained-all-below engagement gate).
- **Retention (0027):** `tick_metrics_retention_days`, `decisions_{uneventful,eventful}_retention_days`.
- **Datum integration (0028-0029):** `datum_api_url` in config, `datum_hashrate_ph` on `tick_metrics`.
- **Dynamic cap (0030):** `max_overpay_vs_hashprice_sat_per_eh_day` hashprice-relative ceiling.
- **Chart smoothing (0039, 0042, 0046):** rolling-mean minute windows the dashboard applies
  client-side (`braiins_hashrate_smoothing_minutes`, `datum_hashrate_smoothing_minutes`, and
  `braiins_price_smoothing_minutes`); `show_effective_rate_on_price_chart` boolean toggle in 0046.
- **Actual-spend pipeline (0040-0041):** `spend_sat` column on `tick_metrics` (0040, now unused - see
  note below), `primary_bid_consumed_sat` cumulative-counter snapshot (0041) - this is the
  authoritative per-tick spend series that drives the effective-rate line, the UPTIME metric, and
  counter-derived delivered hashrate.
- **CLOB redesign + pay-your-bid correction (0043 + 0045):** 0043 retired the v1.x fill-strategy
  knobs (`escalation_mode`, `fill_escalation_*`, `min_lower_delta_sat_per_eh_day`,
  `lower_patience_minutes`). The same file originally also dropped `overpay_sat_per_eh_day`; after
  v2.0 was reversed by v2.1, that specific drop was removed from 0043 and 0045 became a no-op, so
  upgrading operators keep their configured overpay value. Other v1.x knobs stay retired because
  v2.1's direct fillable tracking replaces them with a single formula.
- **P&L per-day spend (0040 → superseded by 0041):** 0040 added
  `tick_metrics.spend_sat`, originally precomputed per tick as
  `price_sat_per_eh_day × delivered_ph / 1_440_000`. 0041 added
  `primary_bid_consumed_sat` (per-tick snapshot of the Braiins counter); the
  range-aware `/api/finance/range` aggregates and the per-day P&L panel were
  switched to per-tick deltas of that counter (settled cost from Braiins under
  pay-your-bid), and `spend_sat` is no longer written. The column is retained
  for schema continuity. See spec §11.1.
- **Post-v1.4.8 feature work (0052-0058; 0059-0060 were never created, the sequence jumps to 0061):** block-found sound config + custom
  blob (0052, #88); extended per-tick capture from existing data sources
  (0053-0054, #89 - adds `network_difficulty`, `estimated_block_reward_sat`,
  `pool_hashrate_ph`, `pool_active_workers`, `braiins_total_deposited_sat`,
  `braiins_total_spent_sat`, `ocean_unpaid_sat`, `btc_usd_price`,
  `btc_usd_price_source`, `primary_bid_last_pause_reason`,
  `primary_bid_fee_paid_sat`, `primary_bid_fee_rate_pct` on `tick_metrics`);
  pool-block counts + trailing hashrate average + gap-based pool luck
  (0055-0057, #92 - `pool_blocks_24h_count`, `pool_blocks_7d_count`,
  `pool_hashrate_ph_avg_24h/7d`, `pool_luck_24h/7d`); block-header version
  cache for the BIP 110 yellow-cube marker (0058, #94 / #115 - separate
  `block_version_cache` table keyed on `block_hash`; #115 reassigned the
  shape so the gold crown is reserved for own-blocks and BIP 110 reads
  as a softer yellow cube).

- **Telegram notifications, deposit lifecycle, and dead-column drops
  (0062-0084):** the alerts table (0062, #100) with subsequent
  per-event-class opt-out (0064), Telegram bot/chat config columns
  (0063, 0070), DDNS (0067-0068), tx URL template (0071),
  notify-on-pool-block-credit toggle (0073), alerts retention (0076),
  chart-marker cap (0078), severity rename ERROR -> IMPORTANT (0079,
  #129), `braiins_deposits` per-tx idempotency table (0080, #130 /
  #143), notification_locale (0081, #131), split outage thresholds
  (0082, #135), and the cleanup migrations that retired dead columns:
  0083 drops `runtime_state.operator_available` (#148 - dead since
  spec v1.1's action-mode-state-machine retirement), 0084 drops
  `alerts.snoozed_until_ms` (#148 - snooze ripped in cc62951).

- **Marketplace-empty + payout features (0088-0091):** 0088 adds
  `marketplace_empty_alert_after_minutes` to config (#167); 0089-0090
  add `include_historical_payouts` toggle and `historical_payouts_offset_sat`
  for the manual pre-installation earnings offset (#170); 0091 adds
  `braiins_reachable` boolean to `tick_metrics` (#173 - distinguishes
  "marketplace empty" from "Braiins API unreachable" on charts and alerts;
  1 = reachable, 0 = unreachable, NULL for pre-migration rows).

- **Debug API (0092, #179):** 0092 adds `debug_api_enabled` boolean to
  config (default OFF). Gates `GET /api/debug/dump`, a single-curl
  diagnostics endpoint that bundles tick_metrics, pool_blocks, alerts,
  bid_events, reward_events, whitelisted config, and daemon info into
  one JSON response. Returns 404 when disabled.

- **Solo-mining monitoring (0085-0087, #149):** 0085 adds the
  `solo_miners` device registry (label, IP/host, enabled flag,
  per-ASIC overheating-ceiling override) and the `solo_miner_samples`
  ring buffer (per-tick per-device hashrate, ASIC + VR temps, power,
  share counters, stratum URL) plus the seven `config` columns
  spec.md §8 covers (`solo_mining_enabled` and the six alert-tuning
  knobs). 0086 adds `best_diff` / `best_session_diff` TEXT to
  `solo_miner_samples` for the lifetime / session best-share-difficulty
  surfaces. 0087 adds `hashrate_instant_ghs` to `solo_miner_samples`
  for firmware variants that expose only the bare `hashRate` field
  rather than the windowed `hashRate_10m` / `hashRate_1h` averages.

- **Pool luck 30d + solo best difficulty (0093-0094):** 0093 (#201)
  adds `pool_luck_30d`, `pool_blocks_30d_count`, `pool_hashrate_ph_avg_30d`
  to `tick_metrics`, extending the gap-based luck surface from 24h/7d to
  30d. 0094 (#204) adds `solo_best_difficulty_all_time REAL` to
  `runtime_state` (fleet-wide high-water mark) and creates the
  `solo_best_difficulty_events` table (device_label, device_ip, difficulty,
  recorded_at) for the staircase chart line and trophy markers. An INFO
  Telegram notification fires on each new record.

- **Debug-API toggle + balance metrics (0092, 0095):** 0092 (#179)
  adds `debug_api_enabled` boolean (default OFF) gating `GET /api/debug/dump`.
  0095 (#211) adds `total_balance_sat` to `tick_metrics` = available + blocked,
  the source of the Braiins panel balance display.

- **Deposit lifecycle timestamps (0096-0098):** 0096 stores the real
  Braiins tx timestamp on `braiins_deposits` (not just first_seen). 0097
  adds `credited_at_ms` so deposit markers anchor at the balance-step
  moment rather than chain-confirmation time. 0098 corrects rows that
  0097 backfilled with `now()` instead of using `tx_timestamp_ms`.

- **Bid-edit deadband + fee guard (0099-0100):** 0099 (#222) adds two
  `config` columns: `bid_edit_deadband_pct` (operator-tunable EDIT_PRICE
  noise floor, default 20%; was the legacy `overpay/5` constant) and
  `max_acceptable_fee_pct` (mutation gate denies CREATE / EDIT / EDIT_SPEED
  when any active bid's `fee_rate_pct` exceeds this). 0100 (#224) adds
  `bid_edit_deadband_pct REAL NOT NULL DEFAULT 20` to `tick_metrics` so
  historical EDIT_PRICE event tooltips can render the deadband that was
  in effect at the time of the edit.

- **Payout-lifecycle notifications + Display & Logging (0101-0103):**
  0101 (#226) adds `notify_on_payout_initiated` and `notify_on_payout_confirmed`
  config booleans for the Ocean payout-lifecycle Telegram alerts (TIDES
  payout detected => block credited => on-chain TX confirmed). 0102
  (#227 follow-up) promotes `display_number_locale` and `display_date_layout`
  from browser localStorage to daemon config so the Telegram render path
  reads operator-set formatting (the chart-screenshot embed in notifications
  was using browser defaults, not Display & Logging settings). 0103 (#238)
  adds `chart_color_overrides` JSON to config, keyed by series name with
  `#RRGGBB` values, for the Display & Logging chart-color picker.

- **Per-tick Braiins share counters (0106):** 0106 (#243) adds
  `tick_metrics.primary_bid_shares_purchased_m / _accepted_m /
  _rejected_m` (REAL nullable). Sourced from a per-tick GET on
  `/spot/bid/detail/{order_id}` (`counters_committed` block; the
  bids list response doesn't carry them). The dashboard's Hashrate
  chart adds a `rejection ratio (Braiins)` right-axis series and the
  Braiins service panel adds a `rejection ratio` row (Braiins's own
  terminology), both derived
  client-side from per-tick deltas (`Δrejected / Δpurchased × 100`)
  with NULL on bid-rotation ticks (counter reset → negative
  Δpurchased) and on ticks where Δpurchased ≤ 0.

- **Post-1.14 window (0107-0117):** 0107 (#243) scrubs orphan May 5-6 rows
  left in the share-counter columns by the reverted #90 migration reusing
  the same names. 0108 (#244) adds the reserved/dormant `dashboard_card_order` column, 0109 (#250) creates `ip_change_events`, 0110 (#266) adds `dashboard_tiles`. 0111
  (#287) rebuilds `bid_events` to widen the kind CHECK constraint for
  MODE_CHANGE / BID_PAUSED / BID_RESUMED. 0112 (#312) historizes
  `max_overpay_vs_hashprice_sat_per_eh_day` per tick (effective-cap line
  reconstruction); 0113 backfills it. 0114 (#318) creates `system_events`
  (config_change + daemon_started rows behind `GET /api/system-events`).
  0115 (2026-07-02 audit) drops `config.handover_window_minutes` - the
  retired §7.3 manual-override knob nothing read. 0116 (#323) creates the
  `ocean_payouts` table, synced from Ocean's `/v1/earnpay` endpoint
  (per-address backfill + trailing-window refresh). It holds both on-chain
  payouts (has `on_chain_txid`) and Lightning payouts (`on_chain_txid IS
  NULL`), and is the source of truth for the Profit & Loss "collected"
  figure and its on-chain/Lightning rail split. 0117 (GHSA-x8x9) scrubs
  credential values that a v1.16.0 config-change audit-log feature had
  written in cleartext into `system_events` rows (`telegram_bot_token`,
  `bitcoind_rpc_user`, `bitcoind_rpc_password`, `ddns_username`,
  `ddns_credential`); the daemon also redacts these at write time going
  forward. 0120 (#343) adds `ocean_payouts.deduced` - earnpay turned out
  NOT to return Lightning payouts (Ocean support confirmed), so the
  DeducedPayoutsScanner infers them from confirmed drops of
  `tick_metrics.ocean_unpaid_sat` to ~zero and stores them here with
  `deduced = 1` and rail `'unknown'` -> `'lightning'` (superseded by the
  real settlement if one ever matches). 0121 (#362) repairs installs
  where a negative `ocean_unpaid_sat` reading minted a phantom deduced
  payout: it deletes deduced rows whose drop tick sits within the
  scanner's 30-minute cooldown of a negative reading, then nulls the
  negatives. Targeted rather than "delete all and re-derive" so the
  AUTOINCREMENT ids of legitimate deduced rows survive and their
  `payout:<id>` Timeline notes stay attached.

- **Gap-backfill + boot-time payout refresh (0104-0105):** 0104 (#241)
  adds `tick_metrics.synthetic INTEGER NOT NULL DEFAULT 0` marking rows
  inserted by `runGapBackfill` to reconstruct offline-period state.
  Gap-detection queries filter `synthetic = 0` so previous-run synthetics
  can't poison boundary lookups; `runPoolLuckRecompute`'s 30d-eligibility
  gate is bypassed for synthetic rows so fresh installs (shallow
  pool_blocks coverage) still get pool_luck populated on gap synthetics.
  0105 (#240 follow-up) adds `runtime_state.last_backfilled_payout_address
  TEXT`. On daemon boot, the daemon compares this column against
  `cfg.btc_payout_address`; on mismatch (including first-boot NULL) it
  clears `reward_events`, nulls `tick_metrics.paid_total_sat`, resets
  the payout-observer snapshot, kicks `scanOnce` + `runHistoricalBackfill`
  against the live address, then stamps the new address. Even on match,
  the daemon additively re-runs `runHistoricalBackfill` so users who
  never changed addresses still benefit from fresh discoveries (e.g.,
  a payout TX that wasn't found on a prior boot due to a now-fixed
  code bug like the pre-build-558 coinbase-only filter).

## 6. External integrations

### 6.1 Braiins client

- Types generated from the live `openapi.yml` via `openapi-typescript`. Regen on-demand script in `scripts/`.
- Thin wrapper around `fetch` with:
    - Auth header injection per call (owner vs read-only explicit).
    - `grpc-message` header decoding on 400 responses for human-readable errors.
    - Retry-with-backoff on 429 and 5xx.
    - Request tracing (log `request_id` from every response body).
- **DELETE with JSON body**: the Braiins API rejects `DELETE /spot/bid?order_id=…` with a 400. The order ID must go
  in the JSON body. `fetch` does not support a body on DELETE out of the box, so the client uses a custom
  `fetchImpl` branch for this one path.

### 6.2 Payout observation

Two modes, selected per-config:

- **Electrs (preferred)** - TCP client with bech32→scripthash conversion; instant balance and tx lookups.
- **`bitcoind` JSON-RPC (fallback)** - `listreceivedbyaddress` / `gettransaction`, with `scantxoutset` as a last
  resort when the wallet is not configured to watch the payout address.

Reconciliation pass: periodic full scan to catch anything real-time detection missed.

### 6.3 Ocean client and the BIP110 chain (#363, #366, #367)

Since the 8/8/2026 chain split Ocean runs two chains with fully separate TIDES accounting, and its JSON API covers only the mainstream one. Ocean has confirmed (support, 2026-08-18) that no API exists for the BIP110 chain, none is planned, and scraping is not supported. The architecture reflects that as a declarative switch, `config.ocean_chain` (`mainstream` default / `bip110`, migrations 0122/0123):

- **Chain-gated client.** `createChainGatedOceanClient({getChain})` wraps the real Ocean client; on `bip110` every call short-circuits without HTTP (`fetchStats`/`fetchPayouts` → null, `fetchBlocksPage` → []). `OceanPayoutsService` therefore never syncs (null reads as "ledger unreadable", non-destructive) and the deduced-payouts scanner never runs. Each tick's Ocean reading is stamped with `tick_metrics.ocean_chain`, and the deduced-payout drop-candidate SQL partitions by chain, so chain flips can't read a cross-chain balance jump as a payout.
- **P&L collected on bip110** comes from `reward_events` (sum of non-reorged rows - the same on-chain ledger the chart's lifetime-earnings line reads, populated by the payout observer via the operator's own node), not `ocean_payouts`. Lightning is reported as unknown (null), net drops the structurally-null unpaid term, and the P&L rebuild / hard-reset routes re-run the on-chain address-history backfill (probe-scan-before-wipe) instead of the earnpay fetch.
- **No hashprice on bip110.** None is served or derived (Braiins spend is mainstream sats; BIP110 earnings are chain-local sats - not comparable). `getHashprice` and the status route return null on that chain (guarding against the stale pre-flip cache value), the #28 dynamic cap is bypassed in `decide()` (the fixed `max_bid` is the only ceiling), and cheap mode is inert. The Config UI renders both controls disabled with the reason.
- **Dashboard surfaces** are marked rather than hidden: Ocean/hashprice tiles render an amber "n/a" chip, right-axis options carry "(n/a on BIP110)" but stay selectable, and the affected chart legends dim - pre-switch mainstream history keeps plotting, series end at the switch.

## 7. Secrets and config

- **Layered secret resolution** (first available wins): `BHA_*` environment variables > the SOPS-encrypted file
  (`.env.sops.yaml`) > the encrypted `secrets` table in `state.db` (populated by the first-run web onboarding
  wizard). Any one source can satisfy a given secret.
- **Secrets-at-rest (#331).** The database-stored secrets - Braiins owner + read-only tokens, bitcoind RPC
  password, Telegram bot token, DDNS credential - are AES-256-GCM encrypted at rest. Each value is stored as an
  envelope `enc:v1:<b64 iv>:<b64 ciphertext+tag>`, with the field name bound in as the AAD. The dashboard password
  is stored as a one-way scrypt hash (never recoverable, only verifiable).
- **Encryption key resolution** (first available wins): `BHA_SECRET_KEY` env var (on Umbrel this is the
  device-derived `APP_SEED`) > `BHA_SECRET_KEY_FILE` > a generated `secret.key` file (mode 0600) written next to
  `state.db`. The resolved key is run through HKDF-SHA256 to derive the per-field encryption key.
- A decrypt failure is handled gracefully - the secret is treated as unset rather than crashing the daemon into a
  restart loop. Legacy plaintext rows (from before #331) are encrypted or hashed in place on the next boot; the
  migration is idempotent.
- **Write-only credential API.** The config API is write-only for credential fields (`bitcoind_rpc_password`,
  `telegram_bot_token`, `ddns_credential`): they are accepted on POST but never echoed back on GET, and a blank
  value on save keeps the existing secret rather than clearing it.
- Decrypted values are held in memory only, never re-written to disk in plaintext; pino log redaction covers
  `braiins_owner_token`, `braiins_read_only_token`, `bitcoind_rpc_password`, `dashboard_password`. See
  `docs/security-secrets-at-rest.md` for the full threat model and key-management details.
- Live tunables (non-secret) live in SQLite `config` table, editable via the dashboard and `/config` HTTP route.
  Validation against a Zod schema on every write.

## 8. Deployment

Bare-process deployment via operator scripts in `scripts/`:

- `scripts/start.sh` - backgrounds the daemon, writes PID to `data/daemon.pid`, appends stdout/stderr to
  `data/logs/daemon.log`.
- `scripts/stop.sh` / `scripts/restart.sh` / `scripts/status.sh` / `scripts/logs.sh` - companions.
- `scripts/deploy.sh` - one-shot updater: pulls `main`, installs deps, builds, tests, then restarts the daemon.

Port 3010 binds to `0.0.0.0` (all interfaces) by default - reachable from any machine on the LAN. The operator's
VPN or Tailscale is the real perimeter; the shared dashboard password is a second factor. To restrict to loopback,
set `HTTP_HOST=127.0.0.1`. To change the port, set `HTTP_PORT=nnnn`.

## 9. Observability

- **Structured logs** via pino, stdout + rotated file under `data/logs/`. Fields: `level`, `ts`, `tick_id`,
  `run_mode`, `request_id` (on API-bound events).
- **Secret redaction** via pino's built-in redaction paths.
- **Health**: `/api/health` (unauthenticated) returns `{ status, mode }` for both NEEDS_SETUP and
  operational boots; doubles as the appliance liveness probe and the dashboard's setup-mode probe.
- **Prometheus `/metrics`** is not exposed; deferred until a scraper exists to consume it (see §13).

## 10. Development and testing

- **Build**: `pnpm -r build` (tsc per package; Vite build for dashboard).
- **Type check**: `pnpm -r typecheck`.
- **Lint**: ESLint + Prettier. Strict TS config.
- **Unit tests** (vitest): focused on pure modules - `decide()`, `gate()`, unit conversions, cooldown logic.
- **Integration tests**: Braiins client against a mocked server (MSW) - verifies error decoding, cooldown tracking,
  ownership tracking.
- **Manual first-run checklist** (`docs/first-run.md`, to be written): verify Datum Gateway reachability; verify
  owner token with a read-only call; read `/v1/spot/settings`; validate worker-identity shape
  (`<btc-address>.<label>`); set initial config; keep DRY-RUN for the first 24h; observe that autopilot decisions
  match operator intuition; only then engage LIVE.

## 11. Build milestones (shipped)

All milestones M1-M6 shipped as of v1.1 (commit `4cc8ad5`):

- M1 - Repo scaffold + Braiins read path.
- M2 - SQLite, config loader, sops-encrypted secrets.
- M3 - Control-loop skeleton in DRY-RUN with pure `decide()` / `gate()`.
- M4 - Live execution (POST/PUT/DELETE) with ownership tracking and unknown-order auto-PAUSE.
- M5 - Dashboard shell: Status, Decisions, Config, Login pages; shared-password auth.
- M6 - Payout observation via Electrs (preferred) or `bitcoind` RPC; accounting data path.

Remaining work is tracked in GitHub issues.

## 12. Risk register

| Risk                                           | Mitigation                                                                                                |
|------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Braiins API shape changes during beta          | Pin `openapi.yml` version in repo; CI regenerate and diff; alert on breaking change.                      |
| Beta-period assumptions change (e.g. fees)     | Poll `/spot/fee` every tick; loud alert on any non-zero value so operator can re-tune max prices.         |
| Owner token leak                               | sops at rest; log redaction in flight; age private key on-box with chmod 600 + operator backup.           |
| sops/age key lost                              | Operator backup responsibility, documented in README. Daemon refuses to start without it - fail closed.   |
| Dashboard password leak on LAN                 | Tailscale is the real perimeter; password is a second-gate, not a first-line.                            |
| SQLite corruption                              | WAL mode; automatic backup to `data/backups/state-<ts>.db` on each daemon startup.                        |
| "First ever bid" produces a bug that loses BTC | DRY-RUN at startup by design; operator engages LIVE only after 24h of decisions look right.               |

## 13. Open implementation questions

- **Whether to expose `/metrics`** day one or defer. Current lean: defer until a scraper exists to consume it.
- **Whether the control loop tick should self-adjust cadence** or stay at a fixed 60s. Current lean: fixed 60s;
  tune once we have live data on API rate limits.
- **How to version the config schema** as the product evolves. Current lean: single-row `config` table with an
  explicit `schema_version` column; migrations bump version and rewrite the row.

## Document history

| Version | Date       | Changes                                                                                                                                                                                    |
|---------|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | 2026-04-14 | Initial version.                                                                                                                                                                           |
| 1.1     | 2026-04-16 | Post-empirical rewrite: removed the confirmation bot, quiet-hours buffering, `PENDING_CONFIRMATION` / `CONFIRMATION_TIMEOUT` action modes, operator-availability flag. Updated milestones, schema, diagrams, and risk register to reflect the fully-autonomous gate now in the code. |
| 1.2     | 2026-04-19 | Refreshed the service inventory and HTTP-route listing in §2 to reflect everything shipped through mid-April: `ocean` + `datum` + `hashprice-cache` + `btc-price` + `account-spend` + `retention` services, and the `finance` / `stats` / `bid-events` / `ocean` / `payouts` / `btc-price` / `simulate` HTTP routes. Rewrote the migration summary in §5 with concern-grouped coverage of 0001-0031 instead of the stale "see git" placeholder. No schema or control-loop shape changes - this is a documentation catch-up, not a design revision. |
| 1.3     | 2026-04-23 | Spec consistency sweep: updated §5 config/runtime_state/tick_metrics schemas to current state (all migrations through 0040+), marked CLOB-retired pricing columns as DEPRECATED, fixed port/bind to 3010/0.0.0.0, replaced Docker Compose deployment with bare-process scripts, removed stale "In flight" milestone tracker, fixed "collapsible" panel reference. |
| 1.4     | 2026-04-24 | Aligned architecture with spec v2.1 (pay-your-bid controller). Removed `simulate` from the HTTP route list (retired in v2.0). Fixed §5 `config` schema - removed the duplicate/stray `overpay_sat_per_eh_day` line that was listed both as active and as DEPRECATED; added `braiins_price_smoothing_minutes`, `show_effective_rate_on_price_chart`. Fixed `runtime_state` block - added `action_mode` / `operator_available` (legacy-but-present) and `above_floor_ticks` (the debounce counter) which the code has but the doc omitted. Rewrote `tick_metrics` table to match the actual columns (was significantly wrong - old doc listed `actual_hashrate_ph`, `wallet_balance_sat`, etc. which the code doesn't use). Migration summary extended through 0046 with an explicit note on the 0043/0045 pay-your-bid preservation fix. |
| 1.5     | 2026-04-25 | Aligned with spec v2.2 (appliance packaging, v1.3.0 release, umbrella #56). Documented three-layer secrets resolution (env > sops > db) and the new `secrets` table (migration 0047). Added the NEEDS_SETUP boot path: when secrets or config are absent, daemon stands up only the wizard's three endpoints and transitions in-place to operational on submit. Added `/api/health` as a public probe shared by both boot phases. Noted setup.ts as the power-user CLI path; the dashboard wizard is the appliance default. Touched §3.3 and §10 (operator-facing helpers) only - no schema or control-loop shape changes. |

| 1.6     | 2026-05-02 | Catch-up sweep with spec v2.3. §5 config schema gains `show_share_log_on_hashrate_chart` (migration 0049) and flips `btc_price_source` default to `coingecko` (migration 0050, #77). §5 tick_metrics gains `share_log_pct` (migration 0048). Rewrote the `spend_sat` migration-summary entry (was self-contradicting: §5 marked it LEGACY/no-longer-written while the migration summary still said it fed the per-day P&L panel; per-day P&L is actually driven by `primary_bid_consumed_sat` deltas added in 0041). §2 repo-layout block: dropped the never-shipped `Decisions` page (spec §12.3 confirms it was not built) and added `storage-estimate` to the `routes/` listing (#85 shipped 2026-05-01). §9 observability: removed stale `/healthz` and Prometheus `/metrics` references (neither shipped) in favour of the actual `/api/health` endpoint, with a forward-looking note that `/metrics` is deferred. §1 high-level diagram: added the Datum Gateway's optional `:7152` `/umbrel-api` port (only `:23334` was shown), and dropped the misleading "Umbrel" annotation on bitcoind RPC - bitcoind can run anywhere on the LAN, and like Electrs it's an optional payout-observation source. No schema or control-loop shape changes. |
| 1.7     | 2026-05-18 | Comprehensive catch-up with spec v2.5 (two weeks of feature work since v1.6). §1: replaced "no external notification channel" with description of the Telegram subsystem (NotificationSink + TelegramSink + AlertEvaluator + TelegramReceiver inline-ack). §2: added debug-dump, ddns, solo-miners routes; confirmed /alerts in dashboard pages. §4: added /alerts and /setup to routing list. §5 config schema: added ~30 columns (Telegram 9, DDNS 5, solo-mining 5, alert thresholds 3, payout features 2, display/chart 3, debug API 1); fixed retention defaults (tick_metrics and eventful decisions are 0 = forever, not 365). §5 new tables: pool_blocks, bid_events, block_version_cache, braiins_deposits, solo_miners, solo_miner_samples. No control-loop shape changes. |
| 1.8     | 2026-05-21 | Migrations 0093-0094 catch-up (spec v2.7). §5 tick_metrics: added `pool_luck_30d`, `pool_blocks_30d_count`, `pool_hashrate_ph_avg_30d` (#201). §5 runtime_state: added `solo_best_difficulty_all_time` (#204). §5 new table: `solo_best_difficulty_events` (#204). Migration summary extended with a 0093-0094 paragraph. No control-loop shape changes. |
| 1.9     | 2026-05-22 | §5 DDL accuracy pass: rewrote `pool_blocks` (height-keyed PK, correct column names), `bid_events` (occurred_at, source, old/new price split, overpay snapshot columns from 0077), `braiins_deposits` (tx_id, integer status, notified_* idempotency flags, address column), `solo_miners` (UNIQUE ip, updated_at), and `solo_miner_samples` (composite PK, 20+ columns from actual migration 0085-0087 including reachable, voltage, current, asic_model, version, stratum_port/user). No code or control-loop shape changes - pure documentation accuracy. |
| 1.10    | 2026-05-25 | §5 DDL fixes from /check-code audit: `tick_metrics.network_difficulty` type corrected from REAL to INTEGER (matches migration 0053); added missing `paid_total_sat` (0066), `block_found_sound*` (0052/0061) columns; removed dropped `operator_available` from `runtime_state` (0083). No code changes. |
| 1.11    | 2026-05-25 | §2 repo layout: updated braiins-deposit-watcher.ts annotation - all three deposit events (_detected, _available, _returned) now sourced from the on-chain endpoint poller (#210). Retired the balance-delta workaround in AlertEvaluator. |
| 1.12    | 2026-05-25 | §2 routes listing: added `deposits` route (#211, `/api/deposits` serves credited Braiins deposits for Price chart markers). |
| 1.13    | 2026-05-29 | v1.10.0 release window. §5 `config` schema gains `bid_edit_deadband_pct` and `max_acceptable_fee_pct` (migration 0099, #222) - the EDIT_PRICE deadband formula in `decide.ts` is now `max(tick_size, overpay × bid_edit_deadband_pct / 100)` with default 20 reproducing the legacy `overpay / 5`; the mutation gate gains a new `FEE_THRESHOLD_EXCEEDED` denial reason that blocks CREATE / EDIT / EDIT_SPEED when any active bid's `fee_rate_pct` exceeds `config.max_acceptable_fee_pct` (CANCEL_BID stays allowed). §5 `tick_metrics` gains `bid_edit_deadband_pct` (migration 0100, #224) - per-tick snapshot so EDIT_PRICE event tooltips render the deadband in effect at any historical edit; `DEFAULT 20` backfills existing rows. No other control-loop shape changes. |
| 1.14    | 2026-05-30 | §5 `config` schema gains `notify_on_payout_initiated` and `notify_on_payout_confirmed` (migration 0101, #226) - two new opt-in INFO Telegram alerts for the Ocean payout lifecycle. payout_initiated fires the tick the daemon observes a one-tick `ocean_unpaid_sat` drop > 30% with residual below the 1,048,576-sat payout threshold (mirrors the dashboard's unpaidDropMarkers heuristic on PriceChart.tsx). payout_confirmed fires once per new `reward_events` row, with in-memory `lastNotifiedRewardEventId` watermark for idempotency, silent-baselined at boot from `rewardEventsRepo.maxId()` so a fresh install's backfill doesn't fire a flood. Both default off, gated by their own dedicated toggle each (same convention as `notify_on_pool_block_credit` / `notify_on_braiins_deposit`). No control-loop shape changes. |
| 1.15    | 2026-06-02 | Consolidated catch-up covering #227-#239. §5 `config` schema gains `display_number_locale` and `display_date_layout` (migration 0102, #227 follow-up) - Display & Logging preferences promoted from browser-only localStorage so the Telegram render path can read them. `chart_color_overrides` added (migration 0103, #238) - JSON object keyed by canonical series name with `#RRGGBB` values; the dashboard's `parseOverrides` defensively drops malformed JSON, unknown keys, and non-hex values so a stray browser write can't break the chart. Eighteen named series resolve through `getChartColor` on both HashrateChart and PriceChart (every left/right-axis line plus the four bid-event marker hues). New boot-time service `runNetworkDifficultyBackfill` (#230) walks NULL `tick_metrics.network_difficulty` rows and fills them from bitcoind block headers (two batched RPC calls per epoch boundary), with `IS NULL` guard on every UPDATE so live observations stay canonical. AlertEvaluator gains `lastPoolBlockUnpaidSat` in-memory field (#239) - single-block-per-tick pool_block_credited alerts now report Ocean's actual TIDES credit as the unpaid-delta against the previous fire; multi-block ticks and post-restart / post-payout fires fall back to the `~share_log_pct × reward` estimate with leading `~` to mark uncertainty. Bip110Deployment carries `since` (sourced from `bip9.since` in bitcoind's `getdeploymentinfo`) so the deployment-status badge tooltip distinguishes MASF vs UASF activation in ACTIVE state. Project-wide source sweep removed all em dashes (-) from `.ts` / `.tsx`. No control-loop shape changes. |
| 1.16    | 2026-07-02 | Code-vs-code-comment/doc audit sweep. §2 tree: +12 services (hashprice/btc-price refreshers, pool-luck, boot backfills, telegram-receiver, solo-hashing, block-version, electrs-client, ocean-unpaid-cleanup), repos list completed (bid_events, secrets, system_events, closed_bids_cache, stale-bid-prune), routes listing gains diagnostics, ip-changes, bid-history trio, and the metrics/alerts-registered extras. §5: migration summary extended 0107-0115, owned_bids DDL gains amount_consumed_sat + dest_url, config DDL notes the 0115 handover drop, pool_hashrate_ph type corrected to INTEGER, stale "through 0040+" header fixed. |
