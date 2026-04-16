# Hashrate Autopilot

A personal-scale autopilot and monitor for the [Braiins Hashpower marketplace](https://hashpower.braiins.com/).
Keeps your rented-hashrate orders continuously active and cost-optimized within a tolerance you control, so purchased
hashrate keeps landing at your own Datum-connected pool without manual babysitting.

> **Status: pre-alpha.** Under active development. The spec is stable; the implementation is not. Do not run this
> against a funded Braiins account yet.

## Why this exists

The Braiins Hashpower marketplace works well, but orders cancel overnight, prices move, and filling a gap means
catching a 2FA prompt in Telegram before it expires. The common failure mode for a home miner is: "orders cancelled at
03:00, zero hashing until I woke up." This project replaces the 3 AM alarm with a controller that decides, prepares,
and — when a human tap is genuinely required — asks once, at a reasonable hour, through Telegram.

The goal is **bounded, observable downtime** with an explicit recovery policy, not gapless uptime.

## Scope

**v1 (current):** Braiins Hashpower marketplace only. Single operator. Single always-on host on a home LAN alongside an
Umbrel Bitcoin node running [Ocean](https://ocean.xyz/) with a Datum Gateway.

**v2 (aspirational):** Multi-market abstraction so additional hashrate marketplaces can be plugged in behind the same
controller and dashboard.

Non-goals (v1): SaaS / multi-user, cloud deployment, hands-free wallet funding, 2FA bypass, gapless uptime.

## How it works (short version)

- A Node daemon runs a periodic control loop: reads Braiins state, reads `bitcoind` RPC for payout observation,
  decides whether to create / edit / cancel bids.
- **Cancels are fully autonomous** (no 2FA on Braiins' side).
- **Creates and edits are 2FA-gated**: the daemon prepares them, asks the operator via Telegram, and only fires on
  confirmation. Actions deferred inside operator-configured quiet hours get re-evaluated when the window ends (freshly
  computed — never blind-replayed).
- A React dashboard binds to LAN only, shows current state, pending confirmations, and an operator-availability
  toggle.
- State, ledger, and deferred decisions persist to SQLite and survive restarts. **Run mode always boots into DRY-RUN**;
  promotion to LIVE is a deliberate operator action.

Full design: [`docs/spec.md`](docs/spec.md) · [`docs/architecture.md`](docs/architecture.md) ·
[`docs/research.md`](docs/research.md).

## Tech stack

TypeScript monorepo (pnpm workspaces), Node 22+, React dashboard, SQLite (better-sqlite3), sops-encrypted secrets.

```
packages/
├── braiins-client   # typed client for the Braiins Hashpower REST API
├── daemon           # control loop, ledger, Telegram gate, persistence
├── dashboard        # React UI (LAN-only)
└── shared           # shared types and utilities
```

## Prerequisites

- Node.js 22+ and `pnpm` 10+
- A Braiins account with API tokens (one **owner** token, one **read-only** token)
- A Telegram bot configured with `@BraiinsBotOfficial` for 2FA taps
- A running `bitcoind` (Umbrel or otherwise) reachable on the LAN
- An Ocean pool account with a Datum Gateway running locally
- `sops` + `age` for encrypted secrets

## Getting started

Implementation is in progress; a step-by-step runbook will land here once the first end-to-end path works. Until then,
see [`docs/spec.md`](docs/spec.md) for the full picture.

## Roadmap

- [x] Spec, research, architecture drafted
- [ ] Braiins REST client with full-coverage smoke test
- [ ] Control-loop daemon with DRY-RUN decisioning
- [ ] Dashboard (LAN)
- [ ] Telegram 2FA gate + deferred-decisions queue
- [ ] Ledger + `bitcoind`-based payout observation
- [ ] LIVE mode with the full mutation-gate state machine
- [ ] (v2) Second marketplace adapter

## Disclaimer

This is an independent, unofficial project. **Not affiliated with, endorsed by, or supported by Braiins Systems s.r.o.**
"Braiins" and "Braiins Hashpower" are trademarks of their respective owners and are used here only to identify the
marketplace this tool interacts with.

Using this software to automate real trades involves real money and real counterparties. You are responsible for your
own funds, your own API keys, and the legal status of hashrate trading in your jurisdiction.

## License

MIT — see [`LICENSE`](LICENSE).
