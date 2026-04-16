# Hashrate Autopilot — Specification (v1.1)

> Status: post-empirical rewrite. v1.0 (2026-04-14) was built around a constraint — that Braiins requires 2FA on
> every `POST`/`PUT` on the Hashpower API — which empirical testing on a live account on 2026-04-15 disproved for
> the owner-scope API token. This version removes the confirmation bot, quiet-hours machinery,
> pending-confirmation / confirmation-timeout action modes, and operator-availability flag that constraint required,
> and describes the simpler fully-autonomous architecture now in the code.

## 1. Purpose

A personal-scale autopilot that keeps one user's orders on the **Braiins Hashpower marketplace** continuously active
and cost-optimized within the operator's tolerance, so purchased hashrate keeps landing at the user's Datum-connected
pool without manual babysitting. Replaces the current failure mode: "orders cancel overnight, zero hashing in the
morning."

The goal is **bounded, observable downtime** with an explicit recovery policy — not gapless uptime. Orders can be
cancelled by counterparties or go unfilled in an expensive market; the autopilot's job is to keep those events rare,
short, observable, and predictable.

**Empirically confirmed (v1.1):** an owner-scope Braiins API token authorises `POST /spot/bid`, `PUT /spot/bid`, and
`DELETE /spot/bid` directly. The 2FA prompt that Braiins' web UI shows for mutations does not apply to the REST
path with an owner-scope token. The autopilot is therefore a **fully autonomous controller** under the run-mode
gate (§7). No operator tap is required for any mutation.

## 2. Non-goals (v1)

- Multi-user / SaaS / commercial use.
- Multi-pool management (only one Datum-connected pool is targeted).
- Multi-market abstraction (Braiins only for v1; multi-market is an explicit v2 aspiration).
- Running in the cloud.
- Hands-free funding of the Braiins wallet (funding stays manual to preserve non-KYC posture).
- Gapless uptime.
- Handling post-beta non-zero fees beyond observing `/spot/fee` and surfacing changes as an alert.

## 3. Users

Exactly one: the operator, running this on a home always-on box alongside an Umbrel Bitcoin node.

## 4. Runtime environment

- **Host:** a dedicated always-on machine on the operator's LAN. Not the Umbrel node itself.
- **Network access required:** Braiins Hashpower API (internet egress — `hashpower.braiins.com`), Umbrel `bitcoind`
  RPC or Electrs endpoint (LAN), Datum Gateway endpoint (LAN, typically port 23334).
- **Persistence:** state, ledger, and tick history must survive host reboots. Run mode is deliberately *not* persisted
  — every boot lands in DRY-RUN (§7).
- **Secrets:** Braiins owner token (required) + optional read-only token, `bitcoind` RPC credentials, dashboard
  password, stored in a sops-encrypted file (age key). Decrypted at startup. Tokens must never appear in logs.
- **Dashboard access:** binds to LAN interface only. Remote access via operator's existing VPN/Tailscale. Shared
  password on the dashboard (VPN is the real perimeter).
- **Tech stack (locked):** TypeScript monorepo. Node daemon (control loop, API clients, ledger) + React dashboard +
  SQLite for persistent state.

## 5. Inputs (observable signals)

- Braiins API reads (read-only token sufficient for all of these):
    - Wallet balances: `GET /v1/account/balance`
    - Open bids: `GET /v1/spot/bid/current`
    - Per-bid delivery history: `GET /v1/spot/bid/delivery/{order_id}`
    - Per-bid speed history: `GET /v1/spot/bid/speed/{order_id}`
    - Market stats: `GET /v1/spot/stats`
    - Orderbook: `GET /v1/spot/orderbook`
    - OHLCV bars: `GET /v1/spot/bars`
    - Fees: `GET /v1/spot/fee`
    - Market settings: `GET /v1/spot/settings`
    - Transactions (on-chain + internal): `GET /v1/account/transactions`
- Block reward payouts observed via **Electrs** (preferred, instant lookups) or `bitcoind` RPC
  (`listreceivedbyaddress` / `gettransaction` / `scantxoutset` fallback) on the Umbrel node.
- Datum Gateway endpoint reachability (TCP connect health check, port 23334).
- User-editable configuration (see §8).
- Dashboard run-mode and manual-override signals.

## 6. Outputs (actions)

- `POST /v1/spot/bid` (**create**) — fully autonomous. Only for orders the autopilot will tag in its local ownership
  ledger.
- `PUT /v1/spot/bid` (**edit**) — fully autonomous. Respects the 1-price-decrease-per-10-minutes cooldown. Cannot
  change `dest_upstream.url` (Braiins rejects — see §13).
