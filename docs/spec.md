# Braiins Hashrate Autopilot — Specification (DRAFT v0.3)

> Status: research- and interview-complete draft. Ready for architecture and build planning. Remaining gaps are
> empirical (to be verified against a live account) and are noted inline.

## 1. Purpose

A personal-scale autopilot that keeps one user's orders on the **Braiins Hashrate Market** continuously active and
cost-optimized within the operator's tolerance, so purchased hashrate keeps landing at the user's Datum-connected pool
without manual babysitting. Replaces the current failure mode: "orders cancel overnight, zero hashing in the morning."

The goal is **bounded, observable downtime** with an explicit recovery policy — not gapless uptime. Orders can be
cancelled by counterparties or go unfilled in an expensive market; the autopilot's job is to keep those events rare,
short, observable, and predictable.

**Fundamental constraint: Braiins requires Telegram 2FA on every `create` and `edit` on the Hashpower API** (not on
`cancel` or reads). There is no documented bypass. The autopilot is therefore a **semi-autonomous controller**: it
decides and prepares actions, but creates and edits are gated on an operator tap, while cancels remain fully autonomous.
The design minimises the frequency of 2FA-triggering actions to stay tolerable.

## 2. Non-goals (v1)

- Multi-user / SaaS / commercial use.
- Multi-pool management (only one Datum-connected pool is targeted).
- Multi-market abstraction (Braiins only for v1; multi-market is an explicit v2 aspiration).
- Running in the cloud.
- Hands-free funding of the Braiins wallet (funding stays manual to preserve non-KYC posture).
- Gapless uptime.
- **2FA bypass via Telegram userbot relay.** Flagged as possible-but-brittle; not in v1.
- Contacting Braiins support about API-only flows. Not pursued.
- Handling post-beta non-zero fees beyond observing `/spot/fee` and surfacing changes as an alert.

## 3. Users

Exactly one: the operator, running this on a home always-on box alongside an Umbrel Bitcoin node.

## 4. Runtime environment

- **Host:** a dedicated always-on machine on the operator's LAN. Not the Umbrel node itself.
- **Network access required:** Braiins Hashpower API (internet egress — `hashpower.braiins.com`), Umbrel `bitcoind`
  RPC (LAN), Datum Gateway endpoint (LAN, typically port 23334).
- **Persistence:** state, accounting, deferred decisions, and run-mode must survive host reboots.
- **Secrets:** Braiins owner + read-only tokens, Telegram bot token, `bitcoind` RPC creds stored in a sops-encrypted
  file (age key). Decrypted at startup. Tokens must never appear in logs.
- **Dashboard access:** binds to LAN interface only. Remote access via operator's existing VPN/Tailscale. Simple shared
  password on the dashboard (VPN is the real perimeter).
- **Tech stack (locked):** TypeScript monorepo. Node daemon (control loop, API clients, ledger) + React dashboard +
  SQLite for persistent state. Choice rationale: I/O-bound workload, operator's TS comfort, unified daemon/UI language,
  low friction for others who want to run it.

## 5. Inputs (observable signals)

- Braiins API reads (read-only token sufficient for all of these):
    - Wallet balances: `GET /v1/account/balance`
    - Open bids: `GET /v1/spot/bid`
    - Per-bid delivery history: `GET /v1/spot/bid/delivery/{order_id}`
    - Per-bid speed history: `GET /v1/spot/bid/speed/{order_id}`
    - Market stats: `GET /v1/spot/stats`
    - Orderbook: `GET /v1/spot/orderbook`
    - OHLCV bars: `GET /v1/spot/bars`
    - Fees: `GET /v1/spot/fee`
    - Market settings: `GET /v1/spot/settings`
    - Transactions (on-chain + internal): `GET /v1/account/transactions`
- Block reward payouts observed via `bitcoind` RPC on the Umbrel node — `listreceivedbyaddress` / `gettransaction`, or
  ZMQ `rawblock` subscriber for real-time detection.
