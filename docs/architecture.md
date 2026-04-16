# Braiins Hashrate Autopilot — Architecture (DRAFT v0.1)

> Concretion of `docs/spec.md` into module boundaries, data flow, deployment shape, and a milestone-ordered build plan.
> Every decision here is revisable during implementation; flagged ones (`TBD`) need either a quick call or are deferred
> until v1.1.

## 1. High-level shape

Three long-running processes on the always-on box, ideally composed together:

```
┌────────────────────────────────────────────────────────────┐
│                  Docker host (LAN box)                     │
│                                                            │
│   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐  │
│   │   daemon    │◄───┤  dashboard   │◄───┤  Telegram    │  │
│   │  (control)  │    │   (React)    │    │     bot      │  │
│   └──────┬──────┘    └──────┬───────┘    └──────┬───────┘  │
│          │                  │                   │          │
│          └────────┬─────────┴───────────────────┘          │
│                   │                                        │
│            ┌──────▼──────┐                                 │
│            │   SQLite    │  (single file, WAL mode)        │
│            │   state.db  │                                 │
│            └─────────────┘                                 │
└───────────┬────────────────────────────────────────────────┘
            │
   ┌────────┴────────┬─────────────────────┐
   │                 │                     │
   ▼                 ▼                     ▼
Braiins API    bitcoind RPC       Telegram Bot API
(internet)     (LAN, Umbrel)      (internet)
```

The **daemon** is the control loop and the only writer to SQLite. The **dashboard** is a read-mostly React SPA backed by
a thin HTTP API the daemon exposes (same Node process or adjacent — see §3). The **Telegram bot** is a small service
that sends notifications and receives the "I'm available" / pause / engage / ack commands from the operator's phone — a
second interaction surface beside the dashboard.

## 2. Repository layout

TypeScript monorepo via **pnpm workspaces** (simplest tool for this scale; no Turbo/Nx overhead).

```
braiins_hashrate_control/
├── package.json                    (root, pnpm workspaces)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.sops.yaml                  (encrypted secrets)
├── docker-compose.yml
├── Dockerfile
├── docs/
│   ├── spec.md
│   ├── architecture.md
│   ├── research.md
│   └── permissions-log.md
│
├── packages/
│   ├── shared/                     types, enums, pure utils shared between daemon and dashboard
│   │   ├── src/types.ts
│   │   ├── src/units.ts            (sat/EH/day conversions etc.)
│   │   └── src/decision.ts         (action-mode gate, pure function)
│   │
│   ├── braiins-client/             Braiins Hashpower API client (generated types + thin wrapper)
│   │   ├── src/generated/          (openapi-typescript output)
│   │   ├── src/client.ts
│   │   ├── src/auth.ts             (owner vs read-only token selector)
│   │   └── src/errors.ts           (grpc-message header decoding)
│   │
│   ├── bitcoind-client/            minimal JSON-RPC wrapper for payout observation
│   │   ├── src/rpc.ts
│   │   └── src/zmq.ts              (optional hashblock subscriber)
│   │
│   ├── daemon/                     the control loop + HTTP API + Telegram bot
│   │   ├── src/index.ts            (entry point, graceful shutdown)
│   │   ├── src/config/
│   │   │   ├── load.ts             (sops decrypt + schema validation)
│   │   │   └── watch.ts            (live-reload of live-editable values)
│   │   ├── src/state/
│   │   │   ├── db.ts               (better-sqlite3 + migrations)
│   │   │   ├── migrations/
│   │   │   └── repos/              (data-access objects — bids, decisions, ledger, settings, alerts)
│   │   ├── src/services/
│   │   │   ├── braiins.ts          (wraps braiins-client, caches /spot/settings, /spot/fee)
│   │   │   ├── bitcoind.ts         (payout observation, reconciliation pass)
│   │   │   ├── pool-health.ts      (TCP probe of Datum Gateway on 23334)
│   │   │   └── market.ts           (orderbook snapshot + price projection)
│   │   ├── src/controller/
│   │   │   ├── loop.ts             (tick driver)
│   │   │   ├── decide.ts           (pure; emits Proposed[] given State)
│   │   │   ├── gate.ts             (applies §7.3 mutation-gate rule)
│   │   │   └── execute.ts          (calls Braiins API with dry-run/live split)
│   │   ├── src/http/               (Fastify; dashboard + Telegram webhook)
│   │   │   ├── server.ts
│   │   │   ├── routes/dashboard.ts
│   │   │   ├── routes/telegram.ts
│   │   │   └── middleware/auth.ts
│   │   ├── src/notify/
│   │   │   └── telegram.ts         (grammy bot, send + buffer-during-quiet-hours)
│   │   └── src/observability/
│   │       ├── log.ts              (pino with redaction of secrets)
│   │       └── metrics.ts          (optional prom-client if we expose /metrics)
│   │
│   └── dashboard/                  React SPA
│       ├── src/main.tsx
│       ├── src/pages/
│       ├── src/components/
│       ├── src/lib/api.ts          (typed fetch against daemon HTTP API)
│       └── vite.config.ts
│
├── scripts/
│   ├── regen-openapi-types.sh      (pulls openapi.yml, runs openapi-typescript)
│   ├── seed-db.ts
│   └── sops-edit.sh                (wrapper for .env.sops.yaml)
│
└── tests/
    └── e2e/                        playwright/vitest (TBD)
```

