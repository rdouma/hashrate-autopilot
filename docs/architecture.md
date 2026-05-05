# Hashrate Autopilot — Architecture (v1.6)

> Concretion of `docs/spec.md` into module boundaries, data flow, deployment shape, and a
> milestone-ordered build plan.
>
> v1.0 was built around a 2FA gate on mutations that, on empirical verification, turns out not to
> apply to the owner-token API path. v1.1 removed the confirmation bot, quiet-hours buffering,
> pending-confirmation / confirmation-timeout action modes, and operator-availability flag. v1.2 added
> the simulator and the depth-aware pricing machinery. v1.3 was a spec-consistency sweep. v1.4
> (2026-04-24) aligned the architecture doc with spec v2.1: the simulator has been retired,
> `overpay_sat_per_eh_day` is back as the single pricing knob. v1.5 (2026-04-25) covered the
> appliance-packaging release. **v1.6** (this revision, 2026-05-02) catches up on schema additions
> through migration 0051 (share_log column + chart toggle, BTC-price default flip, retention bumps),
> fixes the legacy-`spend_sat` self-contradiction, drops the never-shipped `Decisions` page from the
> repo layout, replaces stale `/healthz` + `/metrics` mentions with the actual `/api/health`
> endpoint, and adds the `storage-estimate` route to the route list.

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
               + :7152 opt.)