- Datum Gateway endpoint reachability (TCP connect health check, port 23334).
- User-editable configuration (see §8).
- Operator-availability signal from dashboard (see §7).

## 6. Outputs (actions)

- `POST /v1/spot/bid` (**create**, **2FA-gated**) — only for orders the autopilot will tag as its own.
- `PUT /v1/spot/bid/{id}` (**edit**, **2FA-gated**) — respects the 1-price-decrease-per-10-minutes cooldown. No
  URL/identity changes possible via edit.
- `DELETE /v1/spot/bid/{id}` (**cancel**, no 2FA) — always available.
- Telegram notifications via configured bot.
- Dashboard UI (LAN bind).

## 7. Run modes and state machines

The autopilot has **two orthogonal state machines** that together gate every mutating action.

### 7.1 Run mode (operator-controlled)

- **DRY-RUN** — default at every startup. Autopilot observes state and computes what it *would* do. Writes decisions to
  the log and dashboard. Does not call any mutating Braiins endpoint. Read-only API access continues. Operator promotes
  DRY-RUN → LIVE via a button in the dashboard.
- **LIVE** — autopilot may execute mutating actions subject to the action-mode gates below.
- **PAUSED** — operator or controller-entered hard stop. No creates, no edits, no cancels. Autopilot observes only.
  Entered on: operator pause button, sustained pool outage, unknown-order ambiguity.

Run mode is **not** persisted across restarts: every boot lands in DRY-RUN. Rationale: first-run-after-crash is exactly
when inputs are most likely to be stale or inconsistent; human-in-the-loop at boot bounds blast radius.

### 7.2 Action mode (autopilot-controlled, gates only creates/edits, not cancels)

- **NORMAL** — no pending 2FA, operator is available, not in quiet hours. Autopilot free to issue creates/edits.
- **QUIET_HOURS** — wall-clock time is inside the operator's configured no-2FA window. Autopilot defers any would-be
  create/edit decision to a deferred-decisions queue. Telegram messages are buffered (not sent) during this window. *
  *Cancels remain allowed** (silent to operator, and valid price discipline). At quiet-hours end, the controller
  re-evaluates the queue (recomputes fresh, does not blindly replay) and sends buffered notifications.
- **PENDING_CONFIRMATION** — a create or edit has been issued and the autopilot is waiting for the operator's Telegram
  tap. Autopilot will not issue additional creates/edits while in this state. Cancels still allowed. This state also
  blocks the control loop from deciding new creates/edits — it doesn't queue them; it waits.
- **CONFIRMATION_TIMEOUT** — the 2FA validity window elapsed without a tap. Autopilot **halts creates/edits** until the
  operator signals availability via the dashboard ("I'm available" button). Cancels still allowed. A Telegram message is
  sent (if not in quiet hours) informing the operator.

### 7.3 The mutation-gate rule (single source of truth)

```
canMutate(action) =
  runMode == LIVE
  AND NOT (action in {create, edit} AND actionMode == QUIET_HOURS)
  AND NOT (action in {create, edit} AND actionMode == PENDING_CONFIRMATION)
  AND NOT (action in {create, edit} AND actionMode == CONFIRMATION_TIMEOUT)
  AND NOT (runMode == PAUSED)
```

The implementation must route every mutating call through this gate. Cancels are never blocked by action mode — only by
run mode.

### 7.4 Operator-availability flag

A persistent flag, `operator_available: bool`, controlled by:

- Dashboard button "I'm available — retry pending" → `true`
- Automatic `true` transition when quiet hours end
- Automatic `false` transition when a 2FA confirmation times out (CONFIRMATION_TIMEOUT entry)

Separating quiet-hours (a time window) from availability (a flag) lets us distinguish "operator is asleep and will
become available at a known time" from "operator was awake but didn't tap; we don't know when they'll be back."