Rationale for the split:

- `shared` is the contract layer — any type or conversion used on both sides lives here.
- `braiins-client` and `bitcoind-client` are separable packages because they could be reused by future projects (or
  replaced with test doubles during dry-run).
- `daemon` owns SQLite writes exclusively.
- `dashboard` never speaks to Braiins directly; always through the daemon. This keeps secrets on the backend only.

## 3. Daemon process model

Single Node process. Inside it, two runtime concerns share the event loop:

1. **Control loop** — a `setInterval`-driven tick (default 60s, configurable). On each tick: observe, decide, gate,
   execute or defer.
2. **HTTP server** — Fastify serving the dashboard API and a Telegram webhook receiver.

Sharing a process (rather than splitting into two services) keeps the SQLite write-path single-threaded and avoids
inter-process coordination headaches. Trade-off: an HTTP request surge can steal event-loop time from the control loop —
acceptable because the loop is 60s cadence, and we explicitly size dashboard requests to be cheap (no heavy compute in
HTTP handlers).

### 3.1 Tick shape

```
async function tick() {
  const state = await observe();      // read-only; API + RPC + DB
  const proposed = decide(state);     // pure function; emits intents
  const allowed = gate(proposed, state); // applies §7.3 rule
  await execute(allowed);             // cancels always; creates/edits in LIVE + NORMAL
  await persistDecisions(state, proposed, allowed);
}
```

`decide()` and `gate()` are pure and individually unit-testable. `observe()` and `execute()` hold all the side effects.
This separation makes DRY-RUN trivial: in DRY-RUN, `execute()` is replaced with a no-op that just records what it would
have done.

### 3.2 State inputs the tick consumes

- `MarketSettings` (cached, refreshed every N ticks): tick size, cooldowns, limits.
- `FeeSchedule` (cached, refreshed every N ticks).
- `/v1/spot/stats` + `/v1/spot/orderbook` — current market.
- `/v1/spot/bid/current` + per-bid `/v1/spot/bid/detail/{id}` — our active bids.
- `/v1/account/balance` — wallet.
- Pool reachability (TCP connect to Datum Gateway:23334).
- Bitcoind RPC: recent coinbase outputs to payout address (since last check).
- Local DB: ownership ledger, config, last-decrease timestamps, run mode, action mode, operator-available flag,
  deferred-decisions queue.

### 3.3 Config reload without restart

Two tiers of config:

- **Secrets** (tokens, RPC creds): loaded once at startup from sops-decrypted `.env`. Restart required to change.
- **Live tunables** (§8 of SPEC): stored in SQLite. The HTTP API writes them; the control loop reads the current row at
  the start of every tick. No watcher / pub-sub — cheap enough to re-read each tick.

## 4. Dashboard architecture

- **Framework**: React 18 + Vite. Served as static files from Fastify (production build) or a Vite dev server against
  the daemon API in development.
- **State management**: TanStack Query for server state (API responses), Zustand for transient UI state. No Redux.
- **Routing**: `react-router`. Pages: `/status`, `/orders`, `/config`, `/accounting`, `/decisions`, `/alerts`.
- **Auth**: single shared password, checked by Fastify middleware; session cookie. VPN/Tailscale is the actual
  perimeter; the password is a second factor against someone on the LAN.
- **Live updates**: polling via TanStack Query (`refetchInterval: 5s` on status screens). No WebSocket/SSE in v1; if we
  need instant push later, upgrade to SSE.

## 5. Data model (SQLite, better-sqlite3)

Core tables, WAL-mode, single file at `state.db`.