```

The **daemon** is the control loop and the only writer to SQLite. The **dashboard** is a read-mostly React SPA backed
by a thin HTTP API the daemon exposes (same Node process). The operator interacts through the dashboard only; there
is no external notification channel in v1 — alerts and pending work surface in-app.

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
│   │   │   └── repos/              (config, decisions, owned_bids, runtime_state, tick_metrics)
│   │   ├── src/services/
│   │   │   ├── braiins-service.ts
│   │   │   ├── payout-observer.ts  (Electrs-preferred; bitcoind fallback)
│   │   │   ├── pool-health.ts      (TCP probe of Datum Gateway :23334)
│   │   │   ├── ocean.ts            (Ocean pool REST client: stats, blocks, earnings)
│   │   │   ├── datum.ts            (optional /umbrel-api poller — gateway-measured hashrate + workers)
│   │   │   ├── hashprice-cache.ts  (in-memory hashprice cache, fed from Ocean)
│   │   │   ├── btc-price.ts        (BTC/USD oracle — CoinGecko / Coinbase / Bitstamp / Kraken)
│   │   │   ├── account-spend.ts    (whole-account spend ledger from /v1/account/transaction)
│   │   │   └── retention.ts        (hourly pruner for tick_metrics + decisions)
│   │   ├── src/controller/
│   │   │   ├── loop.ts             (tick driver)
│   │   │   ├── tick.ts
│   │   │   ├── observe.ts
│   │   │   ├── decide.ts           (pure; emits Proposal[] given State)
│   │   │   ├── gate.ts             (applies §7.2 mutation-gate rule + cooldowns)
│   │   │   └── execute.ts          (calls Braiins API with dry-run/live split)
│   │   └── src/http/               (Fastify; dashboard API)
│   │       ├── server.ts
│   │       └── routes/             (status, config, decisions, actions, operator, metrics, run-mode,
│   │                                finance, stats, storage-estimate, bid-events, ocean, payouts, btc-price,
│   │                                bip110-scan)
│   │
│   └── dashboard/                  React SPA
│       ├── src/main.tsx
│       ├── src/pages/              (Status, Config, Setup, Login)
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

- `shared` is the contract layer — any type or conversion used on both sides lives here.
- `braiins-client` and `bitcoind-client` are separable packages because they could be reused by future projects (or
  replaced with test doubles during dry-run).
- `daemon` owns SQLite writes exclusively.
- `dashboard` never speaks to Braiins directly; always through the daemon. Secrets stay on the backend.

## 3. Daemon process model

Single Node process. Inside it, two runtime concerns share the event loop:

1. **Control loop** — a `setInterval`-driven tick (default 60s). On each tick: observe, decide, gate, execute.
2. **HTTP server** — Fastify serving the dashboard API.

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
- `/v1/spot/stats` + `/v1/spot/orderbook` — current market.
- `/v1/spot/bid/current` + per-bid `/v1/spot/bid/detail/{id}` — our active bids.
- `/v1/account/balance` — wallet (and reward income via Electrs/bitcoind separately).
- Pool reachability (TCP connect to Datum Gateway:23334).
- Payout observer: recent coinbase outputs to the BTC payout address since the last check.
- Local DB: ownership ledger, config, last-decrease timestamps, run mode, manual-override windows.

### 3.3 Config reload without restart

Two tiers of config:

- **Secrets** (tokens, RPC creds, dashboard password): loaded once at startup from one of three sources, in
  priority order: `BHA_*` environment variables > `.env.sops.yaml` (sops-decrypted) > the `secrets` table in
  `state.db` (populated by the first-run web onboarding wizard). Restart required to change.
- **Live tunables** (§8 of SPEC): stored in SQLite. The HTTP API writes them; the control loop reads the current row
  at the start of every tick. No watcher / pub-sub — cheap enough to re-read each tick.

## 4. Dashboard architecture

- **Framework**: React 18 + Vite. Served as static files from Fastify in production, or a Vite dev server against the
  daemon API in development.
- **State management**: TanStack Query for server state; Zustand for transient UI state.
- **Routing**: `react-router`. Pages: `/status`, `/config`, `/login`. Per-decision inspection is on the Status page: clicking a marker on the price chart pins its tooltip and exposes a "copy JSON" button that copies the underlying bid event.
- **Auth**: single shared password, checked by Fastify middleware; session cookie. Tailscale/VPN is the real
  perimeter; the password is a second factor against someone on the LAN.
- **Live updates**: polling via TanStack Query (`refetchInterval` ~5s on status screens). No WebSocket/SSE in v1.

## 5. Data model (SQLite, better-sqlite3)

Core tables, WAL-mode, single file at `data/state.db`. Migration scripts live in
`packages/daemon/src/state/migrations/`.

```sql
-- Live-editable configuration (single-row pattern)
-- Reflects the current schema after all migrations through 0040+.
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- Hashrate targets
  target_hashrate_ph REAL NOT NULL,
  minimum_floor_hashrate_ph REAL NOT NULL,
  destination_pool_url TEXT NOT NULL,
  destination_pool_worker_name TEXT NOT NULL,  -- must be <btc-addr>.<label>
  -- Pricing (pay-your-bid fillable-tracking — bid = min(fillable_ask + overpay, effective_cap))
  max_bid_sat_per_eh_day INTEGER NOT NULL,
  max_overpay_vs_hashprice_sat_per_eh_day INTEGER,  -- dynamic cap; null = disabled
  overpay_sat_per_eh_day INTEGER NOT NULL,          -- premium above fillable_ask (#53)
  -- Budget
  bid_budget_sat INTEGER NOT NULL,                   -- 0 = use full wallet balance
  wallet_runway_alert_days INTEGER NOT NULL,
  -- Outage tolerance
  below_floor_alert_after_minutes INTEGER NOT NULL,
  zero_hashrate_loud_alert_after_minutes INTEGER NOT NULL,
  pool_outage_blip_tolerance_seconds INTEGER NOT NULL,
  api_outage_alert_after_minutes INTEGER NOT NULL,
  -- Manual override
  handover_window_minutes INTEGER NOT NULL,
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
  -- Chart smoothing (display-only, not read by control loop)
  braiins_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  datum_hashrate_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  braiins_price_smoothing_minutes INTEGER NOT NULL DEFAULT 1,
  show_effective_rate_on_price_chart INTEGER NOT NULL DEFAULT 0,  -- bool (0 | 1)
  show_share_log_on_hashrate_chart INTEGER NOT NULL DEFAULT 0,    -- bool (0 | 1); migration 0049
  -- Retention (defaults bumped in migration 0051)
  tick_metrics_retention_days INTEGER NOT NULL DEFAULT 365,
  decisions_uneventful_retention_days INTEGER NOT NULL DEFAULT 7,
  decisions_eventful_retention_days INTEGER NOT NULL DEFAULT 365,
  -- Accounting
  spent_scope TEXT NOT NULL DEFAULT 'account',      -- 'autopilot' | 'account'
  -- Legacy columns still in the table (kept for NOT NULL + historical
  -- schema continuity) but no longer read or written by the app. 0043
  -- dropped the fill-strategy ones after the v2.0 CLOB redesign.
  -- `hibernate_on_expensive_market` is a v1.0 relic never used post-v1.1.
  hibernate_on_expensive_market INTEGER NOT NULL DEFAULT 0,
  --
  updated_at INTEGER NOT NULL
);