## 8. Tunable configuration (live-editable from dashboard)

All values change on the next control-loop tick without restart.

**Hashrate:**

- `target_hashrate_ph` (default 1000, i.e. 1 PH/s)
- `minimum_floor_hashrate_ph`
- `destination_pool_url` (the Datum Gateway endpoint; **immutable on live bids** — if this changes, autopilot must
  cancel and re-create)
- `destination_pool_worker_name` (Braiins `dest_upstream.user` / identity string)

**Pricing (unit: sat per EH/day, matching Braiins `price_sat` / `hr_unit = "EH/day"`):**

- `max_price_sat_per_eh_day` — normal cap for all target-hashrate orders
- `emergency_max_price_sat_per_eh_day` — higher cap applied **only** to floor-sized orders when §9 escalation fires

**Budget:**

- `monthly_budget_ceiling_sat` — absolute cap per calendar month
- `bid_budget_sat` — size of the `amount_sat` on each created bid (governs how long a bid lasts; see §14)
- `wallet_runway_alert_days` — alert when wallet balance can no longer fund this many days of floor hashing at current
  prices

**Outage tolerance — profile selector + individual overrides:**

Dashboard surfaces a single profile dropdown: **Aggressive / Regular / Relaxed / Custom**. Selecting a profile sets the
thresholds to a preset bundle. Editing any individual threshold switches the profile to Custom.

| Threshold                                 | Aggressive    | Regular | Relaxed (default) |
|-------------------------------------------|---------------|---------|-------------------|
| `below_floor_alert_after_minutes`         | 10            | 30      | 60                |
| `below_floor_emergency_cap_after_minutes` | 0 (immediate) | 60      | 240               |
| `zero_hashrate_loud_alert_after_minutes`  | 30            | 120     | 360               |

Plus (not profile-driven; set once, rarely tuned):

- `pool_outage_blip_tolerance_seconds` (default 120)
- `api_outage_alert_after_minutes` (default 15)

**Quiet hours (operator 2FA-friendly window):**

- `quiet_hours_start` (time, default 23:00 local)
- `quiet_hours_end` (time, default 08:00 local)
- `quiet_hours_timezone` (IANA TZ, default system)
- `confirmation_timeout_minutes` (default 15; Braiins' exact validity is empirically TBD — verify on first real run and
  update)

**Order strategy:**

- `handover_window_minutes` — how long before an active bid's estimated end to pre-place an overlapping successor (
  default 30)
- Research note: since Braiins bids have no explicit duration, "estimated end" =
  `amount_sat_remaining / (avg_daily_spend_rate_sat)`. The autopilot must track this.

**Integrations:**

- `btc_payout_address`
- `bitcoind_rpc_endpoint` + credentials
- `telegram_bot_token` + `telegram_chat_id`
- Braiins `owner_access_token` + `read_only_access_token`

## 9. Reliability & outage policy

**Hashrate below floor (escalation ladder):**

- Controller continuously attempts to maintain `target_hashrate_ph` at `max_price_sat_per_eh_day`, subject to all 2FA
  gates.
- If actual hashrate drops below `minimum_floor_hashrate_ph`: start a timer.
- At `below_floor_alert_after_minutes`: send Telegram alert (deferred if in quiet hours).
- At `below_floor_emergency_cap_after_minutes`: raise effective cap to `emergency_max_price_sat_per_eh_day` for
  floor-sized orders only. Target-hashrate orders remain at normal cap.
- At `zero_hashrate_loud_alert_after_minutes`: second louder Telegram alert (deferred if in quiet hours).

**Order strategy (hybrid single-bid + handover):**

- Normal steady state: one autopilot-tagged bid sized to `target_hashrate_ph`, with `amount_sat = bid_budget_sat`.
- When estimated remaining runtime (from spend-rate projection) drops below `handover_window_minutes`: pre-place an
  overlapping successor bid. This is a 2FA event — buffered to non-quiet hours.