- `DELETE /v1/spot/bid` (**cancel**) — fully autonomous. The order ID is passed in the JSON body; the query-string
  form is rejected (empirical, see `docs/research.md` v1.1).
- Dashboard UI (LAN bind).
- No external notification channel in v1. Alerts and status are surfaced exclusively in the dashboard and the
  decisions log.

## 7. Run mode and the mutation gate

### 7.1 Run mode (operator-controlled)

- **DRY-RUN** — default at every startup. The autopilot observes state and computes what it *would* do, writing
  decisions to the log and dashboard. It does not call any mutating Braiins endpoint. Read-only API access continues.
  Operator promotes DRY-RUN → LIVE via a button in the dashboard.
- **LIVE** — the autopilot may execute create / edit / cancel.
- **PAUSED** — operator or controller-entered hard stop. No creates, edits, or cancels. Observation continues.
  Entered on: operator pause button, sustained pool outage, unknown-order ambiguity.

Run mode is **not** persisted across restarts: every boot lands in DRY-RUN. Rationale: first-run-after-crash is
exactly when inputs are most likely to be stale or inconsistent; human-in-the-loop at boot bounds blast radius.

### 7.2 The mutation-gate rule (single source of truth)

```
canMutate(action) =
  runMode == LIVE
  AND runMode != PAUSED
```

All three mutation kinds (create, edit, cancel) use the same rule. The implementation routes every mutating call
through this gate. Price-decrease cooldowns and other Braiins-side pacing rules are layered on top of the gate (see
`packages/daemon/src/controller/gate.ts`).

### 7.3 Manual overrides

Operator actions from the dashboard (bump-price, manual cancel, recreate-with-these-params) set a short-lived
`manual_override_until_ms` that suppresses autopilot `EDIT_PRICE` proposals on the affected bid so the controller
does not immediately undo the operator's intent on the next tick. Default window: `handover_window_minutes`.

## 8. Tunable configuration (live-editable from dashboard)

All values change on the next control-loop tick without restart.

**Hashrate targets:**

- `target_hashrate_ph`
- `minimum_floor_hashrate_ph`
- `destination_pool_url` — the Datum Gateway endpoint; **immutable on live bids** — if this changes, autopilot must
  cancel and recreate.
- `destination_pool_worker_name` — **must be `<btc-address>.<label>`.** Ocean TIDES credits rewards by the BTC address
  encoded in the identity, not by label; a bare label causes shares to be credited to no one. The setup CLI and
  dashboard config page validate this shape at write time.

**Pricing (unit: sat per EH/day, matching Braiins `price_sat` / `hr_unit = "EH/day"`):**

- `max_price_sat_per_eh_day` — normal cap for all target-hashrate orders
- `emergency_max_price_sat_per_eh_day` — higher cap applied **only** to floor-sized orders when §9 escalation fires

**Budget:**

- `monthly_budget_ceiling_sat` — absolute cap per calendar month
- `bid_budget_sat` — size of the `amount_sat` on each created bid (governs bid lifetime)
- `wallet_runway_alert_days`

**Outage tolerance — profile selector + individual overrides:**

Dashboard surfaces a single profile dropdown: **Aggressive / Regular / Relaxed / Custom**. Selecting a profile sets
the thresholds to a preset bundle. Editing any individual threshold switches the profile to Custom.

| Threshold                                 | Aggressive    | Regular | Relaxed (default) |
|-------------------------------------------|---------------|---------|-------------------|
| `below_floor_alert_after_minutes`         | 10            | 30      | 60                |
| `below_floor_emergency_cap_after_minutes` | 0 (immediate) | 60      | 240               |
| `zero_hashrate_loud_alert_after_minutes`  | 30            | 120     | 360               |

Plus (not profile-driven; set once, rarely tuned):

- `pool_outage_blip_tolerance_seconds` (default 120)
- `api_outage_alert_after_minutes` (default 15)

**Pricing strategy knobs (empirically tuned, v1.1):**

- `fill_escalation_step_sat_per_eh_day` — price bump when a bid sits unmatched past the escalation window.
- `fill_escalation_after_minutes` — window before an auto-bump.
- `max_overpay_vs_ask_sat_per_eh_day` — ceiling on how far above the cheapest available ask the autopilot will go.
- `overpay_before_lowering_sat_per_eh_day` — deadband; only auto-lower when current price exceeds target by this
  amount. Prevents real market drops from killing active fills (empirically observed as a live-thrash failure mode).
- `hibernate_on_expensive_market` — pause bidding rather than overpay when the market blows past the configured cap.
- `handover_window_minutes` — manual-override suppression window, and (optional) lead time to pre-place an
  overlapping successor bid before an active bid's estimated end.

**Integrations:**