```sql
-- Live-editable configuration (single-row pattern)
CREATE TABLE config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_hashrate_ph REAL NOT NULL,
  minimum_floor_hashrate_ph REAL NOT NULL,
  destination_pool_url TEXT NOT NULL,
  destination_pool_worker_name TEXT NOT NULL,
  max_price_sat_per_eh_day INTEGER NOT NULL,
  emergency_max_price_sat_per_eh_day INTEGER NOT NULL,
  monthly_budget_ceiling_sat INTEGER NOT NULL,
  bid_budget_sat INTEGER NOT NULL,
  wallet_runway_alert_days INTEGER NOT NULL,
  below_floor_alert_after_minutes INTEGER NOT NULL,
  below_floor_emergency_cap_after_minutes INTEGER NOT NULL,
  zero_hashrate_loud_alert_after_minutes INTEGER NOT NULL,
  pool_outage_blip_tolerance_seconds INTEGER NOT NULL,
  api_outage_alert_after_minutes INTEGER NOT NULL,
  quiet_hours_start TEXT NOT NULL,     -- ISO "HH:MM"
  quiet_hours_end TEXT NOT NULL,
  quiet_hours_timezone TEXT NOT NULL,  -- IANA TZ
  confirmation_timeout_minutes INTEGER NOT NULL,
  handover_window_minutes INTEGER NOT NULL,
  btc_payout_address TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Persistent runtime state (single-row pattern)
CREATE TABLE runtime_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_mode TEXT NOT NULL,         -- 'DRY_RUN' | 'LIVE' | 'PAUSED'
  action_mode TEXT NOT NULL,      -- 'NORMAL' | 'QUIET_HOURS' | 'PENDING_CONFIRMATION' | 'CONFIRMATION_TIMEOUT'
  operator_available INTEGER NOT NULL,   -- bool
  last_tick_at INTEGER,
  last_api_ok_at INTEGER,
  last_rpc_ok_at INTEGER,
  last_pool_ok_at INTEGER
);
-- Note: run_mode is reset to DRY_RUN on startup (not persisted across restarts).

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
  abandoned INTEGER NOT NULL DEFAULT 0  -- operator dismissed a pending action
);

-- Deferred decisions (quiet hours or pending confirmation queue)
CREATE TABLE deferred_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_at INTEGER NOT NULL,
  action_type TEXT NOT NULL,           -- 'CREATE' | 'EDIT_PRICE' | 'EDIT_BUDGET' | ...
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,                -- 'QUEUED' | 'IN_FLIGHT' | 'CONFIRMED' | 'TIMED_OUT' | 'REEVALUATED'
  resolved_at INTEGER
);

-- Decision log (every tick produces a row; used for the dashboard "Decisions" page)
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

-- Accounting — income (sourced from bitcoind)
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

-- Alerts (buffered or sent)
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  severity TEXT NOT NULL,   -- 'INFO' | 'WARN' | 'LOUD'
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,     -- 'BUFFERED' | 'SENT' | 'FAILED'
  sent_at INTEGER,
  telegram_message_id TEXT
);

-- Cached market settings (refresh every N ticks)
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

Query layer: **Kysely** (typesafe SQL without full ORM weight). Generated types from the schema keep repository methods
honest.

## 6. External integrations

### 6.1 Braiins client

- Types generated from the live `openapi.yml` via `openapi-typescript`. Regen on-demand script in `scripts/`.
- Thin wrapper around `fetch` with:
    - Auth header injection per-call (owner vs read-only explicit).
    - `grpc-message` header decoding on 400s for human-readable errors.
    - Retry-with-backoff on 429 and 5xx.
    - Request tracing (log `request_id` from every response body).
- **Never retry a 2FA-gated create/edit on timeout.** The caller is responsible for entering CONFIRMATION_TIMEOUT state.

### 6.2 Bitcoind client

- JSON-RPC over HTTP to Umbrel's bitcoind.
- Methods used: `listreceivedbyaddress`, `listtransactions`, `gettransaction`, `getblock`, `getrawtransaction`.
- Optional: ZMQ `hashblock` subscriber for real-time reward detection (requires ZMQ endpoint exposed from Umbrel — check
  availability at setup).
- Reconciliation pass: hourly `listreceivedbyaddress` to catch anything ZMQ missed.

### 6.3 Telegram bot

- **grammy** library (modern, TS-native).
- Outgoing: alerts, 2FA-action proposals ("autopilot wants to CREATE bid at price X — please tap Confirm in Braiins
  within 15 min").
- Incoming commands: `/engage`, `/pause`, `/available`, `/status`. Webhook endpoint is a daemon HTTP route authenticated
  by Telegram's secret-token header.
- **Quiet-hours buffering**: messages with severity INFO/WARN go to the `alerts` table with `status=BUFFERED` during
  quiet hours; a wake-up job flushes them at `quiet_hours_end`.

## 7. Secrets and config

- **sops** with an **age** key. `age` chosen over GPG because it's single-file, no keyring faff, and easy to rotate.
- Decryption happens once at daemon startup. Decrypted values are held in memory; never re-written to disk; pino log
  redaction on `telegram_bot_token`, `braiins_owner_token`, `bitcoind_rpc_password`.
- The age private key is held on the always-on box at a fixed path with chmod 600; operator responsible for a backup (
  printed / encrypted USB).
- Live tunables (non-secret) live in SQLite `config` table, editable via the dashboard and via `/config` HTTP route.
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

Port 3000 binds to `127.0.0.1` — the operator reaches it over Tailscale MagicDNS / a LAN hostname, not the wider
network. Any remote access goes through the existing Tailscale setup on the box.

For operators who prefer no Docker: a `systemd/braiins-autopilot.service` unit file that runs
`node packages/daemon/dist/index.js` works the same way. TBD to provide both.

## 9. Observability

- **Structured logs** via pino, stdout + rotated file under `data/logs/`. Fields: `level`, `ts`, `tick_id`, `run_mode`,
  `action_mode`, `request_id` (on API-bound events).
- **Secret redaction** via pino's built-in redaction paths.
- **Metrics** (optional v1.1): expose `/metrics` via `prom-client` with basic counters (`ticks_total`,
  `api_calls_total{endpoint,status}`, `rewards_detected_sat_total`, `spend_sat_total`). Not wired into anything external
  in v1 — scrapers are a future add.
- **Health**: `/healthz` returns 200 + compact JSON of current run mode, action mode, last successful API/RPC
  timestamps.

## 10. Development and testing

- **Build**: `pnpm -r build` (tsc in each package; Vite build for dashboard).
- **Type check**: `pnpm -r typecheck` (tsc --noEmit).
- **Lint**: ESLint + Prettier. Strict TS config (`noUncheckedIndexedAccess`, `strict`, `exactOptionalPropertyTypes`).
- **Unit tests** (vitest): focused on pure modules — `decide()`, `gate()`, unit conversions, cooldown logic. These
  should be easy to cover to >90%.
- **Integration tests**: a Braiins client that hits a mocked server (MSW-node) — verifies error decoding, cooldown
  tracking, tag/ownership tracking.
- **End-to-end**: a `docker-compose.e2e.yml` that runs the daemon against a mock Braiins server and a bitcoind-mock.
  Runs one full tick cycle under DRY-RUN. Not required for v1 to ship; required to keep green in v1.1.
- **Manual "first real run" checklist** in `docs/first-run.md` (to be written): verify Datum Gateway reachability,
  verify owner token with a read-only call, verify Telegram bot can send a test message, read `/v1/spot/settings`,
  compute cooldown values, set initial config, keep DRY-RUN for the first 24h, observe decisions match operator
  intuition, only then engage LIVE.

## 11. Milestone-ordered build plan

**M1 — Skeleton and Braiins read path (~1 day)**

1. Repo scaffold (pnpm workspaces, tsconfig, prettier, eslint, vitest).
2. `shared` types + unit conversions (with tests).
3. `braiins-client` with `openapi.yml` codegen. Implement GET endpoints only: stats, orderbook, settings, fee, balance,
   bid/current, bid/detail.
4. Smoke test: call `/v1/spot/stats` (public), print to console.

**M2 — SQLite, config loader, secrets (~0.5 day)**

1. `state/db.ts` + first migration with the schema in §5.
2. sops integration via `sops-age` Node binding or shelling out to `sops` CLI.
3. Config Zod schema + validation on read.
4. CLI to seed initial config and create the age key.

**M3 — Control loop skeleton in DRY-RUN (~1 day)**

1. `observe()` — reads Braiins + bitcoind + pool + DB into a single `State` object.
2. `decide()` — first version: computes `target_price = min(max_price, best_ask + 1 tick)`. Emits a `CREATE` proposal if
   no owned bids, an `EDIT_PRICE` proposal if we're overpaying, a `CANCEL` if we'd place a bid below floor at emergency
   cap.
3. `gate()` — implements the mutation-gate rule from SPEC §7.3.
4. `execute()` — in DRY-RUN, writes proposals to `decisions` table; no API calls.
5. Wire up a tick driver and graceful shutdown.
6. Unit tests on `decide()` + `gate()` cover SPEC §9 escalation ladder cases.

**M4 — Live execution with ownership tracking (~0.5 day)**

1. `execute()` — real POST/PUT/DELETE calls, subject to gate.
2. `owned_bids` ledger writes on create; reconcile on every observe.
3. Unknown-order detection → auto-PAUSE.
4. Integration tests with mocked Braiins server cover happy path + cooldown + 429 backoff.

**M5 — Dashboard shell (~1 day)**

1. Vite + React + router + TanStack Query.
2. Fastify static serving + API routes for `/config`, `/status`, `/decisions`, `/orders`.
3. Pages: Status (run mode controls, live numbers), Config (Zod-form), Decisions (table), Orders (table of owned bids).
4. Shared-password auth middleware.

**M6 — Accounting + bitcoind payout observation (~0.5 day)**

1. `bitcoind-client` reward observation with watch-only descriptor.
2. Hourly reconciliation job in the daemon.
3. Accounting page on dashboard (monthly spend, monthly income, net).

**M7 — Telegram bot + quiet hours + operator availability (~1 day)**

1. grammy bot wiring: outbound send, inbound webhook handler.
2. Action-mode state machine in `gate()`: QUIET_HOURS, PENDING_CONFIRMATION, CONFIRMATION_TIMEOUT.
3. Commands: `/engage`, `/pause`, `/available`, `/status`.
4. Alert buffering during quiet hours; wake-up flush.

**M8 — Operational hardening (~0.5 day)**

1. Pool reachability check (TCP probe on :23334) + blip tolerance.
2. Dynamic-IP detection + alert.
3. Fee-schedule change detection + alert.
4. Stale-work / low-acceptance alert based on delivery counters.
5. First-run checklist in `docs/first-run.md`.

**M9 — Packaging (~0.5 day)**

1. `Dockerfile` multi-stage build (deps → build → runtime).
2. `docker-compose.yml`.
3. `README.md` with 5-minute setup.
4. systemd unit file as alternative.

Total rough estimate: **6–7 days of focused work** for a feature-complete v1. Compression is possible by deferring M6 (
accounting) to v1.1 if pain tolerance for "no P&L yet" is OK for the first couple weeks.

## 12. Risk register

| Risk                                           | Mitigation                                                                                                            |
|------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Braiins API shape changes during beta          | Pin `openapi.yml` version in repo; CI check: regenerate and diff; alert on breaking change.                           |
| 2FA window shorter than assumed                | Empirical probe on first live run; dashboard shows countdown; CONFIRMATION_TIMEOUT default is a floor, not a ceiling. |
| sops/age key lost                              | Operator backup responsibility, documented in README. Daemon refuses to start without decryption key — fail closed.   |
| bitcoind RPC unreachable from LAN box          | Reconciliation pass also covers restart catch-up; alert after N minutes of RPC failure.                               |
| Dashboard password leak on LAN                 | Tailscale is the real perimeter; password is a second-gate, not a first-line.                                         |
| SQLite corruption                              | WAL mode, automatic backup to `data/backups/state-<ts>.db` on each daemon startup.                                    |
| "First ever bid" produces a bug that loses BTC | DRY-RUN at startup by design; operator holds the engage button the first time.                                        |

## 13. Open implementation questions

These are genuinely undecided and worth calling out rather than pretending they're settled:

- **Docker vs bare systemd as the "default" deploy path.** Docker is more portable and easier to describe in a README;
  systemd is lighter. Current lean: Docker-first, systemd as a documented alternative.
- **Whether to expose `/metrics`** in v1 or defer to v1.1. Current lean: defer; add once there's a scraper to consume
  it.
- **ZMQ vs polling-only for bitcoind**. ZMQ is nicer but requires Umbrel to expose the ZMQ port. Polling is always
  available. Current lean: polling first; add ZMQ as an optional speedup.
- **Whether the control loop tick should self-adjust cadence** (e.g. shorter during handover window, longer during
  steady state) or stay at a fixed 60s. Current lean: fixed 60s for v1 simplicity; tune once we have live data on API
  rate limits.
- **How to version the config schema** once the product starts evolving (migrations on load, or versioned rows). Current
  lean: single-row `config` table + explicit `schema_version` column; migrations bump version and rewrite the row.

## Document history

| Version | Date       | Changes         |
|---------|------------|-----------------|
| 1.0     | 2026-04-14 | Initial version |