- Outside the handover window, do not run multiple concurrent autopilot bids for the same target.
- Respect the 10-open-bid account cap.

**Minimizing 2FA frequency (a core design principle):**

- Prefer cancel-and-replace over edit where the market move is large enough that the price-decrease cooldown would block
  a PUT anyway.
- Prefer larger `bid_budget_sat` (longer-lived bids) over smaller frequent renewals, subject to the
  `amount_sat <= 1 BTC` per-bid cap.
- Never attempt the same create/edit twice without an operator availability signal — this is what CONFIRMATION_TIMEOUT
  prevents.

**Datum pool unreachable:**

- Short outage (< `pool_outage_blip_tolerance_seconds`): ignore.
- Sustained: transition to PAUSED. Active bids run out (or the Braiins side may pause them — see §16). No new bids.
  Alert.
- Pool recovers: automatic PAUSED → LIVE transition within the same session.

**Braiins API unreachable:**

- Retries with exponential backoff.
- Observations considered stale after `api_outage_alert_after_minutes`; Telegram alert (deferred if quiet).
- No automatic cancellation or destructive action based on stale state.

**Unknown-order detection:**

- If autopilot sees bids in the account whose IDs are not in its local ownership ledger, it transitions to PAUSED and
  alerts. Operator reviews: adopts (autopilot takes ownership) or dismisses (autopilot tracks for accounting only, never
  touches).

**All autopilot decisions are logged** with the input state that drove them, for post-hoc debugging.

## 10. Ownership model