- `btc_payout_address`
- `bitcoind_rpc_endpoint` + credentials
- Optional `electrs_host` + `electrs_port` (preferred over `bitcoind` RPC for balance lookups — instant)
- Braiins `owner_access_token` + optional `read_only_access_token`

## 9. Reliability & outage policy

**Hashrate below floor (escalation ladder):**

- Controller continuously attempts to maintain `target_hashrate_ph` at `max_price_sat_per_eh_day`.
- If actual hashrate drops below `minimum_floor_hashrate_ph`: start a timer.
- At `below_floor_alert_after_minutes`: surface a dashboard alert.
- At `below_floor_emergency_cap_after_minutes`: raise effective cap to `emergency_max_price_sat_per_eh_day` for
  floor-sized orders only. Target-hashrate orders remain at normal cap.
- At `zero_hashrate_loud_alert_after_minutes`: second louder dashboard alert.

**Order strategy (single-bid + optional handover):**

- Normal steady state: one autopilot-tagged bid sized to `target_hashrate_ph`, with `amount_sat = bid_budget_sat`.
- When estimated remaining runtime drops below `handover_window_minutes`, optionally pre-place an overlapping
  successor bid. Fully autonomous — no operator tap needed.
- Outside the handover window, do not run multiple concurrent autopilot bids for the same target.
- Respect the 10-open-bid account cap.
- Prefer cancel-and-replace over edit when the market move is large enough that the price-decrease cooldown would
  block a PUT anyway.

**Datum pool unreachable:**

- Short outage (< `pool_outage_blip_tolerance_seconds`): ignore.
- Sustained: transition to PAUSED. Active bids run out (or the Braiins side may pause them — see §14). No new bids.
  Alert.
- Pool recovers: automatic PAUSED → LIVE transition within the same session.

**Braiins API unreachable:**

- Retries with exponential backoff.
- Observations considered stale after `api_outage_alert_after_minutes`; dashboard alert.
- No automatic cancellation or destructive action based on stale state.

**Unknown-order detection:**

- If autopilot sees bids in the account whose IDs are not in its local ownership ledger, it transitions to PAUSED
  and alerts. Operator reviews: adopts (autopilot takes ownership) or dismisses (autopilot tracks for accounting
  only, never touches).

**All autopilot decisions are logged** with the input state that drove them, for post-hoc debugging.

## 10. Ownership model

The Braiins OpenAPI spec does not expose a `label` / `tag` / `metadata` field on `SpotPlaceBidRequest` or
`SpotBidResponseItem`. **Tagging is client-side only**: when the autopilot creates a bid, it records the returned
order ID in a local ownership ledger. Bids whose IDs are not in the ledger are treated as foreign (§9
"unknown-order detection").

- Autopilot-owned bids: fully managed (create / edit / cancel / replace).
- Foreign bids: observed for accounting (their hashrate contributes to observed totals; their spend counts toward
  monthly budget and P&L). Never touched.

Verify at runtime: whether the Braiins UI-placed bid returns the same order ID shape the API returns, so client-side
reconciliation is reliable.

## 11. Accounting

Persistent ledger (SQLite) of:

- Total funded in (autodetected from `GET /v1/account/transactions` deposits; manual override possible).
- Current Braiins wallet balance.
- Cumulative spend (from filled bids; autopilot and foreign combined).
- Spend per calendar month.
- Cumulative block reward income detected at `btc_payout_address` via Electrs or `bitcoind` RPC, valued at BTC price
  at time of receipt. BTC price source: TBD — picked at implementation time.
- **Net result:** reward income minus spend, absolute and per-month.

Ledger is the source of truth for runway forecasting.

## 12. Dashboard

- **Status bar:**
    - Run mode (DRY-RUN / LIVE / PAUSED) with engage/pause buttons.
    - Live hashrate vs floor vs target.
    - Open bid count (and the 10-cap).
    - Wallet balance + days-of-runway-at-floor.
    - Last API/RPC check timestamps.
- **Control panel:** every value in §8 editable live. Profile selector for outage thresholds.
- **Orders table:** current and recent bids with status, price, speed limit, delivery %, ownership, estimated end.
  Operator actions per-bid: cancel, recreate-with-these-params, bump-price. Operator actions set the
  manual-override window so the controller does not immediately undo them.
- **Decisions log:** recent autopilot decisions with the input state that drove each one.
- **Accounting view:** §11 data as tables and charts (monthly spend, monthly income, cumulative P&L, runway curve).
- **Alerts panel:** dashboard-local alerts with severity, source, and time. No external notification channel in v1.

## 13. Research-derived API constraints

- Base URL: `https://hashpower.braiins.com/v1/`. The OpenAPI spec's declared `servers: /api/v1` is wrong — live
  routing is `/v1/`.