-- Persistent runtime state (single-row pattern)
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_mode TEXT NOT NULL,                 -- 'DRY_RUN' | 'LIVE' | 'PAUSED'
  action_mode TEXT NOT NULL,              -- Legacy v1.0 state — always 'NORMAL' in v2.x
  operator_available INTEGER NOT NULL,    -- Legacy v1.0 flag — always 0 in v2.x
  last_tick_at INTEGER,
  last_api_ok_at INTEGER,
  last_rpc_ok_at INTEGER,                 -- last successful bitcoind RPC call
  last_pool_ok_at INTEGER,                -- last successful Datum Gateway TCP probe
  below_floor_since_ms INTEGER,           -- alert timer start (debounced by FLOOR_DEBOUNCE_TICKS)
  above_floor_ticks INTEGER NOT NULL,     -- debounce counter for below_floor_since_ms
  lower_ready_since_ms INTEGER,           -- DEPRECATED (v2.0 retired lowering-patience)
  below_target_since_ms INTEGER           -- DEPRECATED (v2.0 retired above_market escalation)
);
-- Note: run_mode is set on startup from config.boot_mode:
--   ALWAYS_DRY_RUN (default) → always boots in DRY_RUN (safest)
--   LAST_MODE                → keeps whatever mode was active pre-restart; PAUSED → DRY_RUN
--   ALWAYS_LIVE              → boots directly into LIVE (for trusted redeployments)

-- Ownership ledger — which Braiins order IDs we created
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
  abandoned INTEGER NOT NULL DEFAULT 0
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
  available_balance_sat INTEGER,
  datum_hashrate_ph REAL,                 -- gateway-measured hashrate (null if not configured)
  ocean_hashrate_ph REAL,                 -- Ocean's credited 5-min hashrate for our payout address
  share_log_pct REAL,                     -- our slice of Ocean's TIDES window (e.g. 0.0182 for 0.0182%);
                                          -- migration 0048; null pre-0048 / when Ocean off
  spend_sat REAL,                         -- LEGACY column (bid × delivered model); no longer written
  primary_bid_consumed_sat INTEGER,       -- per-tick snapshot of the primary bid's consumed counter;
                                          -- deltas are the authoritative actual spend series that
                                          -- drives the per-day P&L panel, the effective-rate line,
                                          -- the UPTIME stat, and counter-derived delivered hashrate
  run_mode TEXT NOT NULL,
  action_mode TEXT NOT NULL
);

-- Accounting — spend (sourced from Braiins)
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

-- Accounting — income (sourced from bitcoind/Electrs)
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

