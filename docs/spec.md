# Hashrate Autopilot — Specification (v2.2)

> Status: current, aligned with code through 2026-04-25 (v1.3.0 release).
>
> This spec has been through three pricing regimes. **v1.x** used a depth-aware "fillable + overpay"
> controller with escalation timers, lowering-patience, and a dampening subsystem. **v2.0** (2026-04-23,
> same day) retired all of it on the hypothesis that Braiins matched CLOB-style and the bid was a
> matching-access ceiling. **v2.1** (2026-04-23, hours later) reversed v2.0 after a direct A/B on the
> live account showed Braiins matches pay-your-bid — the bid price *is* the paid price. The current
> controller tracks `fillable_ask + overpay_sat_per_eh_day` (the v1.x primitive) without the v1.x timer
> machinery (which was only needed to simulate that target under a misread of the mechanic); the
> retired escalation/patience/min-lower-delta knobs stay retired.
>
> Earlier history: v1.0 (2026-04-14) was built around a constraint — that Braiins requires 2FA on every
> `POST`/`PUT` — which empirical testing on a live account on 2026-04-15 disproved for the owner-scope
> API token. v1.1 removed the confirmation bot, quiet-hours machinery, pending-confirmation /
> confirmation-timeout action modes, and operator-availability flag. v1.2–1.9 layered on depth-aware
> pricing, cheap-mode opportunistic scaling, the Ocean and Datum Gateway integrations, the
> hashprice-relative dynamic cap, and retention-managed persistence. The what-if simulator shipped in
> v1.8 and was retired in v2.0 along with the fill-strategy knobs. See the document history at the
> bottom for the per-version breakdown.

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
  password. Resolution priority on boot is `BHA_*` env vars > sops-encrypted file (`.env.sops.yaml`) > the `secrets`
  table in `state.db` (populated by the first-run web onboarding wizard). Tokens must never appear in logs.
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

Run mode on startup is chosen by the `boot_mode` config knob:

- `ALWAYS_DRY_RUN` (default) — every boot lands in DRY-RUN. Safest posture. Rationale: first-run-after-crash is
  exactly when inputs are most likely to be stale or inconsistent; human-in-the-loop at boot bounds blast radius.
- `LAST_MODE` — resume whatever mode the operator last set. PAUSED is demoted to DRY-RUN (PAUSED is a reactive
  state, never an initial one).
- `ALWAYS_LIVE` — boot directly into LIVE. Use only once the autopilot is proven and an unplanned restart should
  not interrupt bidding.

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

See also the "Pricing strategy" section further down — these three knobs feed the controller formula
`bid = min(fillable_ask + overpay_sat_per_eh_day, effective_cap)` where
`effective_cap = min(max_bid_sat_per_eh_day, hashprice + max_overpay_vs_hashprice_sat_per_eh_day)`.

- `overpay_sat_per_eh_day` — premium above the fillable ask. The one knob that tunes the controller:
  higher = more headroom against upward jitter at the cost of a bigger premium; lower = closer to the
  market but more sensitive to noise. Default 1,000,000 sat/EH/day (= 1,000 sat/PH/day). The dashboard
  displays it in sat/PH/day.
- `max_bid_sat_per_eh_day` — fixed safety ceiling. If `fillable_ask + overpay` exceeds this, the bid is
  clamped down (and may not fill). Intended as an opt-out price, not the normal bid.
- `max_overpay_vs_hashprice_sat_per_eh_day` *(optional, default null / disabled)* — dynamic
  hashprice-relative safety ceiling. When set, `effective_cap = min(max_bid, hashprice + this)`.
  Prevents the autopilot from following fillable off a cliff during a hashprice crash when the fixed
  `max_bid` alone would still allow it. Null / 0 falls back to the fixed `max_bid`; also falls back when
  Ocean hashprice data is unavailable — except: when the dashboard has configured the dynamic cap and
  hashprice is unknown, the controller refuses to trade that tick (silent skip) rather than ignore the
  configured ceiling.

**Budget:**

- `bid_budget_sat` — size of the `amount_sat` on each created bid (governs bid lifetime). **0 is a sentinel** meaning "use the full available wallet balance on each CREATE" — resolved at decision time and clamped to Braiins' 1 BTC per-bid hard cap. New installs default to 0; existing installs keep whatever explicit value is in their config. When the sentinel is active but the wallet is empty (or the balance API has failed), the CREATE is skipped silently until a balance is observed.
- `wallet_runway_alert_days`

