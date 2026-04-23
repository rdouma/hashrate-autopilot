# Hashrate Autopilot

A personal-scale autopilot and monitor for the [Braiins Hashpower marketplace](https://hashpower.braiins.com/).
Keeps a rented-hashrate bid continuously alive at an operator-chosen price ceiling, so purchased hashrate keeps
landing at your own Datum-connected pool without manual babysitting.

![Dashboard in real-time mode](docs/images/dashboard.jpg)

The Status page is a single scroll: a hero card with the **effective rate** (the clearing price actually paid,
derived from measured spend ÷ delivered hashrate) and its delta versus hashprice, the delivered-hashrate number,
and the DRY-RUN / LIVE / PAUSED switch on the left; the Next Action panel on the right explaining what the
autopilot is about to do and when. Below that sit range-selectable hashrate and price charts overlayed with bid
events and block markers, a stats strip (uptime, avg hashrate per source — Braiins / Datum / Ocean side-by-side,
cost per PH delivered, effective rate vs hashprice), service panels for Braiins / Datum Gateway / Ocean, the
active bids table, and per-day and lifetime P&L measured from actual account-ledger spend and on-chain receipts.

## Why this exists

The Braiins Hashpower marketplace works well, but bids cancel when the wallet drains, prices move, and fills stop
the moment a bid sits below the clearing ask. The common failure mode for a home miner is: wake up and discover
that the order cancelled hours ago and you've been sitting at zero hashrate since. This project replaces that with
a controller that quietly holds a bid alive at a price ceiling the operator is comfortable with.

The goal is **bounded, observable downtime** with an explicit recovery policy, not gapless uptime.

## How Braiins matches (the premise this tool is built on)

Braiins is a **continuous limit order book** — matching is cheapest-ask-first, regardless of what you bid.
Your bid is a **matching-access ceiling**, not the price you pay: if any ask sits at or below your bid, you
match and pay that ask's price (the clearing price). Bidding higher doesn't cost more per EH·day — it just
widens the set of asks you're eligible to match.

This was verified empirically against closed-bid data (`scripts/verify-pricing-model.ts`) and the market-mechanics
conclusion drives the controller design: there is no cost penalty for sitting at a generous ceiling. The only
reasons to cap at all are (a) wallet runway — lower ceilings burn funds slower when the clearing price spikes,
and (b) to opt out of pathologically expensive market conditions entirely.

## Scope

**v1 (current):** Braiins Hashpower marketplace only. Single operator. Single always-on host on a home LAN
alongside an Umbrel Bitcoin node running [Ocean](https://ocean.xyz/) with a Datum Gateway.

**v2 (aspirational):** Multi-market abstraction so additional hashrate marketplaces can be plugged in behind the
same controller and dashboard.

Non-goals (v1): SaaS / multi-user, cloud deployment, hands-free wallet funding, gapless uptime.

## How it works

- A Node daemon runs a periodic control loop (default 60 s): reads Braiins marketplace state, compares it against
  the operator's configured target and ceiling, and decides whether to create, edit, or cancel a single bid.
- Steady state is **one bid held at the effective ceiling** — `min(max_bid, hashprice + max_overpay_vs_hashprice)`.
  Because matching is cheapest-first, the bid clears at whatever ask is on top and delivery flows onto the next
  level automatically when the cheap one drains. No escalation ladder, no overpay knob, no patience timers — those
  were retired in the CLOB redesign.
- **All three mutations (create / edit / cancel) are fully autonomous.** An owner-scope API token authorises
  `POST /spot/bid` and `PUT /spot/bid` directly — the 2FA prompt that appears in Braiins' web UI does *not* gate
  the API path. The autopilot therefore has a single mutation gate (DRY-RUN vs LIVE vs PAUSED) rather than a
  separate human-in-the-loop confirmation layer.
- A React dashboard binds to the LAN, shows current state, live decisions, charts, and operator overrides.
- State and tick metrics persist to SQLite and survive restarts. Boot mode is configurable: always dry-run
  (default), resume last mode, or always live. Old `tick_metrics` and uneventful `decisions` rows are pruned
  hourly per configurable retention windows.
- Each tick also polls the **Ocean pool API** (hashprice, pool stats, payout estimate, recent blocks) and — when
  a `datum_api_url` is configured — the **Datum Gateway's `/umbrel-api`** for a second hashrate reading measured
  at the gateway. Both integrations are informational; the control loop never depends on them being reachable.
- Optionally reads `bitcoind` or Electrs for on-chain payout observation (income tracking, runway calculation).

Full design: [`docs/spec.md`](docs/spec.md) · [`docs/architecture.md`](docs/architecture.md) ·
[`docs/research.md`](docs/research.md).

## Key features

- **Two-layer price ceiling** — a fixed `max_bid_sat_per_eh_day` plus an optional dynamic cap
  `max_overpay_vs_hashprice_sat_per_eh_day`. The effective ceiling per tick is the lower of the two — stops the
  autopilot matching when hashprice crashes but the fixed max still allows it. Under CLOB this is the only
  pricing knob that matters: it's the threshold at which the bid opts out of the market entirely.
- **Effective rate as a first-class metric** — the price actually paid is measured from per-tick spend (Braiins
  account ledger deltas) divided by delivered hashrate × elapsed time, and plotted on the price chart next to
  the bid line and hashprice. Gives the operator a direct read on the clearing price rather than a model of it.
- **Cheap-mode opportunistic scaling** — when the market price (best ask) drops below a configurable percentage
  of the break-even hashprice, the autopilot scales the target up to `cheap_target_hashrate_ph` to capture cheap
  capacity. Reverts to the normal target when the market recovers.
- **Ocean pool integration** — reads hashprice, pool earnings, time-to-payout, Ocean-credited hashrate, and
  recent pool blocks from the Ocean API. Hashprice is plotted historically on the price chart. Ocean-credited
  hashrate is a first-class line on the Hashrate chart alongside Braiins-delivered and Datum-received. Every
  TIDES-credited pool block appears on the hashrate chart as an isometric cube marker — **blue** for the common
  case (pool block credited via TIDES) and **gold** for the rare solo-lottery case where our own worker found
  the block. Clicking a cube opens it in your configured block explorer (mempool.space by default; blockstream /
  blockchair / your own local explorer are preset pills on the Config page). Tooltips show block height, reward /
  subsidy / fees, and an estimated our-share for the block based on the current share_log.
- **Datum Gateway integration (optional)** — when `datum_api_url` is configured, the daemon polls Datum's
  `/umbrel-api` each tick and records the gateway-measured hashrate alongside the Braiins-reported number. A
  sustained gap means Braiins is billing for hashrate the gateway never saw. See
  [`docs/setup-datum-api.md`](docs/setup-datum-api.md) — on Umbrel the API port is not exposed by default and
  needs a one-line compose edit plus a full OS reboot (tested and stable since 2026-04-19).
- **Measured P&L and runway** — spend is read from Braiins' account transaction ledger (settled cost, not
  modelled bid × delivered) and income from on-chain payouts observed via Electrs or bitcoind. Runway on the
  Braiins service card is days-of-balance at the current measured spend rate.
- **Dashboard** — hashrate and price charts with time-range picker (3h / 6h / 12h / 24h / 1w / 1m / 1y / all),
  bid event markers, block markers, pinned-tooltip JSON export, stats bar (uptime, three side-by-side
  avg-hashrate cards for Braiins / Datum / Ocean, and cost metrics), service panels that include a runway
  forecast on the Braiins card, split P&L panels (period and lifetime), live bid table with full IDs, and a
  full config editor with live reload.
- **BTC/USD denomination toggle** — all prices and balances can be viewed in sats or USD using a live BTC price
  oracle (CoinGecko, Coinbase, Bitstamp, or Kraken).
- **Operator overrides** — pause/resume, switch between dry-run and live, or trigger an immediate decision tick
  from the dashboard.

## Configuration

Everything that influences the controller — hashrate targets, price ceilings, cheap-mode thresholds, per-bid
budget, boot mode, payout-source backend, retention windows, the optional Datum and Ocean endpoints — is
live-editable from the Config page. Values are validated against the same Zod schema the daemon uses at startup;
Save writes the new row and the next tick picks it up. No daemon restart needed for any value on this page.

![Configuration page — all tunables in one place](docs/images/config.jpg)

Sections map directly to the spec: **Hashrate targets** (target, floor, and the cheap-mode scale-up), **Pool
destination** (pool URL, worker identity, Datum stats API URL), **Pricing ceiling** (fixed `max_bid` plus the
optional dynamic `max_overpay_vs_hashprice`), **Budget** (per-bid `amount_sat`; set to 0 to use the full
available wallet balance on each `CREATE_BID`, clamped to Braiins' 1 BTC per-bid cap), **Daemon startup** (boot
mode — always dry-run / resume last / always live), **Block explorer** (template used by the block-marker cubes
and the Ocean panel's last-pool-block link), **On-chain payouts** (payout address + Electrs-or-bitcoind
backend), **Profit & Loss** spend scope, **BTC price oracle** (feeds the sat↔USD toggle), **Chart smoothing**
(rolling-mean window applied to each hashrate series), and **Log retention** for the append-only `tick_metrics`
and `decisions` tables.

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

- Node.js 22+ and `pnpm` 10+ (install commands below — neither is in Ubuntu's default apt repos at the right version)
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

### Installing Node + pnpm

On **Ubuntu / Debian** (tested on Ubuntu 22.04 and Raspberry Pi OS) the default apt `nodejs` is too old and
`pnpm` isn't packaged at all. Grab Node 22 from NodeSource, then use `corepack` (bundled with Node) to
activate `pnpm`:

```bash
# Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm via corepack (no separate install needed)
sudo corepack enable
corepack prepare pnpm@latest --activate
```

Verify with `node -v` (≥ v22) and `pnpm -v` (≥ 10).

On **macOS** (Homebrew):

```bash
brew install node pnpm
```

### Installing sops + age

Required before `pnpm run setup` — it shells out to both.

On **Ubuntu / Debian**:

```bash
sudo apt install -y age

# sops isn't in apt. Releases are version-named, so resolve the latest tag
# from GitHub's /latest redirect, then download the matching .deb. On arm64
# (Raspberry Pi) replace `amd64` with `arm64`.
SOPS_VER=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/getsops/sops/releases/latest | sed 's|.*/||')
curl -fsSL "https://github.com/getsops/sops/releases/download/${SOPS_VER}/sops_${SOPS_VER#v}_amd64.deb" -o /tmp/sops.deb
sudo apt install -y /tmp/sops.deb
sops --version
```

On **macOS**:

```bash
brew install age sops
```

## Getting started

```bash
git clone https://github.com/rdouma/hashrate-autopilot && cd hashrate-autopilot
pnpm install
pnpm build
pnpm run setup
```

`pnpm run setup` is the interactive first-run wizard — it generates an `age` key, writes the `sops` policy,
prompts for your Braiins tokens + core config, and initialises the SQLite database. Refuses to overwrite an
existing setup unless you pass `--force`. (Install `age` and `sops` first — see prerequisites above.)

> Use `pnpm run setup`, not `pnpm setup`. The bare `pnpm setup` is a pnpm built-in command that configures
> pnpm's own shell environment — it silently shadows any `setup` script in `package.json`. `pnpm run setup`
> disambiguates and invokes the wizard.

Then start the daemon:

```bash
./scripts/start.sh
```

`start.sh` backgrounds the process, writes its PID to `data/daemon.pid`, and appends stdout/stderr to
`data/logs/daemon.log`. Companion scripts: `scripts/stop.sh`, `scripts/restart.sh`, `scripts/status.sh`,
`scripts/logs.sh`. For a foreground run (e.g. debugging), use `pnpm -w run daemon` from the repo root.

The dashboard is served on **port 3010**, bound to `0.0.0.0` (all interfaces) by default — reachable from any
machine on the LAN as `http://<this-host>:3010` or `http://<lan-ip>:3010`. On first launch the daemon boots in
DRY-RUN mode — promote to LIVE from the dashboard when ready. Remaining configuration (target hashrate, caps,
payout source, etc.) is editable from the dashboard's Config page.

### Opening the port on the host firewall

Accessing the dashboard from another machine on the LAN requires the host firewall to allow inbound
connections on port 3010. Ubuntu ships with `ufw` present but inactive — check before assuming either way:

```bash
sudo ufw status verbose
```

If the output is `Status: inactive`, nothing is blocking you and no change is needed. If it's `Status: active`
and `3010/tcp` isn't in the ALLOW list:

```bash
sudo ufw allow 3010/tcp
sudo ufw reload
```

To verify from another box on the LAN:

```bash
nc -zv <host>.local 3010    # or the host's LAN IP
# → "succeeded" = port reachable; "timed out" / "refused" = firewall (or daemon not listening)
```

To change the port, set `HTTP_PORT=nnnn` in the daemon's environment; to bind only to loopback, set
`HTTP_HOST=127.0.0.1`.

### Manually editing secrets later

`pnpm run setup` covers the initial secrets file. If you need to re-edit it (rotate a token, add bitcoind
credentials, etc.), open it with `sops`:

```bash
SOPS_AGE_KEY_FILE=~/.config/braiins-hashrate/age.key sops .env.sops.yaml
```

The explicit `SOPS_AGE_KEY_FILE` is only needed if you don't have the key at the default sops location
(`~/.config/sops/age/keys.txt`) — `pnpm run setup` writes it to `~/.config/braiins-hashrate/age.key` by design, so
this project's key stays separate from any other sops-encrypted project on the same host.

### Running on a second host (or migrating)

`.env.sops.yaml` is **not** in the repo — it's generated locally by `pnpm run setup` and gitignored. Each host
the operator stands up gets its own. Two ways to bring up a second host:

1. **Fresh setup on the new host** (simplest — recommended): clone the repo, `pnpm install && pnpm build &&
   pnpm run setup`, re-enter your tokens. Produces a brand-new age key and a fresh `.env.sops.yaml`. The two
   hosts now have independent encrypted envelopes against independent keys.
2. **Copy the whole secret bundle over** (one key, shared state): scp both
   `~/.config/braiins-hashrate/age.key` *and* `.env.sops.yaml` from the origin host onto the target. Then the
   daemon on the new host will decrypt the same secrets without needing to re-run setup. `chmod 600` the age
   key after the copy.

See [`docs/spec.md`](docs/spec.md) for the full design and [`docs/architecture.md`](docs/architecture.md) for
deployment details.

## Updating a running deployment

`scripts/deploy.sh` is the one-shot updater for a machine that already has the repo checked out and the daemon
running. It pulls `main`, reinstalls pinned deps, builds, runs the tests, and only then restarts the daemon —
so a broken commit won't take your running autopilot down with it.

```bash
./scripts/deploy.sh
```

Safe to run while the daemon is live; the restart happens after the build + tests succeed. No state loss —
`data/state.db` is untouched across restarts.

Common patterns:

- **Manual update** after you see a new release or commit you want: just run it.
- **Nightly cron** (fully hands-off): `0 4 * * * cd /path/to/hashrate-autopilot && ./scripts/deploy.sh >> ~/deploy.log 2>&1`

The script does a `git pull --ff-only` internally, so it only runs on a tracking branch (e.g. `main`). If you'd
rather pin to a tagged release, manage the checkout manually (`git fetch --tags && git checkout v1.0.1 && pnpm
install && pnpm build && ./scripts/restart.sh`) — deploy.sh will fail on a detached HEAD, which is safer than
silently moving you off the pin.

## Disclaimer

This is an independent, unofficial project. **Not affiliated with, endorsed by, or supported by Braiins Systems s.r.o.**
"Braiins" and "Braiins Hashpower" are trademarks of their respective owners and are used here only to identify the
marketplace this tool interacts with.

Using this software to automate real trades involves real money and real counterparties. You are responsible for your
own funds, your own API keys, and the legal status of hashrate trading in your jurisdiction.

## License

MIT — see [`LICENSE`](LICENSE).
