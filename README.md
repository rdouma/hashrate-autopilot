# Hashrate Autopilot

A personal-scale autopilot and monitor for the [Braiins Hashpower marketplace](https://hashpower.braiins.com/).
Keeps your rented-hashrate orders continuously active and cost-optimized within a tolerance you control, so purchased
hashrate keeps landing at your own Datum-connected pool without manual babysitting.

## Why this exists

The Braiins Hashpower marketplace works well, but orders cancel overnight, prices move, and fills thrash when bids are
undersized. The common failure mode for a home miner is: wake up and discover that the order cancelled hours ago and
you've been sitting at zero hashrate since. This project replaces that with a controller that quietly holds a bid alive
at a price the operator is comfortable with, and escalates only when genuinely needed.

The goal is **bounded, observable downtime** with an explicit recovery policy, not gapless uptime.

## Scope

**v1 (current):** Braiins Hashpower marketplace only. Single operator. Single always-on host on a home LAN alongside an
Umbrel Bitcoin node running [Ocean](https://ocean.xyz/) with a Datum Gateway.

**v2 (aspirational):** Multi-market abstraction so additional hashrate marketplaces can be plugged in behind the same
controller and dashboard.

Non-goals (v1): SaaS / multi-user, cloud deployment, hands-free wallet funding, gapless uptime.

## How it works

- A Node daemon runs a periodic control loop (default 60 s): reads Braiins marketplace state, compares it against the
  operator's configured targets, and decides whether to create, edit, or cancel bids.
- **All three actions are fully autonomous.** An owner-scope API token authorises `POST /spot/bid` and `PUT /spot/bid`
  directly — the 2FA prompt that appears in Braiins' web UI does *not* gate the API path. The autopilot therefore has a
  single mutation gate (DRY-RUN vs LIVE vs PAUSED) rather than a separate human-in-the-loop confirmation layer.
- A React dashboard binds to the LAN, shows current state, live decisions, charts, and operator overrides.
- State and tick metrics persist to SQLite and survive restarts. Boot mode is configurable: always dry-run (default),
  resume last mode, or always live. Old `tick_metrics` and uneventful `decisions` rows are pruned hourly per
  configurable retention windows.
- Each tick also polls the **Ocean pool API** (hashprice, pool stats, payout estimate, recent blocks) and — when a
  `datum_api_url` is configured — the **Datum Gateway's `/umbrel-api`** for a second hashrate reading measured at the
  gateway. Both integrations are informational; the control loop never depends on them being reachable.
- Optionally reads `bitcoind` or Electrs for on-chain payout observation (income tracking, runway calculation).

Full design: [`docs/spec.md`](docs/spec.md) · [`docs/architecture.md`](docs/architecture.md) ·
[`docs/research.md`](docs/research.md).

## Key features

- **Depth-aware pricing** — walks the order book to find the cheapest ask that can actually fill your target capacity,
  not just the top-of-book price.
- **Escalation ladder** — when hashrate drops below your configured floor, the autopilot raises the bid in steps (or
  jumps, selectable) up to your max, then holds. Lowers again when the market softens, with a configurable
  patience window (`lower_patience_minutes`) to avoid chasing transient dips that reverse before the Braiins 10-min
  price-decrease cooldown expires.
- **Two-layer price ceiling** — a fixed `max_bid_sat_per_eh_day` plus an optional dynamic cap
  `max_overpay_vs_hashprice_sat_per_eh_day`. When both are set the effective cap per tick is the lower of the two —
  stops the autopilot overpaying when hashprice crashes but the fixed max still allows it.
- **Cheap-mode scaling** — when the market price drops below a threshold relative to hashprice (break-even), the
  autopilot can automatically scale up to a higher target to capture cheap capacity.
- **Ocean pool integration** — reads hashprice, pool earnings, time-to-payout, and recent blocks (including ones found
  by your own share stream) from the Ocean API. Hashprice is plotted historically on the price chart; blocks that
  Ocean flags as found by this payout address appear as gold markers on the hashrate chart.
- **Datum Gateway integration (optional)** — when `datum_api_url` is configured, the daemon polls Datum's
  `/umbrel-api` each tick and records the gateway-measured hashrate alongside the Braiins-reported number. A
  sustained gap means Braiins is billing for hashrate the gateway never saw. See
  [`docs/setup-datum-api.md`](docs/setup-datum-api.md) — on Umbrel the API port is not exposed by default and needs a
  one-line compose edit plus a full OS reboot (tested and stable since 2026-04-19).
- **What-if simulator** — replays historical `tick_metrics` against a candidate set of strategy parameters and shows
  the simulated uptime, cost, P&L, and tick-by-tick price trace overlaid on the live charts. Lets you backtest a new
  max-bid / overpay / patience setting against real recent market conditions before committing to it.
- **Dashboard** — hashrate and price charts with time-range picker, bid event markers, pinned-tooltip JSON export,
  stats bar (uptime, avg hashrate — Braiins and Datum side-by-side when Datum is on, cost metrics, mutation count),
  split P&L panels (period and lifetime), live bid table with full IDs, and a full config editor with live reload.
- **BTC/USD denomination toggle** — all prices and balances can be viewed in sats or USD using a live BTC price oracle
  (CoinGecko, Coinbase, Bitstamp, or Kraken).
- **Operator overrides** — bump price, trigger an immediate decision tick (bypasses the patience window for one
  tick), pause/resume, or switch between dry-run and live from the dashboard.

## Tech stack

TypeScript monorepo (pnpm workspaces), Node 22+, React dashboard, SQLite (better-sqlite3), sops-encrypted secrets.

```
packages/
├── braiins-client   # typed client for the Braiins Hashpower REST API
├── bitcoind-client  # minimal bitcoind RPC client for on-chain payout observation
├── daemon           # control loop, gate, ledger, HTTP API, persistence
├── dashboard        # React UI (LAN-only)
└── shared           # shared types and utilities
```

## Prerequisites

- Node.js 22+ and `pnpm` 10+
- A Braiins account with API tokens (one **owner** token, and optionally a read-only token)
- An Ocean pool account with a Datum Gateway running locally (stratum port 23334), and a BTC payout address
  configured as the worker identity (`<btc-address>.<worker-label>` — Ocean credits shares by address, not by label)
- *(Optional but recommended)* The Datum Gateway HTTP API exposed on your LAN for the dashboard's second-source
  hashrate panel. On Umbrel this is a one-line `docker-compose.yml` edit plus a full OS reboot —
  see [`docs/setup-datum-api.md`](docs/setup-datum-api.md) for the verified recipe and the landmines to avoid
  (do **not** use `umbreld apps.restart.mutate` — it wedged the Umbrel box on our first live attempt; the dashboard
  Restart button or a cold-boot is fine and has run uninterrupted since).
- `sops` + `age` for encrypted secrets (API tokens, optional bitcoind credentials)
- *(Optional)* A running `bitcoind` or Electrs endpoint for on-chain payout tracking

## Getting started

```bash
git clone <repo-url> && cd hashrate-autopilot
pnpm install
pnpm build
```

Configure secrets (Braiins API tokens) via `sops`. The daemon looks for `.env.sops.yaml`
in the project root (override with `SECRETS_PATH`):

```bash
sops .env.sops.yaml   # creates and encrypts with your age key
```

Edit the configuration through the dashboard settings page once the daemon is running, or seed it via the config API.

```bash
pnpm --filter @braiins-hashrate/daemon start
```

The dashboard is served at `http://<host>:3010`. On first launch the daemon boots in DRY-RUN mode — promote to LIVE
from the dashboard when ready.

See [`docs/spec.md`](docs/spec.md) for the full design and [`docs/architecture.md`](docs/architecture.md) for
deployment details.

## Disclaimer

This is an independent, unofficial project. **Not affiliated with, endorsed by, or supported by Braiins Systems s.r.o.**
"Braiins" and "Braiins Hashpower" are trademarks of their respective owners and are used here only to identify the
marketplace this tool interacts with.

Using this software to automate real trades involves real money and real counterparties. You are responsible for your
own funds, your own API keys, and the legal status of hashrate trading in your jurisdiction.

## License

MIT — see [`LICENSE`](LICENSE).
