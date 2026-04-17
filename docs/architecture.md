# Hashrate Autopilot — Architecture (v1.1)

> Concretion of `docs/spec.md` into module boundaries, data flow, deployment shape, and a milestone-ordered build plan.
> v1.0 was built around a 2FA gate on mutations that, on empirical verification, turns out not to apply to the
> owner-token API path. This version removes the confirmation bot, quiet-hours buffering, pending-confirmation /
> confirmation-timeout action modes, and operator-availability flag, and describes the simpler fully-autonomous
> architecture now in the code.

## 1. High-level shape

Two long-running processes on the always-on box, composed in a single Node daemon:

```
┌────────────────────────────────────────────────────────────┐
│                  Docker host (LAN box)                     │
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
Braiins API   Datum Gateway   bitcoind RPC            Electrs
(internet)    (LAN, :23334)   (LAN, Umbrel)      (LAN, optional)
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
│   │   │   └── pool-health.ts      (TCP probe of Datum Gateway :23334)
│   │   ├── src/controller/
│   │   │   ├── loop.ts             (tick driver)
│   │   │   ├── tick.ts
│   │   │   ├── observe.ts
│   │   │   ├── decide.ts           (pure; emits Proposal[] given State)
│   │   │   ├── gate.ts             (applies §7.2 mutation-gate rule + cooldowns)
│   │   │   └── execute.ts          (calls Braiins API with dry-run/live split)
│   │   └── src/http/               (Fastify; dashboard API)
│   │       ├── server.ts
│   │       └── routes/             (status, config, decisions, actions, operator, metrics, run-mode)
│   │
│   └── dashboard/                  React SPA
│       ├── src/main.tsx
│       ├── src/pages/              (Status, Decisions, Config, Login)
│       ├── src/components/
│       ├── src/lib/                (api, auth, format, labels, locale)
│       └── vite.config.ts
│
└── scripts/                        operator-facing helpers
    ├── setup.ts                    (first-run interview; validates worker identity shape)
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

- **Secrets** (tokens, RPC creds, dashboard password): loaded once at startup from sops-decrypted `.env`. Restart
  required to change.
- **Live tunables** (§8 of SPEC): stored in SQLite. The HTTP API writes them; the control loop reads the current row
  at the start of every tick. No watcher / pub-sub — cheap enough to re-read each tick.

## 4. Dashboard architecture

- **Framework**: React 18 + Vite. Served as static files from Fastify in production, or a Vite dev server against the
  daemon API in development.
- **State management**: TanStack Query for server state; Zustand for transient UI state.
- **Routing**: `react-router`. Pages: `/status`, `/decisions`, `/config`, `/login`.
- **Auth**: single shared password, checked by Fastify middleware; session cookie. Tailscale/VPN is the real
  perimeter; the password is a second factor against someone on the LAN.
- **Live updates**: polling via TanStack Query (`refetchInterval` ~5s on status screens). No WebSocket/SSE in v1.

## 5. Data model (SQLite, better-sqlite3)

Core tables, WAL-mode, single file at `data/state.db`. Migration scripts live in
`packages/daemon/src/state/migrations/`.

```sql
-- Live-editable configuration (single-row pattern)
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_hashrate_ph REAL NOT NULL,
  minimum_floor_hashrate_ph REAL NOT NULL,
  destination_pool_url TEXT NOT NULL,
  destination_pool_worker_name TEXT NOT NULL,  -- must be <btc-addr>.<label>
  max_bid_sat_per_eh_day INTEGER NOT NULL,
  monthly_budget_ceiling_sat INTEGER NOT NULL,
  bid_budget_sat INTEGER NOT NULL,
  wallet_runway_alert_days INTEGER NOT NULL,
  below_floor_alert_after_minutes INTEGER NOT NULL,
  zero_hashrate_loud_alert_after_minutes INTEGER NOT NULL,
  pool_outage_blip_tolerance_seconds INTEGER NOT NULL,
  api_outage_alert_after_minutes INTEGER NOT NULL,
  handover_window_minutes INTEGER NOT NULL,
  -- strategy knobs (v1.2 simplified)
  fill_escalation_step_sat_per_eh_day INTEGER NOT NULL,
  fill_escalation_after_minutes INTEGER NOT NULL,
  overpay_sat_per_eh_day INTEGER NOT NULL,
  escalation_mode TEXT NOT NULL DEFAULT 'dampened',  -- 'market' | 'dampened'
  hibernate_on_expensive_market INTEGER NOT NULL,  -- DEPRECATED: kept for NOT NULL; ignored by the app
  btc_payout_address TEXT NOT NULL,
  electrs_host TEXT,       -- optional, for fast balance lookups
  electrs_port INTEGER,
  updated_at INTEGER NOT NULL
);