-- Alerts (dashboard-local; no external delivery channel)
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,    -- 'INFO' | 'WARN' | 'LOUD'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  acknowledged_at INTEGER
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
```

Migration history in `packages/daemon/src/state/migrations/` — forward-only, applied in filename order
on startup. See `packages/daemon/src/state/db.test.ts` for the authoritative expected list. Grouped by
concern (not by order; the file names are authoritative):

- **Baseline (0001–0004):** initial schema, strategy knobs, `cl_order_id` unique-constraint fix,
  `tick_metrics` time-series.
- **Payout observation (0005, 0021–0022):** electrs config, bitcoind RPC in the config table,
  `payout_source` selector.
- **Runtime state + alerting (0006, 0008, 0014, 0031, 0032, 0038):** `run_mode` index, `boot_mode`,
  persistent floor state. Migrations 0031 → 0032 renamed the above-floor counter column; 0038 added
  `below_target_since_ms` for an above-market escalation mode that was retired in v2.0 (column remains
  as nullable). All fill-strategy timers are now defunct under v2.1.
- **Pricing v1.x (0007, 0010–0011, 0013, 0015):** overpay-before-lowering, lowering-step dampener,
  v1.6 formula rewrite, `min_lower_delta`, `max_overpay_sat_per_eh_day` rename. **Retired by 0043.**
- **Bid events + ownership (0009, 0016–0017, 0026):** bid-event log, edit-speed kind, `owned_bids`
  consumed column, terminal-bid cache.
- **Accounting (0018–0019, 0037):** `spent_scope` toggle (`autopilot` vs `account`), BTC/USD price
  source, `monthly_budget_ceiling_sat` drop.
- **Block metadata (0033–0036):** block-explorer URL template, `tick_metrics_ocean_hashrate`, two
  block-metadata migrations (added 0034, dropped 0036 — feature removed).
- **Ocean / hashprice (0012, 0023–0024):** `fillable_ask_sat_per_eh_day`, per-tick hashprice,
  per-tick max-bid snapshot.
- **Cheap-mode scaling (0020, 0044):** `cheap_target_hashrate_ph` + `cheap_threshold_pct` in 0020,
  `cheap_sustained_window_minutes` in 0044 (sustained-average hysteresis).
- **Retention (0027):** `tick_metrics_retention_days`, `decisions_{uneventful,eventful}_retention_days`.
- **Datum integration (0028–0029):** `datum_api_url` in config, `datum_hashrate_ph` on `tick_metrics`.
- **Dynamic cap (0030):** `max_overpay_vs_hashprice_sat_per_eh_day` hashprice-relative ceiling.
- **Chart smoothing (0039, 0042, 0046):** rolling-mean minute windows the dashboard applies
  client-side (`braiins_hashrate_smoothing_minutes`, `datum_hashrate_smoothing_minutes`, and
  `braiins_price_smoothing_minutes`); `show_effective_rate_on_price_chart` boolean toggle in 0046.
- **Actual-spend pipeline (0040–0041):** `spend_sat` column on `tick_metrics` (0040, now unused — see
  note below), `primary_bid_consumed_sat` cumulative-counter snapshot (0041) — this is the
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

- **Electrs (preferred)** — TCP client with bech32→scripthash conversion; instant balance and tx lookups.
- **`bitcoind` JSON-RPC (fallback)** — `listreceivedbyaddress` / `gettransaction`, with `scantxoutset` as a last
  resort when the wallet is not configured to watch the payout address.

Reconciliation pass: periodic full scan to catch anything real-time detection missed.

## 7. Secrets and config

- **sops** with an **age** key. Single-file, no keyring faff, easy to rotate.
- Decryption happens once at daemon startup. Decrypted values are held in memory, never re-written to disk; pino log
  redaction on `braiins_owner_token`, `braiins_read_only_token`, `bitcoind_rpc_password`, `dashboard_password`.
- The age private key lives on the always-on box at a fixed path with chmod 600; operator is responsible for a
  backup (printed or encrypted USB).
- Live tunables (non-secret) live in SQLite `config` table, editable via the dashboard and `/config` HTTP route.
  Validation against a Zod schema on every write.

## 8. Deployment

Bare-process deployment via operator scripts in `scripts/`:

- `scripts/start.sh` — backgrounds the daemon, writes PID to `data/daemon.pid`, appends stdout/stderr to
  `data/logs/daemon.log`.
- `scripts/stop.sh` / `scripts/restart.sh` / `scripts/status.sh` / `scripts/logs.sh` — companions.
- `scripts/deploy.sh` — one-shot updater: pulls `main`, installs deps, builds, tests, then restarts the daemon.

Port 3010 binds to `0.0.0.0` (all interfaces) by default — reachable from any machine on the LAN. The operator's
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
- **Unit tests** (vitest): focused on pure modules — `decide()`, `gate()`, unit conversions, cooldown logic.
- **Integration tests**: Braiins client against a mocked server (MSW) — verifies error decoding, cooldown tracking,
  ownership tracking.
- **Manual first-run checklist** (`docs/first-run.md`, to be written): verify Datum Gateway reachability; verify
  owner token with a read-only call; read `/v1/spot/settings`; validate worker-identity shape
  (`<btc-address>.<label>`); set initial config; keep DRY-RUN for the first 24h; observe that autopilot decisions
  match operator intuition; only then engage LIVE.

## 11. Build milestones (shipped)

All milestones M1–M6 shipped as of v1.1 (commit `4cc8ad5`):

- M1 — Repo scaffold + Braiins read path.
- M2 — SQLite, config loader, sops-encrypted secrets.
- M3 — Control-loop skeleton in DRY-RUN with pure `decide()` / `gate()`.
- M4 — Live execution (POST/PUT/DELETE) with ownership tracking and unknown-order auto-PAUSE.
- M5 — Dashboard shell: Status, Decisions, Config, Login pages; shared-password auth.
- M6 — Payout observation via Electrs (preferred) or `bitcoind` RPC; accounting data path.

Remaining work is tracked in GitHub issues.

## 12. Risk register

| Risk                                           | Mitigation                                                                                                |
|------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Braiins API shape changes during beta          | Pin `openapi.yml` version in repo; CI regenerate and diff; alert on breaking change.                      |
| Beta-period assumptions change (e.g. fees)     | Poll `/spot/fee` every tick; loud alert on any non-zero value so operator can re-tune max prices.         |
| Owner token leak                               | sops at rest; log redaction in flight; age private key on-box with chmod 600 + operator backup.           |
| sops/age key lost                              | Operator backup responsibility, documented in README. Daemon refuses to start without it — fail closed.   |
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
| 1.2     | 2026-04-19 | Refreshed the service inventory and HTTP-route listing in §2 to reflect everything shipped through mid-April: `ocean` + `datum` + `hashprice-cache` + `btc-price` + `account-spend` + `retention` services, and the `finance` / `stats` / `bid-events` / `ocean` / `payouts` / `btc-price` / `simulate` HTTP routes. Rewrote the migration summary in §5 with concern-grouped coverage of 0001–0031 instead of the stale "see git" placeholder. No schema or control-loop shape changes — this is a documentation catch-up, not a design revision. |
| 1.3     | 2026-04-23 | Spec consistency sweep: updated §5 config/runtime_state/tick_metrics schemas to current state (all migrations through 0040+), marked CLOB-retired pricing columns as DEPRECATED, fixed port/bind to 3010/0.0.0.0, replaced Docker Compose deployment with bare-process scripts, removed stale "In flight" milestone tracker, fixed "collapsible" panel reference. |
| 1.4     | 2026-04-24 | Aligned architecture with spec v2.1 (pay-your-bid controller). Removed `simulate` from the HTTP route list (retired in v2.0). Fixed §5 `config` schema — removed the duplicate/stray `overpay_sat_per_eh_day` line that was listed both as active and as DEPRECATED; added `braiins_price_smoothing_minutes`, `show_effective_rate_on_price_chart`. Fixed `runtime_state` block — added `action_mode` / `operator_available` (legacy-but-present) and `above_floor_ticks` (the debounce counter) which the code has but the doc omitted. Rewrote `tick_metrics` table to match the actual columns (was significantly wrong — old doc listed `actual_hashrate_ph`, `wallet_balance_sat`, etc. which the code doesn't use). Migration summary extended through 0046 with an explicit note on the 0043/0045 pay-your-bid preservation fix. |
| 1.5     | 2026-04-25 | Aligned with spec v2.2 (appliance packaging, v1.3.0 release, umbrella #56). Documented three-layer secrets resolution (env > sops > db) and the new `secrets` table (migration 0047). Added the NEEDS_SETUP boot path: when secrets or config are absent, daemon stands up only the wizard's three endpoints and transitions in-place to operational on submit. Added `/api/health` as a public probe shared by both boot phases. Noted setup.ts as the power-user CLI path; the dashboard wizard is the appliance default. Touched §3.3 and §10 (operator-facing helpers) only — no schema or control-loop shape changes. |

| 1.6     | 2026-05-02 | Catch-up sweep with spec v2.3. §5 config schema gains `show_share_log_on_hashrate_chart` (migration 0049) and flips `btc_price_source` default to `coingecko` (migration 0050, #77). §5 tick_metrics gains `share_log_pct` (migration 0048). Rewrote the `spend_sat` migration-summary entry (was self-contradicting: §5 marked it LEGACY/no-longer-written while the migration summary still said it fed the per-day P&L panel; per-day P&L is actually driven by `primary_bid_consumed_sat` deltas added in 0041). §2 repo-layout block: dropped the never-shipped `Decisions` page (spec §12.3 confirms it was not built) and added `storage-estimate` to the `routes/` listing (#85 shipped 2026-05-01). §9 observability: removed stale `/healthz` and Prometheus `/metrics` references (neither shipped) in favour of the actual `/api/health` endpoint, with a forward-looking note that `/metrics` is deferred. §1 high-level diagram: added the Datum Gateway's optional `:7152` `/umbrel-api` port (only `:23334` was shown), and dropped the misleading "Umbrel" annotation on bitcoind RPC — bitcoind can run anywhere on the LAN, and like Electrs it's an optional payout-observation source. No schema or control-loop shape changes. |