The Braiins OpenAPI spec does not expose a `label` / `tag` / `metadata` field on `SpotPlaceBidRequest` or
`SpotBidResponseItem`. **Tagging is client-side only**: when the autopilot creates a bid, it records the returned order
ID in a local ownership ledger. Bids whose IDs are not in the ledger are treated as foreign (§9 "unknown-order
detection").

- Autopilot-owned bids: fully managed (create / edit / cancel / replace — subject to 2FA gates).
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
- Cumulative block reward income detected at `btc_payout_address` via `bitcoind` RPC, valued at BTC price at time of
  receipt. **BTC price source: TBD** — options are CoinGecko, a local price oracle, or "price at the confirming block's
  timestamp via a third-party historical API." Picked at implementation time.
- **Net result:** reward income minus spend, absolute and per-month.

Ledger is the source of truth for runway forecasting.

## 12. Dashboard

- **Status bar:**
    - Run mode (DRY-RUN / LIVE / PAUSED) with engage/pause buttons.
    - Action mode (NORMAL / QUIET_HOURS / PENDING_CONFIRMATION / CONFIRMATION_TIMEOUT).
    - Operator-available flag + "I'm available — retry pending" button.
    - Live hashrate vs floor vs target.
    - Open bid count (and the 10-cap).
    - Wallet balance + days-of-runway-at-floor.
    - Last API/RPC check timestamps.
- **Control panel:** every value in §8 editable live. Profile selector for outage thresholds.
- **Orders table:** current and recent bids with status, price, speed limit, delivery %, ownership, estimated end.
- **Pending confirmations:** actions proposed by the controller that are waiting on a 2FA tap, with "Abandon" option per
  action.
- **Decisions log:** recent autopilot decisions with the input state that drove each one.
- **Accounting view:** §11 data as tables and charts (monthly spend, monthly income, cumulative P&L, runway curve).
- **Alerts history:** what's been sent to Telegram, when, why, and which alerts were buffered during quiet hours.

## 13. Research-derived API constraints (v1 must assume these)

- Base URL: `https://hashpower.braiins.com/v1/`. Note the OpenAPI spec's declared `servers: /api/v1` is wrong — live
  routing is `/v1`.
- Auth: single `apikey:` header. Owner vs read-only token.
- **Telegram 2FA gate on POST /spot/bid and PUT /spot/bid** — confirmed by Braiins' own Account FAQ.
- **Max 10 open bids** per account.
- **Min 1 PH/s** per bid (with cap); minimum `amount_sat` 10k (capped) / 100k (uncapped); maximum `amount_sat` 1 BTC per
  bid.
- **Pricing unit:** `price_sat` per `hr_unit`, where `hr_unit = "EH/day"` (sat per 1 EH/s per 1 day).
- **Price decrease cooldown:** 1 price-decrease edit per 10 minutes per bid. Increases have no cooldown.
- **No duration field on bids:** bids run until `amount_sat` is consumed or the bid is cancelled.
- **`dest_upstream.url` is immutable on a live bid.** Changing the destination requires cancel + create.
- **Fees are 0% during Braiins beta.** All endpoints still model placement/edit/cancel fees; autopilot must refresh
  `/spot/fee` and alert on non-zero values.
- **Stratum V1 on the buyer→destination path.** Datum Gateway on port 23334 is SV1 with version-rolling. No SV2
  involvement in this project.
- **Destination must have `extranonce2_size >= 7`.** Datum Gateway satisfies this.
- **Deposits require 3 confirmations** and may be held for up to 48 working hours for compliance screening.

## 14. Operational landmines (v1 must handle)

Things that have historically gone wrong for Hashpower buyers, from Braiins docs + prior art:

- **Dynamic home IP:** if the Umbrel endpoint's public IP rotates after a bid is funded, the bid's `dest_upstream.url`
  can't be edited — must cancel + create (2FA event). Mitigation: operator uses DDNS or a static IP. Autopilot should
  detect public-IP change and alert.
- **Datum endpoint unreachable:** Gateway disconnects stratum clients, Braiins pauses the bid. Extended outage leaves
  the bid paused. Rule: auto-cancel after N minutes of continuous Braiins-side pause.
- **Deposit flagged for manual review:** up to 48 working-hours lag. Autopilot detects deposit in transactions but not
  in balance; alert operator and do not rely on it for runway.
- **Beta exit → non-zero fees:** `/spot/fee` returns non-zero → loud alert; operator must re-tune max prices.
- **Telegram account lost:** existing bids continue; cancel still works without 2FA; no new bids possible. Autopilot
  should transition to a clearly-surfaced "2FA-unavailable" state and stop all creates/edits until the operator resolves
  it with Braiins support.
- **Destination pool difficulty too low:** oscillating Paused/Active without meaningful delivery. Surface as a
  delivery-ratio alert.
- **Datum Gateway stale work:** pay-per-share with pool-side rejections. Detect via delivery-ratio < configurable
  threshold (e.g., 98%).

## 15. Prior art worth studying

- `m1xb3r/braiins-hashbot` — Python + FastAPI + Docker; closest reference to this spec. Study its control-loop design
  and Fernet-encrypted secrets storage.
- `counterweightoperator/hashbidder` — Python + TOML; Ocean+Datum specialist with a target-hashrate mode. Study its
  pricing strategy and tick-size handling.

Neither is a drop-in; both are educational. v1 is fresh TypeScript.

## 16. Empirical questions to verify on first real run

- Exact 2FA confirmation validity window (operator guess ~15 min; default until verified).
- Whether `POST /spot/bid` blocks until 2FA confirm or returns a pending ID immediately. If pending, we need to poll; if
  blocking, we need a long timeout.
- Live values for `min_bid_price_decrease_period_s`, `tick_size_sat`, `grace_periods`, and price bounds from
  `GET /v1/spot/settings` (requires owner token).
- Per-endpoint rate limits (not published).
- Whether a UI-placed bid's order ID format is reconcilable with API-placed ones (drives §10 client-side ownership
  tracking reliability).

## Document history

| Version | Date       | Changes         |
|---------|------------|-----------------|
| 1.0     | 2026-04-14 | Initial version |