- Auth: single `apikey:` header. Owner vs read-only token scopes.
- **Owner-token API bypasses 2FA.** Empirically verified against a live account on 2026-04-15; recorded in
  `docs/research.md` v1.1. Braiins' public docs describe the 2FA gate in the context of the web UI; the REST path
  with an owner-scope token is unaffected.
- **DELETE /spot/bid carries the order ID in the JSON body**, not the query string (empirical). See
  `packages/braiins-client/src/client.ts` for the custom DELETE-with-body implementation.
- **Max 10 open bids** per account.
- **Min 1 PH/s** per bid (with cap); minimum `amount_sat` 10k (capped) / 100k (uncapped); maximum `amount_sat`
  1 BTC per bid.
- **Pricing unit:** `price_sat` per `hr_unit`, where `hr_unit = "EH/day"` (sat per 1 EH/s per 1 day).
- **Price decrease cooldown:** 1 price-decrease edit per 10 minutes per bid. Increases have no cooldown.
- **No duration field on bids:** bids run until `amount_sat` is consumed or the bid is cancelled.
- **`dest_upstream.url` is immutable on a live bid.** Changing the destination requires cancel + create.
- **Fees are 0% during Braiins beta.** Poll `/spot/fee` and alert on any non-zero value.
- **Stratum V1 on the buyer→destination path.** Datum Gateway on port 23334 is SV1 with version-rolling. No SV2
  involvement.
- **Destination must have `extranonce2_size >= 7`.** Datum Gateway satisfies this.
- **Deposits require 3 confirmations** and may be held for up to 48 working hours for compliance screening.

## 14. Operational landmines (v1 must handle)

- **Dynamic home IP:** if the Umbrel endpoint's public IP rotates after a bid is funded, the bid's
  `dest_upstream.url` can't be edited — must cancel + create. Mitigation: operator uses DDNS or a static IP.
  Autopilot should detect public-IP change and alert.
- **Datum endpoint unreachable:** Gateway disconnects stratum clients; Braiins pauses the bid. Extended outage
  leaves the bid paused. Rule: auto-cancel after N minutes of continuous Braiins-side pause.
- **Worker-identity misconfiguration:** Ocean TIDES credits rewards to the BTC address encoded in the worker
  identity. A bare label (no `<btc-address>.` prefix) causes shares to be credited to no one — paying for hashrate
  that yields zero rewards. Setup CLI and dashboard config page must validate this shape at write time.
- **Deposit flagged for manual review:** up to 48 working-hours lag. Autopilot detects deposit in transactions but
  not in balance; alert operator and do not rely on it for runway.
- **Beta exit → non-zero fees:** `/spot/fee` returns non-zero → loud alert; operator must re-tune max prices.
- **Destination pool difficulty too low:** oscillating Paused/Active without meaningful delivery. Surface as a
  delivery-ratio alert.
- **Datum Gateway stale work:** pay-per-share with pool-side rejections. Detect via delivery-ratio below a
  configurable threshold (e.g. 98%).

## 15. Prior art worth studying

- `m1xb3r/braiins-hashbot` — Python + FastAPI + Docker; closest reference to this spec. Study its control-loop
  design and Fernet-encrypted secrets storage.
- `counterweightoperator/hashbidder` — Python + TOML; Ocean+Datum specialist with a target-hashrate mode. Study its
  pricing strategy and tick-size handling.

Neither is a drop-in; both are educational. v1 is fresh TypeScript.

## 16. Empirical questions — status

Resolved since v1.0:

- ~~Exact 2FA confirmation validity window.~~ Moot — owner-token API bypasses 2FA entirely.
- ~~Whether `POST /spot/bid` blocks until 2FA confirm or returns a pending ID.~~ Returns the created bid directly.
- ~~DELETE payload shape.~~ Order ID goes in the JSON body, not the query string.
- ~~Whether a UI-placed bid's order ID format is reconcilable with API-placed ones.~~ Yes; ledger reconciliation
  works.

Still open:

- Per-endpoint HTTP 429 thresholds (not published).
- Live values of `min_bid_price_decrease_period_s`, `tick_size_sat`, grace periods, and price bounds from
  `GET /v1/spot/settings` — require owner token; verify on first real run and seed defaults.

## Document history

| Version | Date       | Changes                                                                                                                                                                                             |
|---------|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | 2026-04-14 | Initial version.                                                                                                                                                                                    |
| 1.1     | 2026-04-16 | Post-empirical rewrite: owner-token API bypasses 2FA. Removed action-mode state machine (PENDING_CONFIRMATION, CONFIRMATION_TIMEOUT, QUIET_HOURS), confirmation bot, and operator-availability flag. Added empirical findings on worker identity shape and DELETE body. |