-- Persistent runtime state (single-row pattern)
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_mode TEXT NOT NULL,                 -- 'DRY_RUN' | 'LIVE' | 'PAUSED'
  manual_override_until_ms INTEGER,       -- suppresses EDIT_PRICE after operator actions
  last_tick_at INTEGER,
  last_api_ok_at INTEGER,
  last_rpc_ok_at INTEGER,
  last_pool_ok_at INTEGER
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

-- Decision log (every tick produces a row; powers the Decisions page)
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_at INTEGER NOT NULL,
  observed_json TEXT NOT NULL,
  proposed_json TEXT NOT NULL,
  gated_json TEXT NOT NULL,
  executed_json TEXT NOT NULL,
  run_mode TEXT NOT NULL
);

-- Tick metrics (time-series for the hashrate chart)
CREATE TABLE tick_metrics (
  tick_at INTEGER PRIMARY KEY,
  actual_hashrate_ph REAL,
  target_hashrate_ph REAL,
  floor_hashrate_ph REAL,
  best_ask_sat INTEGER,
  wallet_balance_sat INTEGER
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

Migration history in `packages/daemon/src/state/migrations/`:

- `0001_initial.sql` — base schema.
- `0002_strategy_knobs.sql` — empirical strategy columns (overpay deadband, escalation).
- `0003_null_empty_cl_order_id.sql` — unique-constraint fix.
- `0004_tick_metrics.sql` — time-series for the hashrate chart.
- (Later migrations: electrs config, run_mode index, overpay margin — see git.)

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

**Docker Compose** as primary; systemd-native as documented fallback.

```yaml
# docker-compose.yml
services:
  daemon:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # LAN only via reverse-bind
    volumes:
      - ./data:/app/data        # state.db + logs
      - ./secrets:/app/secrets  # .env.sops.yaml + age key (read-only mount)
    environment:
      - NODE_ENV=production
      - SOPS_AGE_KEY_FILE=/app/secrets/age.key
```

Port 3000 binds to `127.0.0.1` — the operator reaches it over Tailscale MagicDNS or a LAN hostname, not the wider
network.

## 9. Observability

- **Structured logs** via pino, stdout + rotated file under `data/logs/`. Fields: `level`, `ts`, `tick_id`,
  `run_mode`, `request_id` (on API-bound events).
- **Secret redaction** via pino's built-in redaction paths.
- **Metrics** (optional): `/metrics` via `prom-client` with basic counters (`ticks_total`,
  `api_calls_total{endpoint,status}`, `rewards_detected_sat_total`, `spend_sat_total`).
- **Health**: `/healthz` returns 200 + compact JSON of current run mode, last successful API/RPC timestamps.

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

## 11. Milestone-ordered build plan

All milestones M1–M6 are shipped as of v1.1 (commit `4cc8ad5`). Remaining work:

**Done:**

- M1 — Repo scaffold + Braiins read path.
- M2 — SQLite, config loader, sops-encrypted secrets.
- M3 — Control-loop skeleton in DRY-RUN with pure `decide()` / `gate()`.
- M4 — Live execution (POST/PUT/DELETE) with ownership tracking and unknown-order auto-PAUSE.
- M5 — Dashboard shell: Status, Decisions, Config, Login pages; shared-password auth.
- M6 — Payout observation via Electrs (preferred) or `bitcoind` RPC; accounting data path.

**In flight / next:**

- Operator-initiated cancel and recreate from the dashboard (GitHub #2).
- i18n for the dashboard (GitHub #1).
- Stale-work / low-acceptance delivery-ratio alerting.
- Dynamic-IP detection + alert.
- Fee-schedule change detection + alert.
- First-run checklist (`docs/first-run.md`).
- Docker multi-stage build + `docker-compose.yml` + 5-minute setup walkthrough in README.

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

- **Docker vs bare systemd as the "default" deploy path.** Current lean: Docker-first, systemd documented as
  alternative.
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