**Outage tolerance — profile selector + individual overrides:**

Dashboard surfaces a single profile dropdown: **Aggressive / Regular / Relaxed / Custom**. Selecting a profile sets
the thresholds to a preset bundle. Editing any individual threshold switches the profile to Custom.

| Threshold                                 | Aggressive    | Regular | Relaxed (default) |
|-------------------------------------------|---------------|---------|-------------------|
| `below_floor_alert_after_minutes`         | 10            | 30      | 60                |
| `zero_hashrate_loud_alert_after_minutes`  | 30            | 120     | 360               |

Plus (not profile-driven; set once, rarely tuned):

- `pool_outage_blip_tolerance_seconds` (default 120)
- `api_outage_alert_after_minutes` (default 15)

**Pricing strategy (v2.1 — pay-your-bid fillable-tracking):**

Empirical A/B on 2026-04-23 falsified the v2.0 CLOB assumption: Braiins matches **pay-your-bid**, not
pay-at-ask (lowering the bid by ~100 sat/PH/day directly lowered effective cost by a comparable amount,
with the orderbook's fillable ask well below both bids). The bid price is the price paid.

Per-tick target: **`min(fillable_ask + overpay_sat_per_eh_day, effective_cap)`** where
`effective_cap = min(max_bid_sat_per_eh_day, hashprice + max_overpay_vs_hashprice_sat_per_eh_day)` and
`fillable_ask` is the cheapest price at which the orderbook's cumulative *unmatched* ask supply covers
`target_hashrate_ph` (`cheapestAskForDepth(asks, target)` — walks asks in ascending price, accumulating
`max(0, hr_available_ph − hr_matched_ph)` per level, returns the price where the running total first
covers the target).

When `fillable_ask` is null (orderbook empty / API down) the tick is skipped — defaulting to the cap is
exactly the money-burn this controller unwinds. Braiins' 10-min price-decrease cooldown is the only
pacing rule below the decide layer; no escalation ladder, no patience timers (retired in v2.0, not
brought back). The ceilings exist for (a) wallet runway, (b) opting out of pathologically expensive
market conditions — they are not the normal bid.

**EDIT_PRICE deadband.** Emitted when `|target_price − current_bid_price| >= max(tick_size,
overpay_sat_per_eh_day / 5)`. At the default overpay this is a ~200 sat/PH/day deadband, absorbing the
±1-5 sat/PH/day orderbook jitter that would otherwise trigger a mutation per tick. Never below
`tick_size` — Braiins rejects smaller edits. Applied symmetrically to raises and lowers; the 10-minute
Braiins cooldown on price decreases is enforced one layer below by `gate.ts`.

**Cheap-mode interaction.** Cheap-mode (below) changes `target_hashrate_ph` opportunistically; the
pricing formula is unchanged.

- `handover_window_minutes` — manual-override suppression window.

**Daemon startup:**

- `boot_mode` — `ALWAYS_DRY_RUN` (default, safest) | `LAST_MODE` (resume, with PAUSED → DRY_RUN) | `ALWAYS_LIVE`.

**Opportunistic scaling (cheap-mode):**

- `cheap_target_hashrate_ph` — higher-than-normal target to run when the market is cheap (default 0 =
  disabled).
- `cheap_threshold_pct` — cheap-mode activates when the market price drops below `hashprice ×
  (cheap_threshold_pct / 100)`. The "market price" reference is `best_ask` (cheapest price at which any
  supply exists) — a coarser signal than the depth-aware `fillable_ask` the pricing formula uses, but
  sufficient for cheap-mode's on/off decision. Both `cheap_target_hashrate_ph` and `cheap_threshold_pct`
  must be non-zero to activate. When cheap-mode is active, the pricing formula is unchanged — only
  `target_hashrate_ph` is swapped out for `cheap_target_hashrate_ph`, which feeds into
  `cheapestAskForDepth` and the bid's `speed_limit_ph`.
- `cheap_sustained_window_minutes` — rolling-average window for the engagement check (#50). Default 0
  keeps the legacy per-tick spot behaviour. When > 0, cheap-mode engages only when `avg(best_ask)` over
  this many minutes is below `cheap_threshold_pct × avg(hashprice)` over the same window — averages are
  computed from `tick_metrics` (no new columns). Avoids flapping cheap-mode on single-tick market
  spikes; natural hysteresis falls out of the window-based evaluation (the threshold only flips when the
  whole window crosses it). Requires ≥5 samples in the window before honouring it; below that, falls
  back to the spot check (same "insufficient history" pattern used by `/api/finance/range`).

**Datum Gateway integration (optional, informational only):**

- `datum_api_url` — HTTP base URL of the Datum Gateway's `/umbrel-api` endpoint. When null, the dashboard's Datum
  panel shows a "not configured" empty state and the daemon writes `null` to `tick_metrics.datum_hashrate_ph`.
  Integration is never on the control path — if Datum is unreachable the control loop continues unchanged.
  See `docs/setup-datum-api.md` for the Umbrel-side port-exposure recipe.

**Retention (append-only tables):**

- `tick_metrics_retention_days` — default 7. 0 disables pruning.
- `decisions_uneventful_retention_days` — default 7 (rows with no proposals).
- `decisions_eventful_retention_days` — default 90 (rows with at least one proposal — forensic value).

The daemon runs a pruning pass once per hour; the controller is untouched by retention.

**Chart smoothing (display-only, not read by the control loop):**

- `braiins_hashrate_smoothing_minutes` — default 1. Rolling-mean minute window the dashboard applies to
  the `delivered (Braiins)` series on the Hashrate chart. 1 = raw.
- `datum_hashrate_smoothing_minutes` — default 1. Same, for `received (Datum)`.
- `braiins_price_smoothing_minutes` — default 1. Rolling-mean window applied client-side to the Price
  chart's `our bid` and `effective` series. `fillable`, `hashprice`, and `max bid` are market-wide
  signals and stay raw. The `effective` line is noisy at tick resolution because Braiins'
  `amount_consumed_sat` counter settles asynchronously from `avg_speed_ph`; a rolling mean lets the
  operator see the trend rather than per-tick quantisation.
- `show_effective_rate_on_price_chart` — default `false`. When true, the emerald `effective` line is
  rendered on the Price chart and participates in Y-axis auto-scaling. Off by default because the
  line's per-tick volatility (counter settles in lumps; aggregated rate dives between settlements) pulls
  the Y-axis down and crushes the flatter bid / fillable / hashprice / max-bid detail into a thin band.
  The hero PRICE card and the AVG COST / PH DELIVERED stats card already surface the effective rate as
  a number — the line is only useful for operators inspecting settlement rhythm directly.

Ocean is not smoothed client-side because `/user_hashrate` already returns a server-side 5-min average;
setting `braiins_hashrate_smoothing_minutes` and `datum_hashrate_smoothing_minutes` to 5 visually aligns
all three series on the same cadence.

**Integrations:**

- `btc_payout_address`
- `bitcoind_rpc_url` + `bitcoind_rpc_user` + `bitcoind_rpc_password` (live-editable; seeded from sops secrets on
  first boot)
- Optional `electrs_host` + `electrs_port` (preferred over `bitcoind` RPC for balance lookups — instant)
- `payout_source` — `none` | `electrs` | `bitcoind`
- `btc_price_source` — `none` | `coingecko` | `coinbase` | `bitstamp` | `kraken` (feeds the dashboard sat↔USD toggle)
- Braiins `owner_access_token` + optional `read_only_access_token` (stored in sops secrets, not the config table)

## 9. Reliability & outage policy

**Hashrate below floor (alert timer, not escalation):**

- Controller continuously targets `min(fillable_ask + overpay_sat_per_eh_day, effective_cap)` PH/s at
  `target_hashrate_ph` capacity (see §8 "Pricing strategy").
- If actual hashrate drops below `minimum_floor_hashrate_ph`: start a timer, debounced by
  `FLOOR_DEBOUNCE_TICKS` (3) consecutive above-floor ticks before the timer clears — the Braiins
  `avg_speed_ph` field is a lagged rolling average that can briefly read above-floor during bid-state
  flickers, so a single recovery tick must not reset the clock.
- At `below_floor_alert_after_minutes`: surface a dashboard alert.
- At `zero_hashrate_loud_alert_after_minutes`: second louder dashboard alert.
- The controller does **not** react to below-floor state by changing the bid — there's no escalation
  ladder, no auto-raise on sustained below-floor. Under pay-your-bid, the cheapest path to restore
  delivery is `fillable + overpay`, which is already what the controller bids every tick. If that's
  below floor, either supply is genuinely thin or `max_bid` is tight; those are operator decisions, not
  controller recoveries.

**Order strategy (single-bid):**

- Normal steady state: exactly one autopilot-tagged bid sized to `target_hashrate_ph` (or
  `cheap_target_hashrate_ph` when cheap-mode is engaged), with `amount_sat` resolved from
  `bid_budget_sat` (positive value = literal; 0 = available wallet balance clamped to 1 BTC).
- If multiple owned bids are observed (e.g. a manual CREATE during an autopilot run), the controller
  cancels all but the lexicographically-first `braiins_order_id` and converges the remaining one to the
  current target price.
- Respect the 10-open-bid account cap.
- Handover (pre-placing a successor before an active bid drains) and cancel-and-replace-to-skip-cooldown
  are **not implemented** — the spec called for them in v1.x but v2.1's direct fillable tracking plus
  the deadband plus the full-wallet-balance `bid_budget_sat = 0` sentinel combine to make handover
  unnecessary in practice (bids rarely drain completely before the operator tops up the wallet). If the
  need resurfaces, file an issue; this spec section lists what the code does today.

**Datum pool unreachable:**

- The daemon probes the pool endpoint (TCP connect on the Datum Gateway port from
  `destination_pool_url`) every tick and records reachability + last-ok timestamp in `state.pool`. The
  dashboard's Datum Gateway service panel surfaces this state.
- `pool_outage_blip_tolerance_seconds` is the observer-side threshold below which the dashboard still
  reports the service as healthy (ignores transient blips).
- The controller does **not** currently auto-transition to PAUSED on sustained pool outages, nor
  auto-recover to LIVE. The v1.x spec called for both; they were not carried through the subsequent
  rewrites. Active bids continue to bid for hashrate regardless of whether the operator's pool is
  reachable — if the pool is down, Braiins may observe zero delivery and stop matching on that bid,
  which the operator sees as a below-floor alert (above). Operator-driven PAUSE from the dashboard is
  always available.

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

### 11.1 Per-day run-rate panel (issue #43)

The dashboard's **Profit & Loss · per day** card answers a different question than the lifetime ledger above:
*at the rate things are going right now, how much am I spending and earning per day?* Two key differences from
the lifetime ledger:

- **Range-aware.** Both spend/day and income/day are computed over the currently-selected chart range (3h, 6h,
  12h, 24h, 1w, 1m, 1y, All) — not a hardcoded window. The operator's intent when picking "24h" on the charts
  is "tell me what's happening over 24h"; the finance numbers below the charts must share that cadence.
- **Averaged inputs, not instantaneous.** A mid-day price change must not retroactively shift the entire day's
  projection; likewise a single-tick delivery dip must not move the number. Both sides use averages over the
  selected window.

**Spend/day:**
Per-tick deltas of the cumulative `primary_bid_consumed_sat` counter summed over the selected range and
scaled to a daily rate — i.e., what Braiins actually charged (settled cost), not a modelled
bid × delivered. The legacy `spend_sat` column on `tick_metrics` is retained for schema continuity but
no longer written (it was a `bid × delivered / 1440` model under the pre-#49 assumption and would lie
under pay-your-bid too, since delivered lags). Zero-delta intervals and counter resets are filtered out
(see `tick_metrics.ts::actualSpendSatSince` for the window function and the same filter mirrored in
`stats.ts`).

**Income/day — two figures side by side:**

- **Ocean est. income/day (3h).** Ocean's `daily_estimate_sat` — the pool's own "what this address
  would earn per day at its 3h hashrate" estimate. Authoritative but always 3h-based; tooltip notes
  this.
- **Projected income/day (range).** `avg(hashprice_sat_per_ph_day over range) × avg(delivered_ph over
  range)`, scaled to a daily rate. Symmetric with spend/day on cadence; uses tick-level hashprice
  samples already stored in `tick_metrics`.

**Net/day** = (projected income/day) − (spend/day). Uses the range-aware income, not Ocean's, so both
sides are on the same cadence.

**UI placement.** Sits directly under the charts, always expanded. (A collapsible-card variant was tried
briefly and removed — if the lifetime P&L card isn't collapsible, making the per-day card collapsible
created false asymmetry rather than useful decluttering.)

**Fallbacks.**

- When the selected range has fewer than ~5 ticks of data (fresh install, pruned history): fall back to the
  instantaneous figure (current price × current hashrate) and badge the card `insufficient history`.
- When no active owned bids exist: show the existing `no active bids` empty state.

## 12. Dashboard

Two pages: **Status** (default) and **Config**. Both bind to the LAN only (`0.0.0.0:3010` by default;
`HTTP_HOST=127.0.0.1` to restrict to loopback). Remote access is expected to go through a VPN / Tailscale
perimeter; the dashboard has a shared-password second gate, not full auth.

### 12.1 Status page (top to bottom)

- **Hero PRICE / DELIVERED card + run-mode toggle.** The large PRICE number is the *window-averaged*
  effective rate over the selected chart range (derived from `primary_bid_consumed_sat` deltas — see
  §11.1); a tooltip makes this explicit and cross-references NEXT ACTION for the live bid price. Next
  to it sits the ±delta versus current hashprice. The DELIVERED number is current instantaneous PH/s,
  coloured by floor / target thresholds. Below, the DRY-RUN / LIVE / PAUSED segmented control.
- **NEXT ACTION panel.** Describes what the controller will do on the next tick — create, edit, speed
  edit, wait for cooldown, or sit still. Includes a "Run decision now" button that bypasses the
  inter-tick wait. When a lower is queued behind Braiins' 10-min cooldown, the panel shows ETA and a
  progress bar.
- **Time-range picker.** 3h / 6h / 12h / 24h / 1w / 1m / 1y / all. Persisted in `localStorage`. Drives
  both charts, the stats bar, and the per-day P&L card.
- **Stats bar.** UPTIME (counter-derived, see §11.1 notes on delivered hashrate), AVG BRAIINS, AVG
  DATUM, AVG OCEAN (three side-by-side hashrate averages), AVG COST / PH DELIVERED (same metric as the
  hero PRICE card; deliberately duplicated so each panel stands alone), AVG COST VS HASHPRICE
  (effective-vs-hashprice delta, signed).
- **Hashrate chart.** Three series: `delivered (Braiins)` (amber), `received (Datum)` (emerald),
  `received (Ocean)` (blue). Target + floor as dashed horizontal references. Per-series rolling-mean
  smoothing via `braiins_hashrate_smoothing_minutes` and `datum_hashrate_smoothing_minutes`; Ocean is
  server-smoothed. Ocean-credited pool-block markers appear as isometric cubes (blue for TIDES,
  gold for own-found); click opens the configured block explorer.
- **Price chart.** Four always-on lines: `our bid` (amber), `fillable` (cyan, the controller's tracking
  anchor), `hashprice` (violet, dashed), `max bid` / effective ceiling (red). The `effective` line
  (emerald, per-tick Δconsumed_sat ÷ delivered×Δt) is hidden by default behind the
  `show_effective_rate_on_price_chart` config toggle — its counter-settlement volatility auto-scales
  the Y-axis and crushes the flatter-line detail when enabled. Bid-event dots (yellow / cyan / red) on
  the amber line mark CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL events; clicking pins a detail panel
  with `fillable`, `overpay`, `hashprice`, cap inputs, effective cap at that tick, and a JSON export
  button.
- **Service panels (three-column).** BRAIINS (API reachability, delivered vs target, wallet balance,
  runway at current spend rate), DATUM GATEWAY (stratum reachability, gateway-measured hashrate,
  connected workers — if `datum_api_url` is configured), OCEAN (API reachability, Ocean-credited
  hashrate, current hashprice, recent blocks, time to next payout).
- **Active bids table.** All current bids with full order IDs, prices, speed limits, delivery %,
  ownership badge. No inline per-bid operator actions in the current build — run-mode toggle +
  "Run decision now" + the config editor cover the day-to-day needs; per-bid bump / recreate /
  manual-cancel are not yet shipped.
- **Per-day P&L card.** Range-aware (see §11.1). Ocean estimate + projected income, spend, net.
- **Lifetime P&L + funding ledger.** Cumulative block-reward income, cumulative spend, net.

### 12.2 Config page

One long form mirroring §8. Sections: Hashrate targets, Pool destination, Pricing (fillable-tracking
overpay + two safety ceilings), Budget, Alerting / outage tolerance, Daemon startup, Chart smoothing
(including the effective-line toggle), Log retention, Integrations (Ocean / Datum / bitcoind / electrs /
BTC price), On-chain payouts. Saves go through the Zod `AppConfigInvariantsSchema` and take effect on
the next tick; no daemon restart needed.

### 12.3 Things the v1 spec listed but v2.1 does not ship

For honesty against the older spec drafts: no operator-availability / quiet-hours UI, no
per-bid operator-action menu (bump / recreate / cancel — still an option to add but not present), no
what-if simulator (retired in v2.0), no separate Decisions tab (the bid-event pinned tooltip on the
Price chart covers the forensic-debug use case). Alerts live in service-panel pills + the
below-floor dashboard warning rather than a dedicated "Alerts panel" page. No external notification
channel.

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

## 14. Operational landmines

Risks the operator should know about. Each is annotated with current coverage: **[handled]** in the
code, **[observed]** if the dashboard surfaces signal but no automatic response, or **[unhandled]** if
neither. Unhandled items are operator-vigilance problems for v2.1.

- **Dynamic home IP.** If the Umbrel endpoint's public IP rotates after a bid is funded, the bid's
  `dest_upstream.url` can't be edited — must cancel + create. Mitigation: operator uses DDNS or a
  static IP. **[unhandled]** — autopilot does not detect public-IP change today.
- **Datum endpoint unreachable.** Gateway disconnects stratum clients; Braiins pauses the bid.
  **[observed]** — Datum Gateway panel shows reachability, and a sustained below-floor state will
  surface the below-floor alert. No auto-cancel of the Braiins bid; operator decides.
- **Worker-identity misconfiguration.** Ocean TIDES credits rewards to the BTC address encoded in the
  worker identity. A bare label (no `<btc-address>.` prefix) causes shares to be credited to no one —
  paying for hashrate that yields zero rewards. **[handled]** — the setup CLI and the dashboard
  Config page both validate the shape at write time.
- **Deposit flagged for manual review.** Up to 48 working-hours lag. Autopilot may detect the deposit
  in transactions but not in balance. **[observed]** — transactions / balance are both on the
  dashboard; operator reconciles.
- **Beta exit → non-zero fees.** `/spot/fee` returns non-zero. **[observed]** — current fees are
  polled each tick but not yet alerted on. Operator must re-tune caps.
- **Destination pool difficulty too low.** Oscillating Paused/Active without meaningful delivery.
  **[observed]** — gap between Braiins-delivered and Datum-received on the hashrate chart is the
  visual signal; no dedicated alert.
- **Datum Gateway stale work.** Pay-per-share with pool-side rejections. **[observed]** — same
  delivered-vs-received gap + rejection stats from Datum.
- **Fillable jitter → trade storm.** Orderbook `fillable_ask` jitters ±1-5 sat/PH/day tick-to-tick.
  **[handled]** — EDIT_PRICE deadband at `max(tick_size, overpay/5)` absorbs it (see §8 "Pricing
  strategy"). Without the deadband a naive tick_size tolerance burned the 10-minute cooldown on every
  noise blip.
- **Overpay value lost on upgrade from v1.x → v2.1.** Migrations 0043/0045 were originally paired as
  drop-then-add (dropping the operator's configured `overpay_sat_per_eh_day` and reinstating it with
  default). **[handled]** — 0043 was revised to preserve the column; 0045 is now a no-op. Any user
  still upgrading past both migrations keeps their overpay value.

## 15. Prior art worth studying

- `m1xb3r/braiins-hashbot` — Python + FastAPI + Docker; closest reference to this spec. Study its control-loop
  design and Fernet-encrypted secrets storage.
- `counterweightoperator/hashbidder` — Python + TOML; Ocean+Datum specialist with a target-hashrate mode. Study its
  pricing strategy and tick-size handling.

Neither is a drop-in; both are educational. v1 is fresh TypeScript.

## 16. Empirical questions — status

Resolved since v1.0:

- ~~Exact 2FA confirmation validity window.~~ Moot — owner-token API bypasses 2FA entirely.
- ~~Whether `POST /spot/bid` blocks until 2FA confirm or returns a pending ID.~~ Returns the created
  bid directly.
- ~~DELETE payload shape.~~ Order ID goes in the JSON body, not the query string.
- ~~Whether a UI-placed bid's order ID format is reconcilable with API-placed ones.~~ Yes; ledger
  reconciliation works.
- ~~Pricing model — CLOB / pay-at-ask vs pay-your-bid.~~ Pay-your-bid. Verified by direct A/B on
  2026-04-23: dropping `max_bid_sat_per_eh_day` from 50,000 → 49,000 sat/PH/day dropped effective cost
  from ~50,300 → ~49,899 sat/PH/day while the orderbook's fillable ask was unchanged at ~47,158. See
  #53 and `decide.ts` header.

Still open:

- Per-endpoint HTTP 429 thresholds (not published).
- Live values of `min_bid_price_decrease_period_s`, `tick_size_sat`, grace periods, and price bounds
  from
  `GET /v1/spot/settings` — require owner token; verify on first real run and seed defaults.

## Document history

| Version | Date       | Changes                                                                                                                                                                                             |
|---------|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | 2026-04-14 | Initial version.                                                                                                                                                                                    |
| 1.1     | 2026-04-16 | Post-empirical rewrite: owner-token API bypasses 2FA. Removed action-mode state machine (PENDING_CONFIRMATION, CONFIRMATION_TIMEOUT, QUIET_HOURS), confirmation bot, and operator-availability flag. Added empirical findings on worker identity shape and DELETE body. |
| 1.2     | 2026-04-16 | Replaced hard-coded "always reset to DRY-RUN on boot" rule (§7.1) with a `boot_mode` config knob: `ALWAYS_DRY_RUN` (default) \| `LAST_MODE` \| `ALWAYS_LIVE`. |
| 1.3     | 2026-04-16 | Added `max_lowering_step_sat_per_eh_day` dampener: auto-lower edits now move down at most one step per edit so a sliver-of-supply "topmost ask" drop doesn't strand the fill in one move. Empirical trigger: live event 2026-04-16 dropped 2,000 sat/PH/day in one EDIT and killed delivered hashrate. |
| 1.4     | 2026-04-16 | Hashrate chart gains a time-range picker (6 h / 12 h / 24 h / 1 w / 1 m / 1 y / all, default 24 h, persisted in `localStorage`). Server aggregates to 5-min (1 w), 1-h (1 m), or 1-day (1 y / all) buckets via `GROUP BY tick_at / bucket_ms`; raw rows for ≤ 24 h. Event overlay suppressed for ranges ≥ 1 m (individual markers lose signal at that zoom). AVG used for all aggregated fields in the MVP — median/end-of-bucket refinements are follow-ups. |
| 1.5     | 2026-04-16 | Depth-aware pricing: the autopilot no longer targets "cheapest ask with any non-zero supply". Instead it walks asks cumulatively and targets the cheapest price at which the full `target_hashrate_ph` is fillable. Empirical trigger: live orderbook 2026-04-16 had a sliver ask at 45,070 with the real supply at 47,803 — the old logic targeted 45,070 and stranded the fill. Dashboard gains a "fillable @ target" row in the Hashrate & Market card. |
| 1.6     | 2026-04-16 | Simplified pricing model: target = min(fillable + max_overpay, max_bid). Renamed `max_price_sat_per_eh_day` → `max_bid_sat_per_eh_day`, `max_overpay_vs_ask` → `max_overpay`. Removed `overpay_before_lowering` and `max_lowering_step` dampeners — downward adjustments now jump directly to target. Added `escalation_mode` config: `market` (jump to target) or `dampened` (step up). User interview drove the simplification: all thresholds relative to fillable, no stacked margins. |
| 1.7     | 2026-04-16 | Renamed `max_overpay_sat_per_eh_day` → `overpay_sat_per_eh_day`. The "max_" prefix was misleading — the field is the (fixed) overpay we always aim for, not the upper bound of a varying amount. The only "max" semantic is the absolute `max_bid` cap that clips overheated markets. |
| 1.9     | 2026-04-19 | Repurposed `lower_patience_minutes`: the patience window now measures continuous lowering-readiness (primary > fillable + overpay + min_lower_delta), not continuous above-floor time. The old semantics fired lowering after a few minutes of a bid filling at marginal overpay; the new semantics require the market to be *meaningfully* cheaper than the current bid for the full window before lowering. Column `runtime_state.above_floor_since_ms` renamed to `lower_ready_since_ms` (migration 0032). Behaviour change, not a config-shape change — existing `lower_patience_minutes` values keep their meaning in wall-clock minutes. |
| 1.8     | 2026-04-19 | Composite roll-up of features shipped 2026-04-16 to 2026-04-19: (a) `lower_patience_minutes` — required above-floor duration before lowering, persisted across restarts in `runtime_state.above_floor_since_ms`; (b) Ocean integration — `/api/ocean` surfaces hashprice, pool stats, recent blocks (including own-found markers on the hashrate chart), and time-to-payout; hashprice is recorded on every `tick_metrics` row and plotted historically; (c) `max_overpay_vs_hashprice_sat_per_eh_day` — optional dynamic cap, effective cap becomes `min(max_bid, hashprice + this)`; simulator mirrors the same skip-tick guard; (d) opportunistic cheap-mode scaling (`cheap_target_hashrate_ph`, `cheap_threshold_pct`) — scales above the normal target when the market is cheap vs hashprice; (e) what-if simulator (`POST /api/simulate`) — stateless backtest over historical `tick_metrics` with candidate strategy parameters, surfaced on the Status page as a toggleable overlay on the live charts; (f) retention pruning (`tick_metrics_retention_days`, `decisions_uneventful_retention_days`, `decisions_eventful_retention_days`) — hourly pruner service; (g) Datum Gateway integration (optional) — `datum_api_url` enables polling `/umbrel-api` each tick, records `tick_metrics.datum_hashrate_ph` alongside Braiins's reading, surfaces connected workers + gateway-measured hashrate on a dedicated Datum panel. Integration is informational-only; control loop never depends on Datum being reachable. See `docs/setup-datum-api.md` for the Umbrel port-exposure recipe (tested and running stable since 2026-04-19). |
| 2.0     | 2026-04-23 | CLOB pricing rewrite: retired the depth-aware `fillable + overpay` formula and all associated knobs (`overpay_sat_per_eh_day`, `escalation_mode`, `fill_escalation_step_sat_per_eh_day`, `fill_escalation_after_minutes`, `min_lower_delta_sat_per_eh_day`, `lower_patience_minutes`). The bid now sits at the effective ceiling `min(max_bid, hashprice + max_overpay_vs_hashprice)` every tick — matching is cheapest-ask-first so the ceiling is a matching-access threshold, not the price paid. Also retired the what-if simulator (v1.8e). |
| 2.1     | 2026-04-23 | Pay-your-bid correction (#53). Direct A/B verification on live data (50k→49k bid drop → 50,300→49,899 sat/PH/day effective cost drop, with fillable ask unchanged) falsified v2.0's CLOB assumption. Restored depth-aware fillable tracking: bid = `min(fillable_ask + overpay_sat_per_eh_day, effective_cap)`. Reintroduced `overpay_sat_per_eh_day` (default 1,000 sat/PH/day) as the one pricing knob; the escalation/patience/min-lower-delta subsystem from v1.x stayed retired — under direct fillable tracking the optimal price is proposed every tick and Braiins' own 10-min cooldown is the only pacing rule needed. |
| 2.1.1   | 2026-04-24 | Follow-ons to v2.1: EDIT_PRICE deadband `max(tick_size, overpay/5)` to absorb orderbook jitter (was causing a trade storm at naive tick_size tolerance); migrations 0043/0045 revised to preserve `overpay_sat_per_eh_day` through the CLOB-redesign retirements (was silently resetting every operator's value on upgrade); `show_effective_rate_on_price_chart` config toggle added with migration 0046 (effective line hidden by default because its volatility crushes the flatter-line detail); fillable drawn as first-class cyan line on the Price chart; hero PRICE and AVG COST / PH cards got explanatory tooltips; event-detail tooltip surfaces `fillable` and `overpay` as first-class rows. Docs sync against code same day — README / spec / architecture rewritten to match the pay-your-bid reality; older CLOB-era phrasing removed. |
| 2.2     | 2026-04-25 | Appliance packaging release (v1.3.0; closes umbrella issue #56). Three resolution layers for both config and secrets: `BHA_*` env vars (priority 1) > `.env.sops.yaml` (priority 2) > `secrets`/`config` rows in `state.db` (priority 3, populated by the new first-run web wizard). Migration 0047 adds the `secrets` table. Daemon enters `NEEDS_SETUP` mode when both config and secrets are absent, exposing only the wizard's three endpoints (`/api/health`, `/api/setup-info`, `/api/setup`); on POST /api/setup it transitions in-place to operational mode without a process restart. New public `/api/health` endpoint (`{ status, mode }`) doubles as the appliance liveness probe and the dashboard's setup-mode probe. Dockerfile + GHCR publish workflow (multi-arch `linux/amd64` + `linux/arm64`); image at `ghcr.io/<owner>/hashrate-autopilot:vX.Y.Z`. Bitcoind RPC creds auto-detect from the standard `BITCOIN_RPC_*` env vars Umbrel/Start9 inject. Wizard auto-binds the worker identity (`<btc-address>.<label>`) to the BTC payout address with a hard-red mismatch warning; same logic ported into the Config page. Power-user `setup.ts` + SOPS path is unchanged. |
