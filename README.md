# Hashrate Autopilot

A personal-scale autopilot and monitor for the [Braiins Hashpower marketplace](https://hashpower.braiins.com/).
Keeps your rented-hashrate orders continuously active and cost-optimized within a tolerance you control, so purchased
hashrate keeps landing at your own Datum-connected pool without manual babysitting.

> **Status: pre-alpha.** Under active development. The spec is stable; the implementation is not. Do not run this
> against a funded Braiins account yet.

## Why this exists

The Braiins Hashpower marketplace works well, but orders cancel overnight, prices move, and fills thrash when bids are
undersized. The common failure mode for a home miner is: "orders cancelled at 03:00, zero hashing until I woke up."
This project replaces the 3 AM alarm with a controller that quietly holds a bid alive at a price the operator is
comfortable with, and escalates only when genuinely needed.

The goal is **bounded, observable downtime** with an explicit recovery policy, not gapless uptime.

## Scope

**v1 (current):** Braiins Hashpower marketplace only. Single operator. Single always-on host on a home LAN alongside an
Umbrel Bitcoin node running [Ocean](https://ocean.xyz/) with a Datum Gateway.

**v2 (aspirational):** Multi-market abstraction so additional hashrate marketplaces can be plugged in behind the same
controller and dashboard.

Non-goals (v1): SaaS / multi-user, cloud deployment, hands-free wallet funding, gapless uptime.

## How it works (short version)

- A Node daemon runs a periodic control loop: reads Braiins state, reads `bitcoind` (or Electrs) for on-chain payout
  observation, decides whether to create / edit / cancel bids.
- **All three actions (create / edit / cancel) are fully autonomous.** Empirical finding: an owner-scope API token
  authorises `POST /spot/bid` and `PUT /spot/bid` directly — the 2FA prompt that appears in Braiins' web UI does
  *not* gate the API path. The autopilot therefore has a single mutation gate (DRY-RUN vs LIVE vs PAUSED) rather
  than a separate human-in-the-loop confirmation layer.
- A React dashboard binds to LAN only, shows current state, live decisions, the hashrate chart, config, and operator
  overrides.
- State, ledger, and tick metrics persist to SQLite and survive restarts. **Run mode always boots into DRY-RUN**;
  promotion to LIVE is a deliberate operator action.

Full design: [`docs/spec.md`](docs/spec.md) · [`docs/architecture.md`](docs/architecture.md) ·
[`docs/research.md`](docs/research.md).

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
- A running `bitcoind` (Umbrel or otherwise) reachable on the LAN, or an Electrs endpoint for faster balance lookups
- An Ocean pool account with a Datum Gateway running locally, and a BTC payout address configured as the worker
  identity (`<btc-address>.<worker-label>` — Ocean credits shares by address, not by label)
- `sops` + `age` for encrypted secrets

## Getting started

Implementation is in progress; a step-by-step runbook will land here once the first end-to-end path works. Until then,
see [`docs/spec.md`](docs/spec.md) for the full picture.

## Roadmap

- [x] Spec, research, architecture drafted
- [x] Braiins REST client with full-coverage smoke test
- [x] Control-loop daemon with DRY-RUN decisioning
- [x] Dashboard (LAN)
- [x] Ledger + `bitcoind` / Electrs-based payout observation
- [x] LIVE mode with the mutation gate (RUN_MODE + PAUSE)
- [ ] Operator-initiated cancel / recreate from the dashboard (#2)
- [ ] i18n for the dashboard (#1)
- [ ] (v2) Second marketplace adapter

## Disclaimer

This is an independent, unofficial project. **Not affiliated with, endorsed by, or supported by Braiins Systems s.r.o.**
"Braiins" and "Braiins Hashpower" are trademarks of their respective owners and are used here only to identify the
marketplace this tool interacts with.

Using this software to automate real trades involves real money and real counterparties. You are responsible for your
own funds, your own API keys, and the legal status of hashrate trading in your jurisdiction.

## License

MIT — see [`LICENSE`](LICENSE).
