# Hashrate Autopilot - Specification (v2.13)

> Status: current, aligned with code through 2026-06-15 (v1.15.0).
>
> This spec has been through three pricing regimes. **v1.x** used a depth-aware "fillable + overpay" controller with escalation timers, lowering-patience, and a dampening subsystem. **v2.0** (2026-04-23, same day) retired all of it on the hypothesis that Braiins matched CLOB-style and the bid was a matching-access ceiling. **v2.1** (2026-04-23, hours later) reversed v2.0 after a direct A/B on the live account showed Braiins matches pay-your-bid - the bid price *is* the paid price. The current controller tracks `fillable_ask + overpay_sat_per_eh_day` (the v1.x primitive) without the v1.x timer machinery (which was only needed to simulate that target under a misread of the mechanic); the retired escalation/patience/min-lower-delta knobs stay retired.
>
> Earlier history: v1.0 (2026-04-14) was built around a constraint - that Braiins requires 2FA on every `POST`/`PUT` - which empirical testing on a live account on 2026-04-15 disproved for the owner-scope API token. v1.1 removed the confirmation bot, quiet-hours machinery, pending-confirmation / confirmation-timeout action modes, and operator-availability flag. v1.2-1.9 layered on depth-aware pricing, cheap-mode opportunistic scaling, the Ocean and Datum Gateway integrations, the hashprice-relative dynamic cap, and retention-managed persistence. The what-if simulator shipped in v1.8 and was retired in v2.0 along with the fill-strategy knobs.
>
> v2.2 added appliance packaging (Docker / GHCR / Umbrel / first-run web wizard); v2.3 was a doc-only consistency sweep. v2.4 brought the Telegram notification system, Dynamic DNS, and the Config page four-tab reorganisation. v2.5-v2.6 added chart UX refinements (click-to-focus zoom, viewport-scoped Y-axis, daemon-offline gap bands), the debug API, mobile UI, and major dependency upgrades. v2.7 added Datum-down auto-cancel (#199), pool luck 30d (#201), and solo fleet best-difficulty tracking (#204). v2.8 introduced fee protection (#222) and the configurable bid-edit deadband (#224). v2.9 was a consolidated catch-up covering payout-lifecycle Telegram alerts (#226), the Display & Logging locale plumbing (#227, #228), historical network-difficulty backfill (#230), BIP 110 scanner restructure (#231, #233, #234, #235, #237), and user-configurable chart colors (#238). **v2.10** (this revision) covers #240 follow-ups and #241: the on-chain `collected` tile reads lifetime received (sum of `reward_events.value_sat`) instead of current UTXO balance so spent payouts still count; boot-time address-mismatch refresh wipes stale `reward_events` when the operator's `btc_payout_address` changed mid-run on a pre-build-564 daemon; an additive boot-time `runHistoricalBackfill` kicks on every restart so users who never changed addresses still pick up TXs that were missed by prior boots (e.g., the pre-build-558 coinbase-only filter). #241 adds boot-time offline-gap reconstruction (`runGapBackfill`): walks all `synthetic = 0` rows in the last 365 days, finds every consecutive pair where the delta exceeds 10 min, inserts a synthetic tick every 5 min across each gap plus one tick at each retarget canonical time (multi-retarget via bitcoind, single nearest-pool-block-estimated retarget without), cadence ticks colliding with a canonical retarget's 30-min bucket are skipped so chart bucket-AVG aggregation doesn't smear the marker. `runPoolLuckRecompute` bypasses its 30d-eligibility gate for `synthetic = 1` rows so fresh installs (shallow `pool_blocks` coverage) still get `pool_luck_*` populated on gap synthetics. Migrations 0104 (`tick_metrics.synthetic`) and 0105 (`runtime_state.last_backfilled_payout_address`).
>
> See the document history at the bottom for the per-version breakdown.

## 1. Purpose

A personal-scale autopilot that keeps one user's orders on the **Braiins Hashpower marketplace** continuously active
and cost-optimized within the operator's tolerance, so purchased hashrate keeps landing at the user's Datum-connected
pool without manual babysitting. Replaces the current failure mode: "orders cancel overnight, zero hashing in the
morning."

The goal is **bounded, observable downtime** with an explicit recovery policy - not gapless uptime. Orders can be
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

Exactly one: the operator, running this on a home always-on box, on or alongside a Bitcoin node. It now supports
Umbrel, Docker and scripted installs. See README.md for details.

## 4. Runtime environment

- **Host:** a dedicated always-on machine on the operator's LAN. Can be the same physical box that runs the Bitcoin node + Datum Gateway, or a separate always-on machine alongside it. Tested on bare-metal Linux, Docker on Linux, and the Umbrel app store packaging; nothing in the daemon assumes any particular Bitcoin-node platform.
- **Network access required:** Braiins Hashpower API (internet egress - `hashpower.braiins.com`), Datum Gateway
  stratum+tcp access (LAN, typically port 23334).
- **Network access recommended:** Bitcoin RPC or **much** better an Electrum-server endpoint on the LAN (electrs, Fulcrum, and ElectrumX all speak the same protocol). This will allow you to
  track your payout address and have a working Profit & Loss panel on the dashboard.
- **Persistence:** state, ledger, and tick history must survive host reboots.
- **Secrets:** Braiins owner token (required) + optional read-only token, optional `bitcoind` RPC credentials,
  mandatory dashboard password.
- Resolution priority on boot is `BHA_*` env vars > sops-encrypted file (`.env.sops.yaml`) > the `secrets` table in
  `state.db` (populated by the first-run web onboarding wizard). Tokens must never appear in logs.
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
    - Transactions (on-chain + internal): `GET /v1/account/transaction`
- Block reward payouts observed via an **Electrum server** (electrs / Fulcrum / ElectrumX; preferred, instant lookups) or `bitcoind` RPC (`listreceivedbyaddress` / `gettransaction` / `scantxoutset` fallback) against any reachable Bitcoin node on the LAN. The node can be Bitcoin Knots / Bitcoin Knots running on Umbrel, Start9, a NAS, a VPS, or bare metal; the daemon just needs RPC or Electrum-protocol reach to it.
- Datum Gateway endpoint reachability (TCP connect health check, port 23334).
- Datum Gateway API (normally port 7152; no auth):
- Ocean API (public)
- User-editable configuration (see §8).
- Dashboard run-mode and manual-override signals.

**Per-tick persistence (`tick_metrics`):**

Every tick the daemon writes a row to `tick_metrics` with the canonical chart + stats + accounting series. Beyond the original
`delivered_ph`, `target_ph`, prices, `share_log_pct`, and `primary_bid_consumed_sat`, the table now also persists (migrations
0053-0060):

- Ocean-derived: `network_difficulty`, `estimated_block_reward_sat`, `pool_hashrate_ph`, `pool_active_workers`,
  `ocean_unpaid_sat`. (#89)
- Braiins-derived: `braiins_total_deposited_sat`, `braiins_total_spent_sat`, `primary_bid_last_pause_reason`,
  `primary_bid_fee_paid_sat`, `primary_bid_fee_rate_pct`. (#89)
- BTC/USD oracle: `btc_usd_price` + `btc_usd_price_source` (per-tick attribution so historical readings stay attributable to
  the source they came from). (#89)
- Pool blocks + luck: `pool_blocks_24h_count`, `pool_blocks_7d_count`, `pool_blocks_30d_count`, `pool_hashrate_ph_avg_24h`, `pool_hashrate_ph_avg_7d`, `pool_hashrate_ph_avg_30d`, `pool_luck_24h`, `pool_luck_7d`, `pool_luck_30d` (gap-based per-tick luck = `(600 / pool_share) / time_since_last_pool_block`). (#92, 30d extension #201 migration 0093)
- Braiins share counters: `primary_bid_shares_purchased_m`, `primary_bid_shares_accepted_m`, `primary_bid_shares_rejected_m` — cumulative-since-bid-creation counters in millions, snapshotted per tick from `/spot/bid/detail/{order_id}` for the primary owned bid. Null on ticks where the call failed, no primary bid existed, or pre-#243 history. The dashboard's rejection-rate chart series and Braiins card row compute `(Δrejected / Δpurchased) × 100` over the chart-range via `braiinsRejectionPctSince(since_ms, until_ms)`, returning null on insufficient samples or a single bid rotation in the window. (#243, migration 0106; migration 0107 scrubs orphan May 5-6 rows left over from the reverted #90 acceptance-ratio infrastructure.)

The full DDL (with comments and migration numbers) lives in `architecture.md` §5; this list is the operator-facing inventory.

**Public-IP rotation log (`ip_change_events`):**

Append-only log of public-IP changes. The daemon's `PublicIpService` polls `api.ipify.org` every 60 s (dropped from 5 min in v1.12 so a router rotation is detected within a poll cycle); when a different IPv4 is observed, a row goes into `ip_change_events` (`occurred_at`, `old_ip`, `new_ip`) and the change ripples into the DDNS updater (immediate re-push instead of waiting for the heartbeat). The dashboard renders each row as a router-icon marker at the top of the Hashrate chart with a styled tooltip (old → new IP pair, locale-formatted detection time), and the DDNS card on Config → Pool & Payout carries an "IP last changed" timestamp. Lets a rejection-rate spike be lined up against an ISP rotation. (#250, migration 0109.)

## 6. Outputs (actions)

- `POST /v1/spot/bid` (**create**) - fully autonomous. Only for orders the autopilot will tag in its local ownership
  ledger.
- `PUT /v1/spot/bid` (**edit**) - fully autonomous. Respects the 1-price-decrease-per-10-minutes cooldown. Cannot
  change `dest_upstream.url` (Braiins rejects - see §13).
- `DELETE /v1/spot/bid` (**cancel**) - fully autonomous. The order ID is passed in the JSON body; the query-string
  form is rejected (empirical, see `docs/research.md` v1.1).
- Dashboard UI (LAN bind).
- **External notification channel via Telegram** (#100, shipped post-v2.3). IMPORTANT / WARNING events POST to a configured chat with an inline-keyboard ack button (#109); INFO events (pool block credited, deposit lifecycle) are opt-in. The notifier is structured around a `NotificationSink` interface so a Nostr / ntfy / email backend could be swapped in without touching the event detectors. Full event list and throttling rules in §9.1.

## 7. Run mode and the mutation gate

### 7.1 Run mode (operator-controlled)

- **DRY-RUN** - default at every startup. The autopilot observes state and computes what it *would* do, writing
  decisions to the log and dashboard. It does not call any mutating Braiins endpoint. Read-only API access continues.
  Operator promotes DRY-RUN → LIVE via a button in the dashboard.
- **LIVE** - the autopilot may execute create / edit / cancel.
- **PAUSED** - operator or controller-entered hard stop. No creates, edits, or cancels. Observation continues.
  Entered on: operator pause button, sustained pool outage, unknown-order ambiguity.

Run mode on startup is chosen by the `boot_mode` config knob:

- `ALWAYS_DRY_RUN` (default) - every boot lands in DRY-RUN. Safest posture. Rationale: first-run-after-crash is
  exactly when inputs are most likely to be stale or inconsistent; human-in-the-loop at boot bounds blast radius.
- `LAST_MODE` - resume whatever mode the operator last set. PAUSED is demoted to DRY-RUN (PAUSED is a reactive
  state, never an initial one).
- `ALWAYS_LIVE` - boot directly into LIVE. Use only once the autopilot is proven and an unplanned restart should
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
- `destination_pool_url` - the Datum Gateway endpoint; **immutable on live bids** - if this changes, autopilot must
  cancel and recreate.
- `destination_pool_worker_name` - **must be `<btc-address>.<label>`.** Ocean TIDES credits rewards by the BTC address
  encoded in the identity, not by label; a bare label causes shares to be credited to no one. The setup CLI and
  dashboard config page validate this shape at write time.

**Pricing (unit: sat per EH/day, matching Braiins `price_sat` / `hr_unit = "EH/day"`):**

See also the "Pricing strategy" section further down - these three knobs feed the controller formula
`bid = min(fillable_ask + overpay_sat_per_eh_day, effective_cap)` where
`effective_cap = min(max_bid_sat_per_eh_day, hashprice + max_overpay_vs_hashprice_sat_per_eh_day)`.

- `overpay_sat_per_eh_day` - premium above the fillable ask. The one knob that tunes the controller:
  higher = more headroom against upward jitter at the cost of a bigger premium; lower = closer to the
  market but more sensitive to noise. Default 1,000,000 sat/EH/day (= 1,000 sat/PH/day). The dashboard
  displays it in sat/PH/day.
- `max_bid_sat_per_eh_day` - fixed safety ceiling. If `fillable_ask + overpay` exceeds this, the bid is
  clamped down (and may not fill). Intended as an opt-out price, not the normal bid.
- `max_overpay_vs_hashprice_sat_per_eh_day` *(optional, default null / disabled)* - dynamic
  hashprice-relative safety ceiling. When set, `effective_cap = min(max_bid, hashprice + this)`.
  Prevents the autopilot from following fillable off a cliff during a hashprice crash when the fixed
  `max_bid` alone would still allow it. Null / 0 falls back to the fixed `max_bid`; also falls back when
  Ocean hashprice data is unavailable - except: when the dashboard has configured the dynamic cap and
  hashprice is unknown, the controller refuses to trade that tick (silent skip) rather than ignore the
  configured ceiling.

**Budget:**

- `bid_budget_sat` - size of the `amount_sat` on each created bid (governs bid lifetime). **0 is a sentinel** meaning "use the full available wallet balance on each CREATE" - resolved at decision time and clamped to Braiins' 1 BTC per-bid hard cap. New installs default to 0; existing installs keep whatever explicit value is in their config. When the sentinel is active but the wallet is empty (or the balance API has failed), the CREATE is skipped silently until a balance is observed.
- `wallet_runway_alert_days` - threshold below which the wallet-runway Telegram alert fires (#116). **0 = disabled** end-to-end (no transition arming, no Telegram POST, no alert row). New installs default to 0 so a freshly-installed unfunded-wallet daemon does not IMPORTANT-alert mid-wizard; operator chooses a value when they are ready to be told. Field type is `nonNegativeNumber` (fractional days allowed, e.g. 0.5; `dc86586`).

**Outage tolerance:**

Thresholds are individually tunable on Config -> Alerts & Notifications. Defaults are tight so a fresh install catches problems fast; operators loosen as needed.

| Threshold                                | Default |
|------------------------------------------|---------|
| `below_floor_alert_after_minutes`        | 10      |
| `zero_hashrate_loud_alert_after_minutes` | 15      |
| `pool_outage_blip_tolerance_seconds`     | 120     |
| `api_outage_alert_after_minutes`         | 10      |
| `datum_unreachable_alert_after_minutes`  | 10      |
| `sustained_paused_alert_after_minutes`   | 10      |

`pool_outage_blip_tolerance_seconds` drives the dashboard-pill blip tolerance only; no longer drives any alert threshold since #135.

**Pricing strategy (v2.1 - pay-your-bid fillable-tracking):**

Empirical A/B on 2026-04-23 falsified the v2.0 CLOB assumption: Braiins matches **pay-your-bid**, not
pay-at-ask (lowering the bid by ~100 sat/PH/day directly lowered effective cost by a comparable amount,
with the orderbook's fillable ask well below both bids). The bid price is the price paid.

Per-tick target: **`min(fillable_ask + overpay_sat_per_eh_day, effective_cap)`** where
`effective_cap = min(max_bid_sat_per_eh_day, hashprice + max_overpay_vs_hashprice_sat_per_eh_day)` and
`fillable_ask` is the cheapest price at which the orderbook's cumulative *unmatched* ask supply covers
`target_hashrate_ph` (`cheapestAskForDepth(asks, target)` - walks asks in ascending price, accumulating
`max(0, hr_available_ph − hr_matched_ph)` per level, returns the price where the running total first
covers the target).

When `fillable_ask` is null (orderbook empty / API down) the tick is skipped - defaulting to the cap is
exactly the money-burn this controller unwinds. Braiins' 10-min price-decrease cooldown is the only
pacing rule below the decide layer; no escalation ladder, no patience timers (retired in v2.0, not
brought back). The ceilings exist for (a) wallet runway, (b) opting out of pathologically expensive
market conditions - they are not the normal bid.

**EDIT_PRICE deadband.** Emitted when `|target_price − current_bid_price| >= max(tick_size, overpay_sat_per_eh_day × bid_edit_deadband_pct / 100)`. `bid_edit_deadband_pct` defaults to 20 (#222), reproducing the legacy hard-coded `overpay / 5`. At the default overpay (1,000 sat/PH/day) this is a ~200 sat/PH/day deadband, absorbing the ±1-5 sat/PH/day orderbook jitter that would otherwise trigger a mutation per tick. Operator raises to 50 to halve edit frequency and tolerate ~2x more jitter before re-pricing - useful as a chart-noise reducer and as per-edit-fee mitigation if Braiins ever introduces an EDIT fee. Never below `tick_size` - Braiins rejects smaller edits. Applied symmetrically to raises and lowers; the 10-minute Braiins cooldown on price decreases is enforced one layer below by `gate.ts`.

**Fee-threshold halt** (#222). The mutation gate adds a `FEE_THRESHOLD_EXCEEDED` denial reason. When any active owned bid (`status === 'BID_STATUS_ACTIVE'`) carries `fee_rate_pct > config.max_acceptable_fee_pct`, gate blocks `CREATE_BID` / `EDIT_PRICE` / `EDIT_SPEED`. `CANCEL_BID` is intentionally not gated - the operator (or the Datum-down auto-cancel path) can still bail out of a fee-bearing bid. The halt clears automatically the next tick every active bid is at-or-below the threshold; the threshold itself is the operator's acknowledgement. Default `max_acceptable_fee_pct = 0` halts on any non-zero `fee_rate_pct`, matching the existing `beta_exit` Telegram alert semantics. Status panel renders the gate reason as "Braiins fee above your threshold" on the proposals strip.

**Cheap-mode interaction.** Cheap-mode (below) changes `target_hashrate_ph` opportunistically; the
pricing formula is unchanged.

- `handover_window_minutes` - manual-override suppression window. Default 30 (lives in `APP_CONFIG_DEFAULTS`, not the Zod schema's `.default()`).

**Daemon startup:**

- `boot_mode` - `ALWAYS_DRY_RUN` (default, safest) | `LAST_MODE` (resume, with PAUSED → DRY_RUN) | `ALWAYS_LIVE`.

**Opportunistic scaling (cheap-mode):**

Lives in its own section on Config -> Strategy (#136) with an explicit **Enable cheap mode** checkbox at the top. When unchecked, the three fields grey out and are non-interactive; the daemon's activation sentinel is `cheap_threshold_pct > 0` (toggle-on writes 95, toggle-off writes 0). Three knobs:

- `cheap_target_hashrate_ph` - higher-than-normal target to run when the market is cheap (default 0 = disabled).
- `cheap_threshold_pct` - cheap-mode activates when **our bid** (`fillable_ask + overpay` - the price we'd actually post under the pay-your-bid controller) drops below `hashprice x (cheap_threshold_pct / 100)`. The reference is what we ourselves are paying, not the order book's `best_ask`: under pay-your-bid the cheapest posted level is irrelevant if our overpay pushes the bid above it. Both `cheap_target_hashrate_ph` and `cheap_threshold_pct` must be non-zero to activate. When cheap-mode is active, the pricing formula is unchanged - only `target_hashrate_ph` is swapped out for `cheap_target_hashrate_ph`, which feeds into `cheapestAskForDepth` and the bid's `speed_limit_ph`.
- `cheap_sustained_window_minutes` - sustained-window length for the engagement check (#50 / #160). Default 0 keeps the legacy per-tick spot behaviour. When > 0, cheap-mode engages only when **every** tick in the last N minutes had `(fillable + overpay) < (cheap_threshold_pct / 100) x hashprice` AND there are at least N ticks of complete data (one per minute at the 60 s tick cadence). "Sustained" is literal: every sample must pass, not just the windowed average - one outlier mustn't drag an average below the threshold and trip the scale-up. The N-tick minimum keeps cheap-mode off through cadence gaps (a missed tick → < N samples → not engaged); we'd rather miss a genuine opportunity than fire on incomplete evidence. No spot-fallback when the operator has opted into a window - the sustained semantics is what they configured, and falling back to a spot check on insufficient history defeats the entire point.

**Datum Gateway integration (optional, informational only):**

- `datum_api_url` - HTTP base URL of the Datum Gateway's `/umbrel-api` endpoint. When null, the dashboard's Datum
  panel shows a "not configured" empty state and the daemon writes `null` to `tick_metrics.datum_hashrate_ph`.
  When Datum stratum is unreachable for 3+ consecutive ticks, the controller cancels all active bids to stop spend (see §9 "Datum pool unreachable").
  See `docs/setup-datum-api.md` for the Umbrel-side port-exposure recipe.

**Retention (append-only tables):**

- `tick_metrics_retention_days` - default **0 = keep forever** (cheap numeric series; backs every chart). Set to a positive integer to prune rows older than N days.
- `decisions_uneventful_retention_days` - default 7 (rows with no proposals; heavy JSON state snapshots - main bloat lever).
- `decisions_eventful_retention_days` - default **0 = keep forever** (rows with at least one proposal - rare and high-value forensic records).
- `alerts_retention_days` - default **0 = keep forever** (Telegram notification history; small rows so the cost of forever-retention is negligible). Set to a positive integer to prune older alert rows.

The daemon runs a pruning pass once per hour; the controller is untouched by retention.

**Chart smoothing (display-only, not read by the control loop):**

- `braiins_hashrate_smoothing_minutes` - default 1. Rolling-mean minute window the dashboard applies to
  the `delivered (Braiins)` series on the Hashrate chart. 1 = raw.
- `datum_hashrate_smoothing_minutes` - default 1. Same, for `received (Datum)`.
- `braiins_price_smoothing_minutes` - default 1. Rolling-mean window applied client-side to the Price
  chart's `our bid` and `effective` series. `fillable`, `hashprice`, and `max bid` are market-wide
  signals and stay raw. The `effective` line is noisy at tick resolution because Braiins'
  `amount_consumed_sat` counter settles asynchronously from `avg_speed_ph`; a rolling mean lets the
  operator see the trend rather than per-tick quantisation.
- `show_effective_rate_on_price_chart` - default `false`. When true, the emerald `effective` line is
  rendered on the Price chart and participates in Y-axis auto-scaling. Off by default because the
  line's per-tick volatility (counter settles in lumps; aggregated rate dives between settlements) pulls
  the Y-axis down and crushes the flatter bid / fillable / hashprice / max-bid detail into a thin band.
  The hero PRICE card and the AVG COST / PH DELIVERED stats card already surface the effective rate as
  a number - the line is only useful for operators inspecting settlement rhythm directly.
- `show_share_log_on_hashrate_chart` - default `false`. When true, the Hashrate chart renders our
  share of Ocean's pool hashrate (`share_log_pct`) as a violet line on a second Y-axis (right side,
  labelled `% of Ocean`, formatted to 4 decimals - matches Ocean's display, e.g. `0.0182%`). The
  series is sourced from a new `tick_metrics.share_log_pct` column (recorded each tick from Ocean's
  `/statsnap` payload, alongside `hashprice_sat_per_ph_day`). Off by default because the line is
  informational - the controller does not read it - and adding a second Y-axis to a chart that
  already carries 3-5 hashrate lines costs more glance-time than most operators need. Useful when
  comparing how our slice of the pool drifts as Ocean's total hashrate grows or our delivered PH/s
  fluctuates.

Ocean is not smoothed client-side because `/user_hashrate` already returns a server-side 5-min average;
setting `braiins_hashrate_smoothing_minutes` and `datum_hashrate_smoothing_minutes` to 5 visually aligns
all three series on the same cadence.

**Dashboard & accounting:**

- `chart_max_markers` - cap on all chart markers across both charts (#123, extended #172). The cap counts bid events + pool blocks + reward events together; when over budget, markers drop in priority order: EDIT_PRICE bid events (low-signal), non-own pool blocks (sky-blue context dots), reward events, then everything. Both the Hashrate and Price charts show a "N markers hidden (cap)" banner when any markers are suppressed. Default 0 = no cap.
- `spent_scope` - `'autopilot'` | `'account'` (default). Drives the P&L panel's "spent" figure: autopilot-tagged bids only, vs the whole Braiins account ledger. Live-editable from the Pool & Payout tab.

**Solo-mining monitoring (optional, #149):**

- `solo_mining_enabled` - master toggle. Default `false`. When off, the AxeOS poller doesn't run, the Status card is hidden, and the four solo-mining alert classes never fire. The device list in the `solo_miners` table is preserved across toggles so re-enabling later doesn't require re-entering IPs.
- `solo_overheating_threshold_celsius` - global thermal ceiling override for the **ASIC silicon-junction sensor only** (°C). Default 0 = 75 °C across all BM13xx chips, matching AxeOS firmware's `THROTTLE_TEMP` (`main/tasks/power_management_task.c`). Firing at the AxeOS throttle threshold means the alert lines up with the moment the miner itself reduces frequency. There is no per-chip-model differentiation in the firmware so the autopilot doesn't differentiate either - earlier versions had a guessed per-model table (BM1370 = 68 °C, BM1368/66 = 70 °C, BM1397 = 75 °C) that fired well before AxeOS itself would have acted. Operator-set non-zero values override the 75 °C default. The VR (voltage regulator) sensor uses a separate hardcoded ceiling of 100 °C; AxeOS's `TPS546_THROTTLE_TEMP` is 105 °C and we fire 5 °C earlier to give the operator reaction time before AxeOS itself throttles or trips overheat-mode.
- Overheating sustain window: 90 seconds (hardcoded; ~3 ticks at 30s cadence). Not operator-tunable - the value matches AxeOS firmware behavior and rarely needs changing.
- `solo_zero_hashrate_alert_after_minutes` - how many consecutive zero-hashrate (or unreachable) minutes trigger the alert. Default 5.
- `solo_share_rejection_threshold_pct` - rolling-window rejection-rate threshold. Default 10.
- `solo_share_rejection_window_minutes` - rolling-window length for the rejection-rate computation. Default 60.
- Stratum drift detection is always active (fires when a device's `stratumURL` changes from the previously-observed value). Baselined silently on first poll so adding a device doesn't fire a spurious drift alert. Disable via the generic per-class mechanism (`notification_disabled_event_classes` includes `solo_stratum_drift`).

Temperature display unit (°C / °F) is operator-selectable on Config -> Display & Logging alongside Number format and Date layout (#157). Database storage and Telegram alert bodies stay in °C; conversion happens at the dashboard display boundary only. The `solo_overheating_threshold_celsius` field round-trips through the conversion on the input (operator can type in their chosen unit; daemon always stores °C). `system` default uses Fahrenheit when the UI language is English (US-convention split) and Celsius otherwise.

Per-device fields (`solo_miners` table, not on `config` - internal table/field names retain the `solo_*` prefix even though the user-facing label is "Bitaxe miners" since v1.12): `id`, `label`, `ip` (IPv4 or hostname), `enabled` (per-device pause without losing the row), per-ASIC ceiling override (rarely set), creation timestamp. Add / remove / pause through Config -> Display & Logging -> Bitaxe miners; a "Scan local network" button there probes a /24 and returns AxeOS-shaped responders so adding a fleet doesn't require typing every IP. The scan defaults to the daemon's auto-detected /24, with an inline override field for the cases (Umbrel docker bridge, or any docker network not matching the host LAN) where the daemon's interface address isn't where the miners live. The override is persisted in `localStorage` so the operator only types it once per browser. The sweep runs on the daemon as a background worker at concurrency 8 with a 1.5 s per-IP timeout; `POST /api/solo-miners/scan` kicks off the run and returns immediately, the dashboard polls `GET /api/solo-miners/scan/status` every ~400 ms to render a progress bar and stream candidates as they're discovered. The chunked design replaces the original one-shot 254-way `Promise.all` that intermittently came back empty on Docker + Wi-Fi paths (cold ARP + ESP32 small-HTTP-stack drops under a 254-way SYN burst).

**Integrations:**

- `btc_payout_address`
- `bitcoind_rpc_url` + `bitcoind_rpc_user` + `bitcoind_rpc_password` (live-editable; seeded from sops secrets on
  first boot)
- Optional `electrs_host` + `electrs_port` (preferred over `bitcoind` RPC for balance lookups - instant)
- `payout_source` - `none` | `electrs` | `bitcoind`
- `include_historical_payouts` - boolean (default `true`, #170). When `true`, the payout-observer's electrs path enumerates every coinbase tx ever credited to `btc_payout_address` (via `blockchain.scripthash.get_history`) and folds them into `reward_events`, so the chart's lifetime-earnings line reflects historical Ocean payouts even after the operator sweeps them. When `false`, only currently-unspent outputs are counted (pre-1.7.5 behaviour). Bitcoind-only setups ignore this knob: backfill is electrs-only. The dashboard exposes a "Backfill now" button under Pool & Payout that POSTs `/api/payouts/backfill` and runs the same loop on demand (ignores this gate; explicit operator action).
- `historical_payouts_offset_sat` - non-negative integer (default `0`, #170 follow-up). Operator-entered offset for earnings the on-chain payout observer can't see (Lightning payouts, pre-autopilot Ocean history that's already been swept, etc.). Added to the lifetime-earnings chart's starting value AND to the Status finance panel's `net_sat` (and surfaced as a dedicated `historical_offset_sat` field on `/api/finance` and a "pre-installation (manual)" row on the Status P&L). Lets users with pre-installation pool history get a coherent P&L without rotating their payout address.
- `debug_api_enabled` - boolean (default `false`, #179). When `true`, `GET /api/debug/dump` returns a bundled JSON snapshot of tick_metrics, pool_blocks, alerts, bid_events, reward_events, whitelisted config fields, and daemon info. When `false` (default), the endpoint returns 404 and doesn't advertise its existence. Supports `?hours=N` (default 24, max 168) and `?tables=tick_metrics,bid_events,...` filters. Config fields use a whitelist approach - only explicitly safe fields are included; tokens, passwords, and credentials are omitted entirely rather than redacted. Migration 0092.
- `block_explorer_url_template` - URL template applied at click time on every dashboard surface that links to a block (Hashrate-chart cube markers, OCEAN panel "last pool block" row, BIP 110 scan results, BlockTooltip). Placeholders `{hash}` and `{height}` are substituted; at least one must be present. Default `https://mempool.guide/block/{hash}` (#289 follow-up): a mempool.space fork that surfaces BIP-110 miner signaling. The two BIP-110-aware instances (mempool.guide, mempool.kilombino.com) are both highlighted as yellow pills carrying the same neutral tooltip ("A mempool.space fork that surfaces BIP-110 miner signaling.") - the highlight flags BIP-110 support without favouring one over the other; mempool.guide is simply the technical default a fresh install starts on. Privacy-conscious operators point this at their own explorer (e.g. `http://umbrel:3006/block/{hash}`); the Config page exposes mempool.guide / mempool.kilombino.com / mempool.space / blockstream.info / blockchair.com / btcscan.org / btc.com presets plus a free-form custom field. (#22)
- `block_explorer_tx_url_template` - separate template for transaction links (the on-chain payout dot on the Price chart deep-links via this). Placeholders `{txid}` and `{hash}` are substituted; default `https://mempool.guide/tx/{txid}`. Migration 0071 derives the value from the operator's existing block template via known-preset matching, falling back to a `/block/{hash}` -> `/tx/{txid}` string replacement (catches local-Umbrel mempool variants). Config-page presets set both block + tx templates atomically.
- `btc_price_source` - `none` | `coingecko` | `coinbase` | `bitstamp` | `kraken` (feeds the dashboard sat <-> USD toggle)
- `block_found_sound` - `'off'` (default) | bundled name (`cartoon-cowbell`, `glass-drop-and-roll`, `metallic-clank-1`, `metallic-clank-2`, `ocean-mining-found-block`) | `'custom'` (operator-uploaded MP3, <=200 KB, stored as SQLite blob via `POST /api/config/block-found-sound`). Dashboard fires the chosen sound once per new Ocean pool block (max-`height` increment over `/api/ocean.recent_blocks`); first-poll-after-load establishes a silent baseline so the existing backlog never replays. Operator's intent is "a block was found" not "an on-chain payout to my address confirmed" - the trigger is Ocean, not the `reward_events` payout-observer table. (#88, migration 0052)
- Braiins `owner_access_token` + optional `read_only_access_token` (stored in sops secrets, not the config table)

**Telegram notifications (#100 / #106 / #109 / #117):**

- `telegram_bot_token` - bot credential from @BotFather. Live-editable from the dashboard; mirrors the `bitcoind_rpc_password` dual-location pattern (config-table column overrides the secrets-table fallback). Empty string = unconfigured; the notifier short-circuits with `delivery_status='failed'`.
- `telegram_chat_id` - destination chat. Numeric ID from @userinfobot. Empty = unconfigured.
- `telegram_instance_label` - optional per-instance source label. When non-empty, the Telegram sink prefixes every message with `[<label>] ` so an operator running multiple daemons against the same bot/chat can tell them apart.
- `notifications_muted` - global mute toggle. When `true` the notifier still records every alert row with `delivery_status='muted'` for the audit trail, but skips the Telegram POST.
- `notification_retry_interval_minutes` - cadence between retry attempts while state remains bad. Default 30. First attempt fires immediately on threshold crossing; up to 4 retries follow at this cadence, then a final "giving up" message. Recovery messages bypass this entirely.
- `notification_disabled_event_classes` - per-class opt-out list (`string[]`, stored as comma-separated TEXT, #106). Empty = all classes enabled. When an event_class is in the list, the AlertEvaluator short-circuits before arming any timer - no alert row, no retry, no recovery. New event classes default to enabled (no migration required when adding one).
- `notify_on_pool_block_credit` - off-by-default INFO Telegram message at every TIDES credit (#117). Body contains block height, total reward, our credit in sat, our pool-share percentage at block time (as context, not the math derivation), and unpaid-total progress toward the 1,048,576-sat on-chain payout threshold. The credit number is Ocean's actual TIDES credit, computed as the delta in `ocean_unpaid_sat` between this alert and the previous `pool_block_credited` fire - the operator's pool-block alerts arithmetically reconcile against the unpaid totals (#239). When the delta isn't computable (first alert after restart, multiple blocks credited in the same tick, or a payout fired in the interval) the credit falls back to the `~share_log_pct × reward` estimate with a leading `~` to mark it. When the block triggers an on-chain payout (detected via the unpaid-delta heuristic: noticed_unpaid + our_share - current_unpaid >= 65,536 sat), the title gains a "+ ON-CHAIN PAYOUT" suffix and a new body line reports the payout amount in sat and BTC (#171). Severity is INFO (no retry ladder, no inline ack button). The audible cue and the chart marker fire independently of this toggle.
- `notify_on_braiins_deposit` - off-by-default master toggle for the Braiins deposit lifecycle events (`braiins_deposit_detected`, `braiins_deposit_available`, `braiins_deposit_returned`). A single tile on the Notifications tab gates all three under one switch (#141 / #143).
- `notify_on_payout_initiated` (#226) - off-by-default INFO Telegram message the moment the daemon observes Ocean debiting `ocean_unpaid_sat`. Detection heuristic: one-tick drop > 30% with residual below the 1,048,576-sat on-chain payout threshold. Body includes pre-drop and residual unpaid balances plus the inferred payout amount. At this moment Ocean has committed the payout and will settle it via its next batched sweep transaction (see §payout-observer: NOT necessarily a coinbase, NOT tied to a block Ocean mines); the transaction hasn't confirmed on-chain yet. Severity INFO, no retry ladder, no recovery message.
- `notify_on_payout_confirmed` (#226) - off-by-default INFO Telegram message when the on-chain payout scanner observes a new transaction crediting the configured payout address (any tx, not just a coinbase - Ocean pays out via batched sweeps). Source: a new row in the `reward_events` ledger (#102). Idempotency via an in-memory `lastNotifiedRewardEventId` watermark in `AlertEvaluator` (silent-baseline on first tick after boot so a fresh-install backfill of historical rows doesn't fire a flood). Body includes block height, payout amount, and a truncated tx id.
- `notification_locale` - language for Telegram alert copy. `'en'` / `'nl'` / `'es'`; default `'en'`. Independent of the dashboard's display language (#131). Picker on Config -> Notifications.

**Display & Logging preferences (#227 follow-up, migration 0102; #238, migration 0103):**

The Display & Logging tab on Config exposes three operator-visible preferences that the daemon mirrors so the Telegram render path and any operator-facing artifact uses the same formatting. localStorage on the browser side stays in sync via one-shot reconciliation on first mount plus PATCH-on-change.

- `display_number_locale` - thousands and decimal separator preset. `'system'` (default; resolves to `en-US` server-side because there is no browser context on the daemon), `'en-US'`, `'nl-NL'`, `'fr-FR'`, or `'no-grouping'` (`en-US` with thousands separators suppressed). Drives both dashboard `Intl.NumberFormat` calls and the Telegram message render path so an operator with `1.234,56` in the dropdown gets dot-thousands / comma-decimal in their Telegram too (#227 follow-up).
- `display_date_layout` - date / time rendering preset. `'system'` (default), `'us'`, `'eu-spaced-24h'`, `'slash-dmy-24h'`, `'iso'`, `'slash-mdy-12h'`. Controls order / separators / 12-vs-24h; month-name language always follows the UI language picker.
- `chart_color_overrides` - JSON object keyed by canonical series name with `#RRGGBB` values, default `'{}'`. Every named line, marker, and bid-event glyph on the Hashrate and Price charts resolves through `getChartColor(key, parseOverrides(json))`; missing keys fall back to the documented default. Settings UI on Config -> Display & Logging exposes a per-row picker (curated 12-swatch palette + native color input + reset-to-default) grouped into three sections: **Lines** (each chart's left + right-axis series), **Markers** (cross-chart icons - pool block cube + own-block crown + BIP 110-signalling cube + difficulty-retarget pickaxe + public-IP-change router + on-chain payout gem + Braiins deposit fuel-pump), and **Bid events** (per-tick create/edit/cancel/edit-speed glyphs plus the #287 lifecycle trio: mode-change power, bid-paused circle-pause, bid-resumed circle-play - the mode-change and bid-paused colors also tint the idle-state background bands). Each row carries a live SVG preview of its actual chart glyph in the resolved colour. The schema covers 25 named slots (11 line series + 7 markers + 7 bid-event glyphs). Malformed JSON, unknown keys, non-string values, and non-hex strings silently drop at parse time so a stray browser write can't break the chart. One historical key rename - `price.unpaid` → `price.marker_deposit` - is transparently migrated by the parser so saved overrides keep working. (#238 + v1.12 marker keys.)

**Daemon-managed Dynamic DNS (#111):**

The daemon polls `api.ipify.org` every 5 min for the box's current public IPv4, then (when configured) pushes the IP to a DDNS provider so the Braiins-facing hostname stays pointed at this machine without depending on the router's firmware. Catches the failure mode where a router-vendor DDNS service goes dark (mynetgear.com on 2026-05-07) or the router's update client silently fails. The Config page surfaces three diagnostic rows (daemon's public IP / Pool URL hostname / what the hostname resolves to) and a match / mismatch note that fires on hostname drift only - IP-only changes for the same hostname are silent (miners re-resolve on reconnect).

- `ddns_provider` - `''` (disabled) | `noip` | `duckdns` | `dyndns2`. Default `''`.
- `ddns_hostname` - the hostname being maintained (e.g. `alkimia.zapto.org`). For No-IP DDNS Key groups use the special `all.ddnskey.com` form to update every hostname in the group with one call.
- `ddns_username` - provider username (used by No-IP and dyndns2-generic; ignored for DuckDNS, which uses a token-only flow).
- `ddns_credential` - provider password / DDNS Key credential / DuckDNS token.
- `ddns_update_url` - dyndns2-generic only: provider's update endpoint (e.g. `https://api.dynu.com/nic/update`). Empty for the other providers.

The updater pushes on a 5-min cadence and on any save event that touches a DDNS-relevant field (`ddns_*` or `destination_pool_url`), so a config edit takes effect within seconds. Hourly heartbeat enforced even when the IP is unchanged, so providers with idle-expiry rules (No-IP free tier) stay alive. POST `/api/ddns/test` validates unsaved form values end-to-end against the provider before save.

## 9. Reliability & outage policy

**Hashrate below floor (alert timer, not escalation):**

- Controller continuously targets `min(fillable_ask + overpay_sat_per_eh_day, effective_cap)` PH/s at
  `target_hashrate_ph` capacity (see §8 "Pricing strategy").
- If actual hashrate drops below `minimum_floor_hashrate_ph`: start a timer, debounced by
  `FLOOR_DEBOUNCE_TICKS` (3) consecutive above-floor ticks before the timer clears - the Braiins
  `avg_speed_ph` field is a lagged rolling average that can briefly read above-floor during bid-state
  flickers, so a single recovery tick must not reset the clock.
- At `below_floor_alert_after_minutes`: surface a dashboard alert.
- At `zero_hashrate_loud_alert_after_minutes`: second louder dashboard alert.
- The controller does **not** react to below-floor state by changing the bid - there's no escalation
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
  are **not implemented** - the spec called for them in v1.x but v2.1's direct fillable tracking plus
  the deadband plus the full-wallet-balance `bid_budget_sat = 0` sentinel combine to make handover
  unnecessary in practice (bids rarely drain completely before the operator tops up the wallet). If the
  need resurfaces, file an issue; this spec section lists what the code does today.

**Datum pool unreachable:**

- The daemon probes the pool endpoint (TCP connect on the Datum Gateway port from
  `destination_pool_url`) every tick and records reachability + last-ok timestamp in `state.pool`. The
  dashboard's Datum Gateway service panel surfaces this state.
- `pool_outage_blip_tolerance_seconds` is the observer-side threshold below which the dashboard still
  reports the service as healthy (ignores transient blips).
- When `state.datum.consecutive_failures >= 3` (three consecutive ticks of Datum stratum being unreachable), the controller cancels all active bids to stop spend (#199). There is no point paying for hashrate that cannot reach the pool. When stratum recovers (consecutive_failures drops back to 0), the controller resumes normal operation and creates a new bid on the next tick. The `datum_unreachable` alert copy reflects this auto-cancel behavior.
- Braiins cancellation is asynchronous: after a successful `DELETE /spot/bid` the order lingers in the bids list as `BID_STATUS_PENDING_CANCEL` (observed up to ~3 minutes). The controller treats PENDING_CANCEL bids as already-gone for mutation purposes - it never re-cancels them (the Datum-down sweep and the keep-one-bid extras sweep both skip them) and never selects them as primary for price/speed edits - but they still gate CREATE, so a replacement bid is only posted once the old order has actually left the bids list (#276).

**Braiins API unreachable:**

- Retries with exponential backoff.
- Observations considered stale after `api_outage_alert_after_minutes`; dashboard alert.
- No automatic cancellation or destructive action based on stale state.

**Unknown-order detection:**

- If autopilot sees bids in the account whose IDs are not in its local ownership ledger, it transitions to PAUSED
  and alerts. Operator reviews: adopts (autopilot takes ownership) or dismisses (autopilot tracks for accounting
  only, never touches).

**All autopilot decisions are logged** with the input state that drove them, for post-hoc debugging.

### 9.1 External notification channel (#100, shipped)

The dashboard's `/alerts` page is the source of truth for the audit trail; Telegram is the
external push channel that wakes the operator when the dashboard isn't being watched.

**Channel:** Telegram only in v1.6+. The notifier is structured around a `NotificationSink`
interface so a future Nostr / ntfy / email backend can be swapped in without touching the
event detectors. Setup walkthrough at [`docs/setup-telegram.md`](setup-telegram.md).

**Events that fire Telegram:**

IMPORTANT severity (8 marketplace + 4 solo = 12 total) - hard outages that need a phone alarm:

1. **Datum stratum unreachable** for `datum_unreachable_alert_after_minutes` (#135 - was `pool_outage_blip_tolerance_seconds × 5`; now an independent knob with an inline-minute input on the Notifications tab).
2. **Hashrate below floor** for `below_floor_alert_after_minutes`.
3. **Zero hashrate** for `zero_hashrate_loud_alert_after_minutes`.
4. **Braiins API unreachable** for `api_outage_alert_after_minutes`.
5. **Wallet runway** below `wallet_runway_alert_days`.
6. **Unknown bid detected** (already triggers daemon auto-PAUSE; now also rings Telegram).
7. **Bid sustained-paused by Braiins** for `sustained_paused_alert_after_minutes` (#135 - was `pool_outage_blip_tolerance_seconds × 5`; now an independent knob).
8. **Braiins deposit returned** - compliance bounced a deposit back (`return_tx_id` non-null on the on-chain endpoint). Real money on the line.

IMPORTANT severity (Bitaxe miners, active only when `solo_mining_enabled = true` and the device is `enabled`; the daemon-internal config field name retains the `solo_*` prefix even though the user-facing label is "Bitaxe miner") (#149):

9. **Bitaxe miner overheating** - ASIC temp >= the ASIC ceiling (default 75 °C across all BM13xx chips, matching AxeOS firmware's `THROTTLE_TEMP`; overridable via `solo_overheating_threshold_celsius`) OR VR temp >= 100 °C (separate hardcoded ceiling; AxeOS's `TPS546_THROTTLE_TEMP` is 105 °C), sustained for 90 seconds (~3 ticks). The alert body names which sensor tripped. Paired recovery when both temps fall back below their respective ceilings.
10. **Bitaxe miner offline / not hashing** - device unreachable, OR not actually hashing, for `solo_zero_hashrate_alert_after_minutes` consecutive minutes. "Not hashing" covers a reported hashrate of 0 and (#291) a *reachable* miner that is provably halted: an explicit firmware halt flag (`overheat_mode` on stock Bitaxe, `shutdown` on NerdQAxe) or, on firmwares that report neither (NerdAxe), a physically impossible hashrate-per-watt (> 100 GH/s/W, ~1.4x the best real ASIC) that betrays a frozen reading. Without this a board that thermally halts but keeps publishing its last hashrate looked healthy and even triggered a false "back online". Paired recovery, which only fires once the miner is genuinely hashing again; the firing body names the cause (overheated / shut down / not hashing - reboot needed). The dashboard's Bitaxe card shows such a miner as 0 with a "reboot needed" badge and drops it from the fleet hashrate total.
11. **Bitaxe miner share-rejection high** - rolling-window rejection ratio >= `solo_share_rejection_threshold_pct` over `solo_share_rejection_window_minutes`. Re-arms once per window length; no recovery row.
12. **Bitaxe miner stratum URL drift** - device's reported `stratumURL` changed from the previously-observed value. Baselined silently on first poll so adding a device doesn't fire a spurious drift alert. No recovery row (new URL becomes the new baseline).

WARNING severity - soft warnings that can wait for the next dashboard glance:

13. **Beta-exit detected** - any active owned bid reports `fee_rate_pct > 0`.

INFO severity (opt-in, good news + lifecycle):

- **Pool-block credit** (TIDES) - opt-in Telegram via the `notify_on_pool_block_credit` toggle. Body contains block height, total reward, our credit in sat (Ocean's actual TIDES credit derived from the unpaid-delta against the previous fire, falling back to `~share_log_pct × reward` with a `~` prefix when the delta can't be computed - #239), our pool-share percentage at block time (read as context, not derivation), and unpaid-total progress toward the 1,048,576-sat on-chain payout threshold. When the block triggers an on-chain payout, the title gains a "+ ON-CHAIN PAYOUT" suffix and reports the payout amount (#171). No retry ladder; no inline ack button.
- **Braiins deposit detected** - fires when the on-chain endpoint returns a transaction with `DEPOSIT_STATUS_DETECTED` (mempool / first-confirmation). Gate: `notify_on_braiins_deposit` master toggle. All three deposit events are sourced from `BraiinsDepositWatcherService` polling `/v1/account/transaction/on-chain` (#210).
- **Payout initiated** (#226) - fires the tick `ocean_unpaid_sat` drops by more than 30% with the residual below 1,048,576 sat. Gate: `notify_on_payout_initiated`. Severity INFO. Mirrors the dashboard's `unpaidDropMarkers` heuristic on the Price chart so the chart-and-Telegram surfaces tell the same story.
- **Payout confirmed** (#226) - fires once per new `reward_events` row (the on-chain payout scanner observed a new transaction crediting the payout address - any tx, since Ocean pays out via batched non-coinbase sweeps). Gate: `notify_on_payout_confirmed`. Severity INFO. Idempotency via the in-memory `lastNotifiedRewardEventId` watermark, silent-baselined on first tick after boot.
- **Braiins deposit available** - fires when the same on-chain endpoint surfaces the deposit as `DEPOSIT_STATUS_CREDITED`. Same master toggle.
- **Marketplace empty** (#167, tightened #173) - fires when the Braiins orderbook has no asks that can fill the target hashrate AND counter-derived delivery is ~0 AND the Braiins API is reachable (state.market !== null), sustained for `marketplace_empty_alert_after_minutes` (default 5). The reachability gate prevents double-firing with the existing `api_unreachable` alert during outages. Recovery paired when supply returns. Off by default; opted in via the Notifications tab tile. The same detection also drives a yellow banner at the top of the Status page (renders instantly the tick both conditions match, no minute threshold). Historically, the Hashrate + Price charts show two distinct overlay bands for null-fillable spans: gray diagonal hatching for "marketplace empty" (reachable but no supply) and red diagonal hatching for "Braiins API unreachable" (#173). The discriminator is the per-tick `braiins_reachable` column in tick_metrics (migration 0091); pre-migration rows (braiins_reachable IS NULL) keep the legacy gray treatment.
- **Bitaxe miner best difficulty** (#204) - fires when a Bitaxe device reports a share difficulty exceeding the fleet-wide all-time high-water mark stored in `runtime_state.solo_best_difficulty_all_time` (field name retains the `solo_*` prefix per the internal-identifier convention). Off by default; opted in via the Notifications tab tile. The first measurement after enabling Bitaxe miner monitoring silently baselines the high-water mark without firing a notification. Body includes device label, new difficulty, and previous record. The Hashrate chart renders a staircase line and trophy markers for each record. Migration 0094.

**Dashboard-only INFO surfaces (no Telegram event):**

- **Ocean own-found block** - gold crown on the Hashrate chart (see §12.1). Visual-only marker; no `event_class`, no notification path.
- **On-chain payout received** - rendered on the P&L panel and as a dot on the Price chart's `paid earnings` series (#102). Detected by the payout observer (`reward_events`); no Telegram event class.

**Recovery messages**: paired with each fired IMPORTANT or WARNING. INFO severity. Body example:
`Datum gateway reachable again - was down 22m.` Includes a `paired_alert_id` FK to the
originating alert so the dashboard groups them visually on `/alerts`.

**Throttling (per state-transition into bad state):**

1. Initial alert fires immediately on threshold crossing (attempt #1).
2. Up to 4 retries while state is still bad. Cadence configurable via
   `notification_retry_interval_minutes` (default 30 min).
3. Final "giving up" message on attempt #5: `…still bad after 2h. No further notifications
   until recovery.`
4. Silence until either (a) state clears → recovery message fires, or
   (b) state transitions clear-then-bad-again → start the ladder over with attempt #1.

Total: at most 5 alert messages per outage event + 1 recovery message.

**Mute and ack:**

- **Global mute** (`notifications_muted` config flag): silences all Telegram POSTs; alerts table still records every row with `delivery_status = 'muted'` for the audit trail. **End-to-end**: also stops the `TelegramReceiver`'s `getUpdates` long-poll (#152) - the receiver re-checks credentials each loop iteration so the toggle takes effect within ~15 s, no restart needed. Matters when multiple daemon instances share the same bot/chat: `getUpdates` is single-consumer per bot, so a muted instance left polling would race-consume ack callbacks meant for the live instance.
- **Per-event-class opt-out** (`notification_disabled_event_classes`, #106): operator picks specific event classes to silence (Datum unreachable, hashrate below floor, beta-exit, ...) from the Notifications tab on the Config page. New event classes default to enabled - no migration required when adding one.
- **Inline ack on the Telegram message** (#109): every IMPORTANT / WARNING firing carries a `Mark as seen` inline-keyboard button. Tapping on the operator's phone sets `acknowledged_at_ms` server-side via the bot's long-polled `getUpdates` (no webhook, works behind home NAT), edits the message in place to confirm, and removes the keyboard. Single-operator security: callbacks from any chat that isn't the configured `chat_id` are rejected.
- **Per-instance label prefix** (`telegram_instance_label`): when set, the Telegram sink prefixes every message with `[<label>] ` so an operator running multiple daemons against the same bot/chat can tell them apart at a glance.
- **No quiet-hours config** - cancelled in v1.1 spec rewrite. Mute-on-demand replaces the use case.

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

- Total funded in (autodetected from `GET /v1/account/transaction` deposits; manual override possible).
- Current Braiins wallet balance.
- Cumulative spend (from filled bids; autopilot and foreign combined).
- Spend per calendar month.
- Cumulative block reward income detected at `btc_payout_address` via Electrs or `bitcoind` RPC, valued at BTC price
  at time of receipt. BTC price source: TBD - picked at implementation time. Two modes (#170, toggle
  `include_historical_payouts`, default ON): **full backfill** walks the address history via electrs's
  `blockchain.scripthash.get_history` and folds every tx crediting the payout address into `reward_events`, even
  ones whose outputs the operator has since swept off-address; **unspent-only** (toggle OFF) reverts to pre-1.7.5
  behaviour where only currently-unspent outputs at the address count. **As of v2.10 (#240 follow-up), the P&L
  collected tile reads `SUM(reward_events.value_sat) WHERE reorged = 0` (lifetime received) rather than the
  observer's in-memory UTXO total**, so a payout that's been spent still counts: "we count what they put in." The
  pre-build-558 coinbase-only filter that rejected non-coinbase Ocean batched-sweep payouts (Ocean's actual
  on-chain mechanism: a P2SH pool wallet sweeps coinbase outputs into a single multi-output tx to operators) has
  been dropped; any output paying the address counts. Backfill is electrs-only - bitcoind-only setups stay on the
  `scantxoutset`-based unspent-only path because a full chain scan is too expensive there. A dashboard "Backfill
  now" button under Pool & Payout triggers the same loop on demand (ignores the toggle gate; explicit operator
  action). On daemon boot, the additive `runHistoricalBackfill` runs unconditionally (#240 follow-up) so a TX
  that was missed by a prior boot's backfill gets a fresh look every restart; idempotent via
  `INSERT ... ON CONFLICT (tx_hash, output_index) DO NOTHING`.
- **Net result:** reward income minus spend, absolute and per-month.

Ledger is the source of truth for runway forecasting.

### 11.1 Per-day run-rate panel (issue #43)

The dashboard's **Profit & Loss · per day** card answers a different question than the lifetime ledger above:
*at the rate things are going right now, how much am I spending and earning per day?* Two key differences from
the lifetime ledger:

- **Range-aware.** Both spend/day and income/day are computed over the currently-selected chart range (3h, 6h,
  12h, 24h, 1w, 1m, 1y, All) - not a hardcoded window. The operator's intent when picking "24h" on the charts
  is "tell me what's happening over 24h"; the finance numbers below the charts must share that cadence.
- **Averaged inputs, not instantaneous.** A mid-day price change must not retroactively shift the entire day's
  projection; likewise a single-tick delivery dip must not move the number. Both sides use averages over the
  selected window.

**Spend/day:**
Per-tick deltas of the cumulative `primary_bid_consumed_sat` counter summed over the selected range and
scaled to a daily rate - i.e., what Braiins actually charged (settled cost), not a modelled
bid × delivered. The legacy `spend_sat` column on `tick_metrics` is retained for schema continuity but
no longer written (it was a `bid × delivered / 1440` model under the pre-#49 assumption and would lie
under pay-your-bid too, since delivered lags). Zero-delta intervals and counter resets are filtered out
(see `tick_metrics.ts::actualSpendSatSince` for the window function and the same filter mirrored in
`stats.ts`).

**Income/day - two figures side by side:**

- **Ocean est. income/day (3h).** Ocean's `daily_estimate_sat` - the pool's own "what this address
  would earn per day at its 3h hashrate" estimate. Authoritative but always 3h-based; tooltip notes
  this.
- **Projected income/day (range).** `avg(hashprice_sat_per_ph_day over range) × avg(delivered_ph over
  range)`, scaled to a daily rate. Symmetric with spend/day on cadence; uses tick-level hashprice
  samples already stored in `tick_metrics`.

**Net/day** = (projected income/day) − (spend/day). Uses the range-aware income, not Ocean's, so both
sides are on the same cadence.

**UI placement.** Sits directly under the charts, always expanded. (A collapsible-card variant was tried
briefly and removed - if the lifetime P&L card isn't collapsible, making the per-day card collapsible
created false asymmetry rather than useful decluttering.)

**Fallbacks.**

- When the selected range has fewer than ~5 ticks of data (fresh install, pruned history): fall back to the
  instantaneous figure (current price × current hashrate) and badge the card `insufficient history`.
- When no active owned bids exist: show the existing `no active bids` empty state.

## 12. Dashboard

Five pages: **Status** (default), **Config**, **Alerts**, **Setup** (first-run wizard only), and **Login**. The dashboard binds to the LAN only (`0.0.0.0:3010` by default; `HTTP_HOST=127.0.0.1` to restrict to loopback). Remote access is expected to go through a VPN / Tailscale perimeter; the dashboard has a shared-password second gate, not full auth.

### 12.1 Status page (top to bottom)

- **Hero PRICE / DELIVERED card + run-mode toggle.** The large PRICE number is the **live current
  owned-bid price** in sat/PH/day. Under pay-your-bid (§16) Braiins charges the bid price exactly,
  so the bid IS the truthful real-time cost number to anchor the dashboard on; a tooltip makes this
  explicit and points at the AVG COST / PH DELIVERED stats card for the post-hoc range-averaged
  effective rate (derived from `primary_bid_consumed_sat` deltas - see §11.1). Next to PRICE sits the
  ±delta versus current hashprice. The DELIVERED number is current instantaneous PH/s, coloured by
  floor / target thresholds. Below, the DRY-RUN / LIVE / PAUSED segmented control.
- **NEXT ACTION panel.** Describes what the controller will do on the next tick - create, edit, speed
  edit, wait for cooldown, or sit still. Includes a "Run decision now" button that bypasses the
  inter-tick wait. When a lower is queued behind Braiins' 10-min cooldown, the panel shows ETA and a
  progress bar.
- **Time-range picker.** 3h / 6h / 12h / 24h / 1w / 1m / 1y / all. Persisted in `localStorage`. Drives both charts, the stats bar, and the per-day P&L card. Both charts also support **drag-to-pan** (pointer-down + drag scrolls the time axis; both charts move in sync) and **scroll-wheel zoom** (anchored at cursor position, **click-to-focus** - the user must click the chart first to activate scroll-wheel zoom; clicking outside or pressing Escape deactivates it; a subtle blue outline indicates the focused chart). Zoom soft-snaps to preset durations so the preset button lights up as you scroll through each one. Panning preserves the active preset (tracks window size, not live-edge state); a **"live" button** appears when the viewport is panned away from the current edge - clicking it or double-clicking the chart snaps back. Data is pre-fetched 1x visible range on each side for smooth panning; previous data stays visible as a placeholder while a new range loads. The hashrate chart's Y-axis auto-scaling only considers data points within the visible viewport, so out-of-view spikes from zooming in do not inflate the axis and compress visible detail; the counter-derived hashrate formula (consumed-sat deltas) clamps values exceeding 5x the larger of `delivered_ph` and `target_ph` to guard against post-outage catch-up artifacts. Viewport API endpoints (`/api/metrics?since=&until=`, `/api/bid-events?since=&until=`, `/api/stats?since=&until=`, `/api/finance/range?since=&until=`) support arbitrary time windows with a separate `span` parameter to control aggregation granularity independently of fetch range.
- **Stats bar** (configurable, #266). Operator-pickable tiles from a curated catalogue (~23 entries spanning
  uptime decomposition, hashrate averages by source, cost metrics, pool-luck windows, share log %, share
  rejection, wallet runway, hashrate target, and Bitaxe fleet stats). Each slot exposes a picker dropdown
  (replace / remove / add another), drag-to-reorder via hover-revealed grip handles inside the bar, up to
  24 tiles. Choice persists daemon-side in `config.dashboard_tiles` so the layout follows the operator
  across browsers; defaults to the original six (UPTIME, AVG BRAIINS, AVG DATUM, AVG OCEAN, AVG COST / PH
  DELIVERED, AVG COST VS HASHPRICE) when empty so existing installs see no change. Colour-coded tiles
  (uptime, share rejection, wallet runway, pool luck 24h/7d/30d, avg cost vs hashprice) carry emerald /
  amber / red bands; pool-luck thresholds are window-aware (24h is more lenient than 30d because of
  Poisson variance). The **BID VS HASHPRICE** tile (#293) is live, not window-aggregated: it shows
  `(fillable + overpay) / hashprice` as a percent - the exact quantity cheap mode checks - with a
  state-aware caption (the cheap threshold when above it, sustained-window progress "N/M min < T%" while
  filling, and "cheap on → X PH/s" once engaged) and emerald / amber / neutral colouring keyed to that
  state. The percentage and the cheap-mode window summary are computed daemon-side in `/api/status`
  (`cheap_status`) so the tile can't drift from the controller's own cheap-mode check.
- **Hashrate chart.** Three series: `delivered (Braiins)` (amber), `received (Datum)` (emerald), `received (Ocean)` (blue). Target + floor as dashed horizontal references. Per-series rolling-mean smoothing via `braiins_hashrate_smoothing_minutes` and `datum_hashrate_smoothing_minutes`; Ocean is server-smoothed. Each chart's title carries an **expand / collapse toggle** (#105) that doubles the chart height for closer reading. Pool-block markers (one per Ocean-credited pool block) follow a precedence-ordered shape vocabulary (#115): own block (Ocean credited the coinbase to our payout address) -> **gold CROWN**; BIP 110-signalling pool block -> **yellow CUBE** (#94, Reduced Data Temporary Soft Fork; detection: `(version & 0xe0000000) === 0x20000000 && (version & 0x10) !== 0`, block-header version cached per `block_hash` via migration 0058); default pool block -> blue cube. Tooltip header label and color follow the same precedence (own > BIP 110 > default). Click opens the configured block explorer. A right-axis dropdown above the chart (#93, persisted to localStorage) selects one secondary series: `none` (default), `share_log %`, `network difficulty` (renders **difficulty-retarget markers** at every detected retarget tick - per-tick step > 0.5% with sustained-value check on the next non-null tick to filter spurious bucket-AVG detections; tooltip shows date, new difficulty, previous epoch's difficulty, and % change), `pool hashrate`, `pool luck (24h)` / `pool luck (7d)` / `pool luck (30d)` (#92/#201, gap-based per-tick luck = `count_in_window / (pool_share × (window + elapsed) / 600)`; retarget markers also appear on the luck line (#174) with luck-before/luck-after values in the tooltip, since a difficulty retarget shifts pool_share and causes a discontinuous luck jump), `solo best difficulty` (#204, staircase line with trophy markers at each fleet all-time high share difficulty record; migration 0094). Difficulty retargets additionally render a **pickaxe icon** (Lucide `Pickaxe`, violet) at the top of the chart with a dashed vertical line (#175), always visible regardless of right-axis selection - the same top-of-chart treatment as block cubes/crowns. Hover/click opens the retarget tooltip.
- **Price chart.** Four always-on lines: `our bid` (amber), `fillable` (cyan, the controller's tracking anchor), `hashprice` (violet, dashed), `max bid` / effective ceiling (red, with a red gradient above the line marking the off-limits region). Bid-event dots (yellow / cyan / red) on the amber line mark CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL events; clicking pins a detail panel with `fillable`, `overpay`, `hashprice`, cap inputs, effective cap at that tick, and a JSON export button. Per-range filtering: 3h-24h shows all four kinds; 1w drops EDIT_PRICE; 1m / 1y / all show none. See `CHART_RANGE_SPECS[r].showEventKinds` in `packages/shared/src/chart-ranges.ts`. Pool-block markers and difficulty-retarget markers are mirrored from the hashrate chart (#176) - the same top-of-chart cubes/crowns/BIP-110 shapes and pickaxe icons with dashed vertical lines, with identical tooltips. A right-axis dropdown (#93) selects one secondary series: `none` (default), `effective rate` (#90/#93), `block reward`, `BTC/USD`, `unpaid earnings`, **`paid earnings (lifetime)`** (#102, monotonically non-decreasing cumulative on-chain payouts to the configured address; per-tick `paid_total_sat` derived from `reward_events` via migration 0066), **`lifetime earnings (paid + unpaid)`** (the natural metric that survives payout cliffs - paid_total + ocean_unpaid), **`Braiins balance`** (#211, purple line from `tick_metrics.total_balance_sat` - the Braiins total wallet balance (available + blocked) polled every tick; zero-anchored right axis so the absolute level is visible at a glance; decreases as bids consume funds, jumps on deposits; migration 0095). When the right-axis is set to a step-event series (paid / unpaid / lifetime earnings), the chart renders **clickable dots** at each event - on-chain payout dots deep-link via `block_explorer_tx_url_template`, pool-block dots reuse the rich tooltip shape from the Hashrate chart (reward, our share, BIP 110 signal, explorer link). **On-chain payout gem markers** (#207): an **emerald gem** (Lucide `Gem`) at the top of the chart with a dashed vertical line marks every on-chain payout detected by the electrs/bitcoind scanner; clicking opens a pinnable tooltip with block height, payout date, amount (in the active denomination), and a block-explorer deep-link. A **purple dot** on the unpaid-earnings line marks the earlier tick where `ocean_unpaid_sat` drops >30% - the moment Ocean debits the balance to initiate the payout, bridging the visual gap between the unpaid line dropping and the gem appearing when the tx lands on-chain. **Deposit markers** (#211): a **purple fuel icon** (Lucide `Fuel`) at the top of the chart with a dashed vertical line marks every credited Braiins deposit (DEPOSIT_STATUS_CREDITED); clicking opens a pinnable tooltip with deposit amount, truncated tx_id, receiving address, timestamp, and a block-explorer deep-link. When the right-axis series is `total_balance_sat` (Braiins balance), a purple dot appears on the balance line at the step-up caused by the deposit, with a dotted connector line back to the fuel icon so the operator can visually trace which deposit caused which balance jump; hovering either the dot or the connector opens the same deposit tooltip. Visible regardless of right-axis selection. Data served by `/api/deposits` from the `braiins_deposits` table. **Lifecycle markers** (#287): a violet **power icon** (Lucide `Power`, one shared glyph regardless of direction) marks every MODE_CHANGE, a rose **circle-pause** every BID_PAUSED, an emerald **circle-play** every BID_RESUMED - top-of-chart glyphs with full-height dashed guide lines (these rows have no price anchor), **always visible at every zoom level** (they bypass the per-range kind filter: a mode change that explains a week-long gap must stay visible at the 1m zoom where the gap is noticed). Clicking pins the standard event tooltip; BID_PAUSED carries Braiins' `last_pause_reason` as the reason line. Legend chips for the three kinds appear only when such a marker is in view. **Idle-state background bands** (#287, both charts): a violet diagonal hatch spans every period the run mode was DRY_RUN or PAUSED - derived from per-tick `tick_metrics.run_mode` (exposed raw and worst-in-bucket PAUSED > DRY_RUN > LIVE via `/api/metrics`), so the bands are retroactive over all stored history; band edges snap to MODE_CHANGE event timestamps when one falls in the bracketing tick gap (tick-midpoint fallback for history without events). A rose counter-diagonal hatch spans every BID_PAUSED → BID_RESUMED pair (open-ended spans clamp to the data edge). Hovering a band names the state and duration. Band tints follow the `events.mode_change` / `events.bid_paused` color slots.
- **Stale-URL banner** (#113, top of page when triggered). Renders when an active Braiins bid was created with a `dest_upstream.url` whose hostname:port (case-insensitive) differs from current `destination_pool_url`. IP-only DDNS pushes for the same hostname don't trigger it. Banner shows old vs new host:port, the unconsumed_sat that would be refunded, an exit-fee caveat, and a confirm-then-cancel button that calls Braiins's CANCEL_BID. Next decision tick auto-creates a fresh bid with the new URL via the existing CREATE_BID gate. **Self-heal for vanished bids (#295):** if the bid behind the banner was actually deleted at Braiins out-of-band (the operator cancelled it manually, removed it after a port change, etc.), the daemon clears it automatically - each tick it cross-checks the local `owned_bids` ledger against a *successfully-fetched* Braiins bid list and marks any active ledger bid the list no longer contains as cancelled (gated on a confirmed-successful fetch so an API hiccup can't wipe live bids, with a grace window so a just-placed bid is never pruned). The banner's cancel also treats a Braiins "order not found" as already-gone and clears the row. So a stale ghost bid no longer strands the banner or the decision loop, and there's no need to hand-edit the database.
- **Service panels (three-column).** BRAIINS (API reachability, delivered vs target, wallet balance,
  runway at current spend rate). DATUM GATEWAY (stratum reachability with error/latency tooltip - probe failures display the actual error message (e.g., "timeout after 2500ms", "connect ECONNREFUSED") and successful probes show round-trip latency in milliseconds (#212), gateway-measured hashrate,
  connected workers - if `datum_api_url` is configured). OCEAN (API reachability, Ocean-credited hashrate,
  current hashprice, recent blocks, time to next payout, plus `pool blocks 24h/7d/30d` rows with inline
  `Nx lucky/unlucky` annotations from #92/#201 - share computed live from
  `pool_hashrate_ph / network_hashrate` so the example doesn't drift out of date, and an all-time pool block count since the daemon started tracking).
- **BIP 110 scan card** (#95). Status-page diagnostic at the bottom of the page with a window selector
  (2016 / 4032 / 8064 / 16128 / 32256 blocks) and a Scan button that calls `GET /api/bip110/scan?blocks=N`.
  Returns deployment header (`status`, `bit`, retarget-window count/threshold/elapsed when the node is
  Knots-patched and reports the BIP 110 deployment) plus signaling blocks rendered as rich cards on mobile (pool name, block reward, fees, size) and a table on desktop, with block heights, hashes,
  times (relative + UTC on hover), and `version` hex with mempool.space links. Locale-aware number
  formatting via `formatNumber(...intlLocale)`; sorted newest-first; full hashes (no truncation). An inline per-epoch progress bar shows each epoch's signaling count against the 55% MASF threshold (`ceil(2016 × 0.55) = 1109` signaling blocks); rows turn emerald at or above the threshold. The deployment-status badge in the card header carries a lifecycle-aware tooltip (#235): in SIGNALING state it names both activation paths - miner-activated (MASF, 55% in any epoch locks in early) and user-activated (UASF, block height 965,664 enforced unconditionally regardless of signaling); in LOCKED_IN state it forecasts the next-boundary block and estimated date; in ACTIVE state it distinguishes MASF vs UASF activation using `deployment.since` from bitcoind's `getdeploymentinfo`. The forecasted UASF date is computed dynamically as `now + (965,664 − tip) × 600s` so it tracks current block-time conditions (early-September 2026 at current block rate).
- **Active bids table.** All current bids with full order IDs, prices, speed limits, delivery %,
  ownership badge. No inline per-bid operator actions in the current build - run-mode toggle +
  "Run decision now" + the config editor cover the day-to-day needs; per-bid bump / recreate /
  manual-cancel are not yet shipped.
- **Per-day P&L card.** Range-aware (see §11.1). Ocean estimate + projected income, spend, net.
- **Lifetime P&L + funding ledger.** Cumulative block-reward income, cumulative spend, net.

### 12.2 Config page

Reorganised in v1.5.0 (#107) from a single long-scroll form into **four tabs** with **cross-tab search**. Active tab is reflected in the URL (`/config?tab=pool`), bookmarkable and survives refresh; default landing tab is Strategy. Tab bar scrolls horizontally on narrow viewports. The search box sits above the tab bar; typing matches against field labels across all tabs and clicking a result switches to the target tab, scrolls the field into view, and briefly outlines its section in amber.

| Tab | Sections |
|---|---|
| **Strategy** | Hashrate targets, Cheap mode, Pricing (fillable-tracking overpay + two safety ceilings), Budget, Daemon startup |
| **Pool & Payout** | Pool destination + Test connection button, Datum stats API + Test connection button, Dynamic DNS (provider + hostname + credentials + Test connection button + diagnostic IPs - daemon's public IP, hostname resolves to, match/mismatch note), Payout source (none / electrs / bitcoind + Test connection buttons), Profit & Loss scope, BTC price oracle |
| **Notifications** | Telegram bot token + chat ID + Test connection button, instance label, mute toggle, retry interval, wallet-runway threshold, per-event-class opt-out checklist, pool-block-credit toggle, block-found sound (off / bundled / custom upload) |
| **Display & Logging** | Number format (separators) + Date layout (independent dropdowns; month names always follow the UI language picker - #147), block explorer URL template + transaction URL template, chart colors (Lines / Markers / Bid events sections with live SVG glyph previews per row), chart smoothing (Braiins / Datum / Braiins price), chart-markers cap, log retention (tick metrics / decisions uneventful / decisions eventful / alerts), Bitaxe miners device list + alert thresholds (when `solo_mining_enabled = true`) |

Saves go through the Zod `AppConfigInvariantsSchema` and take effect on the next tick - no daemon restart needed. PUT `/api/config` snapshots the previous config before upsert and fires `onConfigSaved` callbacks; main.ts wires that to refresh the live `cfgRefHolder.value` immediately AND, when any DDNS-relevant field changed, kick the DDNS updater once so a Pool URL / hostname / credential edit pushes within seconds rather than waiting on the next periodic poll.

### 12.3 History page

Dedicated `/history` route (#256 v2) replacing the older per-bid collapsible view. A flat sortable table
of every bid event - four bid-mutation kinds (CREATE_BID / EDIT_PRICE / EDIT_SPEED / CANCEL_BID) plus
three lifecycle kinds (#287): MODE_CHANGE (operator run-mode switches from the dashboard toggle AND
boot-time transitions, e.g. `boot: LIVE → DRY_RUN (boot_mode=ALWAYS_DRY_RUN)`), BID_PAUSED and
BID_RESUMED (Braiins-side bid status flips observed per tick, with Braiins' `last_pause_reason` as the
reason). Lifecycle kinds are excluded from the Stats `mutation_count` and never inherit a bid id from
the orphan-CREATE coalesce. Toolbar filters: action-kind chips
carrying Lucide glyphs that mirror the rows, bid-id substring, From / To date range via a custom locale-aware
date picker (browser-native `<input type=date>` rendered in the browser's locale not the dashboard's),
denomination-aware `|Δ price| ≥ N` (input unit tracks the active TH/PH/EH toggle, converts to sat/EH/day
on the wire). Columns: When, Bid (full id, no truncation), Action, Reason (#285 - the controller's
decision reason / mode transition / Braiins pause reason), Fillable at event, Price before, Price
after, Δ price (green for downward, red for upward), Speed. Clicking a row slides in a detail drawer
(#285) with every field plus a "View on chart" jump that pans the Status price chart to the event,
scrolls the page to the chart, and pulses an amber focus ring around the marker for ~5 s. Toolbar
filters persist per browser (sticky). Server-side infinite-scroll pagination via a
`before_id` cursor; `?range=` is independent of the Status page's range. SQL coalesces the bid id forward
on CREATE_BID rows that land before Braiins echoes the assigned id (1 h window), carries `speed_limit_ph`
forward from the last CREATE / EDIT_SPEED on the same effective order, and renders EDIT_SPEED rows with
the bid's effective last-known price in both before/after cells (delta = 0) so the operator doesn't see
blank cells for an order that demonstrably had a price.

### 12.4 Alerts page

Dedicated `/alerts` page (#100 / #109 / #134 / #139 / #153): event-grouped audit trail of every alert the daemon evaluated. Events render as collapsible cards grouped into two sections: **OPEN** (firing, not yet seen by the operator - drives the nav badge count) and **Acknowledged and resolved** (one chronological bucket for both acked-not-recovered rows and recovery-paired rows, sorted newest-first by firing time; the merge prevents the bucket boundary from breaking chronological order when a recent IMPORTANT recovery lands after an older INFO ack). The per-card right-side pill keeps the state distinction visible per row: emerald `RESOLVED` vs slate `ACKNOWLEDGED · {age}`. Open cards render expanded by default; the merged bucket collapses to a header. A free-text search box filters across titles + bodies with hit-highlighting (#134). Sticky **Unacknowledged only** filter (persists per browser via localStorage). A **Mark all as seen (N)** bulk button next to the filter clears every unacked row in one click - server-side via `POST /api/alerts/acknowledge-all`. Telegram messages can also be acked in-place from the operator's phone via the inline-keyboard button (#109). A bottom-right **toast** appears in the dashboard the moment a new alert lands (#142), severity-coloured (red / amber / slate / emerald-for-resolved), with a 5 s auto-dismiss for INFO/recoveries and 15 s for the louder ones; clicking navigates to `/alerts`.

### 12.5 Things the v1 spec listed but the current build does not ship

For honesty against the older spec drafts: no operator-availability / quiet-hours UI, no per-bid operator-action menu (bump / recreate / cancel - still an option to add but not present), no what-if simulator (retired in v2.0), no separate Decisions tab (the bid-event pinned tooltip on the Price chart covers the forensic-debug use case).

## 13. Research-derived API constraints

- Base URL: `https://hashpower.braiins.com/v1/`. The OpenAPI spec's declared `servers: /api/v1` is wrong - live
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

- **Dynamic home IP.** If the destination's public IP rotates after a bid is funded, the bid's `dest_upstream.url` can't be edited - must cancel + create. **[handled]** since v1.5.0: the daemon polls `api.ipify.org` for its current public IP, can push DDNS updates itself (No-IP / DuckDNS / generic dyndns2 - see §8 "Daemon-managed Dynamic DNS"), and the Status / Config dashboard shows a stale-URL banner whenever an active bid was created with a hostname that no longer matches `destination_pool_url` (#113). The banner has a confirm-then-cancel button that triggers a fresh CREATE_BID on the next decision tick. IP-only changes for the same hostname don't trip the banner (miners re-resolve on reconnect, the bid stays valid).
- **Datum endpoint unreachable.** Gateway disconnects stratum clients; Braiins pauses the bid.
  **[handled]** - when Datum stratum is unreachable for 3+ consecutive ticks the controller cancels
  all active bids to stop spend and blocks new bid creation until stratum recovers (see §9 "Datum
  pool unreachable", #199). The Datum Gateway panel surfaces reachability; the `datum_unreachable`
  Telegram alert fires at the configured threshold.
- **Worker-identity misconfiguration.** Ocean TIDES credits rewards to the BTC address encoded in the
  worker identity. A bare label (no `<btc-address>.` prefix) causes shares to be credited to no one -
  paying for hashrate that yields zero rewards. **[handled]** - the setup CLI and the dashboard
  Config page both validate the shape at write time.
- **Deposit flagged for manual review.** Up to 48 working-hours lag. Autopilot may detect the deposit
  in transactions but not in balance. **[observed]** - transactions / balance are both on the
  dashboard; operator reconciles.
- **Beta exit → non-zero fees.** `/spot/fee` returns non-zero. **[observed]** - current fees are
  polled each tick but not yet alerted on. Operator must re-tune caps.
- **Destination pool difficulty too low.** Oscillating Paused/Active without meaningful delivery.
  **[observed]** - gap between Braiins-delivered and Datum-received on the hashrate chart is the
  visual signal; no dedicated alert.
- **Datum Gateway stale work.** Pay-per-share with pool-side rejections. **[observed]** - same
  delivered-vs-received gap + rejection stats from Datum.
- **Fillable jitter → trade storm.** Orderbook `fillable_ask` jitters ±1-5 sat/PH/day tick-to-tick.
  **[handled]** - EDIT_PRICE deadband at `max(tick_size, overpay × bid_edit_deadband_pct / 100)` (default 20% = legacy `overpay/5`, configurable per #222) absorbs it (see §8 "Pricing
  strategy"). Without the deadband a naive tick_size tolerance burned the 10-minute cooldown on every
  noise blip.
- **Overpay value lost on upgrade from v1.x → v2.1.** Migrations 0043/0045 were originally paired as
  drop-then-add (dropping the operator's configured `overpay_sat_per_eh_day` and reinstating it with
  default). **[handled]** - 0043 was revised to preserve the column; 0045 is now a no-op. Any user
  still upgrading past both migrations keeps their overpay value.

## 15. Prior art worth studying

- `m1xb3r/braiins-hashbot` - Python + FastAPI + Docker; closest reference to this spec. Study its control-loop
  design and Fernet-encrypted secrets storage.
- `counterweightoperator/hashbidder` - Python + TOML; Ocean+Datum specialist with a target-hashrate mode. Study its
  pricing strategy and tick-size handling.

Neither is a drop-in; both are educational. v1 is fresh TypeScript.

## 16. Empirical questions - status

Resolved since v1.0:

- ~~Exact 2FA confirmation validity window.~~ Moot - owner-token API bypasses 2FA entirely.
- ~~Whether `POST /spot/bid` blocks until 2FA confirm or returns a pending ID.~~ Returns the created
  bid directly.
- ~~DELETE payload shape.~~ Order ID goes in the JSON body, not the query string.
- ~~Whether a UI-placed bid's order ID format is reconcilable with API-placed ones.~~ Yes; ledger
  reconciliation works.
- ~~Pricing model - CLOB / pay-at-ask vs pay-your-bid.~~ Pay-your-bid. Verified by direct A/B on
  2026-04-23: dropping `max_bid_sat_per_eh_day` from 50,000 → 49,000 sat/PH/day dropped effective cost
  from ~50,300 → ~49,899 sat/PH/day while the orderbook's fillable ask was unchanged at ~47,158. See
  #53 and `decide.ts` header.

Still open:

- Per-endpoint HTTP 429 thresholds (not published).
- Live values of `min_bid_price_decrease_period_s`, `tick_size_sat`, grace periods, and price bounds
  from
  `GET /v1/spot/settings` - require owner token; verify on first real run and seed defaults.

## Document history

| Version | Date       | Changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|---------|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | 2026-04-14 | Initial version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 1.1     | 2026-04-16 | Post-empirical rewrite: owner-token API bypasses 2FA. Removed action-mode state machine (PENDING_CONFIRMATION, CONFIRMATION_TIMEOUT, QUIET_HOURS), confirmation bot, and operator-availability flag. Added empirical findings on worker identity shape and DELETE body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 1.2     | 2026-04-16 | Replaced hard-coded "always reset to DRY-RUN on boot" rule (§7.1) with a `boot_mode` config knob: `ALWAYS_DRY_RUN` (default) \| `LAST_MODE` \| `ALWAYS_LIVE`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.3     | 2026-04-16 | Added `max_lowering_step_sat_per_eh_day` dampener: auto-lower edits now move down at most one step per edit so a sliver-of-supply "topmost ask" drop doesn't strand the fill in one move. Empirical trigger: live event 2026-04-16 dropped 2,000 sat/PH/day in one EDIT and killed delivered hashrate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 1.4     | 2026-04-16 | Hashrate chart gains a time-range picker (6 h / 12 h / 24 h / 1 w / 1 m / 1 y / all, default 24 h, persisted in `localStorage`). Server aggregates to 5-min (1 w), 1-h (1 m), or 1-day (1 y / all) buckets via `GROUP BY tick_at / bucket_ms`; raw rows for ≤ 24 h. Event overlay suppressed for ranges ≥ 1 m (individual markers lose signal at that zoom). AVG used for all aggregated fields in the MVP - median/end-of-bucket refinements are follow-ups.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 1.5     | 2026-04-16 | Depth-aware pricing: the autopilot no longer targets "cheapest ask with any non-zero supply". Instead it walks asks cumulatively and targets the cheapest price at which the full `target_hashrate_ph` is fillable. Empirical trigger: live orderbook 2026-04-16 had a sliver ask at 45,070 with the real supply at 47,803 - the old logic targeted 45,070 and stranded the fill. Dashboard gains a "fillable @ target" row in the Hashrate & Market card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.6     | 2026-04-16 | Simplified pricing model: target = min(fillable + max_overpay, max_bid). Renamed `max_price_sat_per_eh_day` → `max_bid_sat_per_eh_day`, `max_overpay_vs_ask` → `max_overpay`. Removed `overpay_before_lowering` and `max_lowering_step` dampeners - downward adjustments now jump directly to target. Added `escalation_mode` config: `market` (jump to target) or `dampened` (step up). User interview drove the simplification: all thresholds relative to fillable, no stacked margins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 1.7     | 2026-04-16 | Renamed `max_overpay_sat_per_eh_day` → `overpay_sat_per_eh_day`. The "max_" prefix was misleading - the field is the (fixed) overpay we always aim for, not the upper bound of a varying amount. The only "max" semantic is the absolute `max_bid` cap that clips overheated markets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1.9     | 2026-04-19 | Repurposed `lower_patience_minutes`: the patience window now measures continuous lowering-readiness (primary > fillable + overpay + min_lower_delta), not continuous above-floor time. The old semantics fired lowering after a few minutes of a bid filling at marginal overpay; the new semantics require the market to be *meaningfully* cheaper than the current bid for the full window before lowering. Column `runtime_state.above_floor_since_ms` renamed to `lower_ready_since_ms` (migration 0032). Behaviour change, not a config-shape change - existing `lower_patience_minutes` values keep their meaning in wall-clock minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 1.8     | 2026-04-19 | Composite roll-up of features shipped 2026-04-16 to 2026-04-19: (a) `lower_patience_minutes` - required above-floor duration before lowering, persisted across restarts in `runtime_state.above_floor_since_ms`; (b) Ocean integration - `/api/ocean` surfaces hashprice, pool stats, recent blocks (including own-found markers on the hashrate chart), and time-to-payout; hashprice is recorded on every `tick_metrics` row and plotted historically; (c) `max_overpay_vs_hashprice_sat_per_eh_day` - optional dynamic cap, effective cap becomes `min(max_bid, hashprice + this)`; simulator mirrors the same skip-tick guard; (d) opportunistic cheap-mode scaling (`cheap_target_hashrate_ph`, `cheap_threshold_pct`) - scales above the normal target when the market is cheap vs hashprice; (e) what-if simulator (`POST /api/simulate`) - stateless backtest over historical `tick_metrics` with candidate strategy parameters, surfaced on the Status page as a toggleable overlay on the live charts; (f) retention pruning (`tick_metrics_retention_days`, `decisions_uneventful_retention_days`, `decisions_eventful_retention_days`) - hourly pruner service; (g) Datum Gateway integration (optional) - `datum_api_url` enables polling `/umbrel-api` each tick, records `tick_metrics.datum_hashrate_ph` alongside Braiins's reading, surfaces connected workers + gateway-measured hashrate on a dedicated Datum panel. Integration is informational-only; control loop never depends on Datum being reachable. See `docs/setup-datum-api.md` for the Umbrel port-exposure recipe (tested and running stable since 2026-04-19). |
| 2.0     | 2026-04-23 | CLOB pricing rewrite: retired the depth-aware `fillable + overpay` formula and all associated knobs (`overpay_sat_per_eh_day`, `escalation_mode`, `fill_escalation_step_sat_per_eh_day`, `fill_escalation_after_minutes`, `min_lower_delta_sat_per_eh_day`, `lower_patience_minutes`). The bid now sits at the effective ceiling `min(max_bid, hashprice + max_overpay_vs_hashprice)` every tick - matching is cheapest-ask-first so the ceiling is a matching-access threshold, not the price paid. Also retired the what-if simulator (v1.8e).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2.1     | 2026-04-23 | Pay-your-bid correction (#53). Direct A/B verification on live data (50k→49k bid drop → 50,300→49,899 sat/PH/day effective cost drop, with fillable ask unchanged) falsified v2.0's CLOB assumption. Restored depth-aware fillable tracking: bid = `min(fillable_ask + overpay_sat_per_eh_day, effective_cap)`. Reintroduced `overpay_sat_per_eh_day` (default 1,000 sat/PH/day) as the one pricing knob; the escalation/patience/min-lower-delta subsystem from v1.x stayed retired - under direct fillable tracking the optimal price is proposed every tick and Braiins' own 10-min cooldown is the only pacing rule needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2.1.1   | 2026-04-24 | Follow-ons to v2.1: EDIT_PRICE deadband `max(tick_size, overpay/5)` to absorb orderbook jitter (was causing a trade storm at naive tick_size tolerance); migrations 0043/0045 revised to preserve `overpay_sat_per_eh_day` through the CLOB-redesign retirements (was silently resetting every operator's value on upgrade); `show_effective_rate_on_price_chart` config toggle added with migration 0046 (effective line hidden by default because its volatility crushes the flatter-line detail); fillable drawn as first-class cyan line on the Price chart; hero PRICE and AVG COST / PH cards got explanatory tooltips; event-detail tooltip surfaces `fillable` and `overpay` as first-class rows. Docs sync against code same day - README / spec / architecture rewritten to match the pay-your-bid reality; older CLOB-era phrasing removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2.2     | 2026-04-25 | Appliance packaging release (v1.3.0; closes umbrella issue #56). Three resolution layers for both config and secrets: `BHA_*` env vars (priority 1) > `.env.sops.yaml` (priority 2) > `secrets`/`config` rows in `state.db` (priority 3, populated by the new first-run web wizard). Migration 0047 adds the `secrets` table. Daemon enters `NEEDS_SETUP` mode when both config and secrets are absent, exposing only the wizard's three endpoints (`/api/health`, `/api/setup-info`, `/api/setup`); on POST /api/setup it transitions in-place to operational mode without a process restart. New public `/api/health` endpoint (`{ status, mode }`) doubles as the appliance liveness probe and the dashboard's setup-mode probe. Dockerfile + GHCR publish workflow (multi-arch `linux/amd64` + `linux/arm64`); image at `ghcr.io/<owner>/hashrate-autopilot:vX.Y.Z`. Bitcoind RPC creds auto-detect from the standard `BITCOIN_RPC_*` env vars Umbrel/Start9 inject. Wizard auto-binds the worker identity (`<btc-address>.<label>`) to the BTC payout address with a hard-red mismatch warning; same logic ported into the Config page. Power-user `setup.ts` + SOPS path is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2.3     | 2026-05-02 | Spec-consistency sweep through v1.4.8. §12.1 hero PRICE card description corrected to "live current owned-bid price" (the post-#69 reality - the card has shown the live bid for some time; the older "window-averaged effective rate" framing was a stale paragraph that contradicted the README and the running dashboard). No behaviour change; pure doc correctness pass. Done in lockstep with architecture v1.6 (schema additions through migration 0051, P&L spend-source clarification, /healthz -> /api/health) and a research.md tweak that retired the historical 300 sat/PH/day default in §1.8 in favour of the live 1,000. |
| 2.4     | 2026-05-09 | Catch-up sweep with the May-2026 feature run (v1.5.0 -> v1.5.4). §6 flips "No external notification channel" to the shipped Telegram sink; §8 gains the Telegram config block (`telegram_chat_id`, `telegram_bot_token`, `telegram_instance_label`, `notifications_muted`, `notification_retry_interval_minutes`, `notification_disabled_event_classes`, `notify_on_pool_block_credit`), the Daemon-managed Dynamic DNS block (`ddns_provider` for `''`/`noip`/`duckdns`/`dyndns2`, `ddns_hostname`, `ddns_username`, `ddns_credential`, `ddns_update_url`), `block_explorer_tx_url_template`, the new bundled `ocean-mining-found-a-block` sound, and the `wallet_runway_alert_days = 0 = disabled` semantic with the new default of 0. §9.1 promoted from "planned" to "shipped" with the per-event-class opt-out (#106), inline-keyboard ack/snooze (#109), and per-instance label prefix layered on. §12.1 updated for the price chart's `paid earnings (lifetime)` and `lifetime earnings (paid + unpaid)` series (#102), the difficulty-retarget markers, the chart expand toggle (#105), the own-block-vs-BIP-110 marker swap (#115), and the stale-URL banner (#113). §12.2 rewritten for the four-tab Config layout with cross-tab search (#107) and the Test connection buttons across Pool URL / Datum API / DDNS (#112) / bitcoind / electrs / Telegram. §12.3 split: new dedicated Alerts page section (#100 / #109 with the bulk-ack and unacked-only filter), and §12.4 inherits the "things v1 listed but doesn't ship" honesty list (Telegram dropped from that list now that it ships). §14 "Dynamic home IP" landmine flipped from `[unhandled]` to `[handled]` against the new DDNS feature. Generalised "on the Umbrel node" prose throughout - the Bitcoin node can run on any platform; Umbrel is one option among several. |
| 2.5     | 2026-05-15 | §12.1 Hashrate chart: retarget markers now appear on pool luck (24h/7d) overlays with luck-before/after tooltip (#174); pickaxe icon (Lucide) at chart top for retargets, always visible regardless of right-axis selection (#175). §12.1 Price chart: pool-block markers (cubes/crowns/BIP-110) and retarget pickaxes mirrored from the Hashrate chart (#176). Also covers #171 (payout-triggering block in Telegram), #172 (chart-marker cap extended to pool blocks + reward events), #173 (braiins_reachable discriminator for marketplace-empty vs API-unreachable). |
| 2.6     | 2026-05-19 | Click-to-focus scroll-wheel zoom: user must click a chart to activate scroll-wheel zoom; clicking outside or pressing Escape deactivates; blue outline indicates focused chart. Viewport-scoped Y-axis: hashrate chart Y-axis scaling considers only visible data, not out-of-view spikes; outlier clamping on counter-derived hashrate guards against post-outage phantoms. Debug API endpoint (#179): GET /api/debug/dump behind a Config toggle. Daemon-offline gap bands (#178): hatched overlay on both charts during periods where the daemon was not polling. Retarget backfill (#178). CodeQL security fixes: prototype-pollution guard, SSRF scheme validation, ReDoS string-method replacements, per-IP rate limiting. Mobile UI: bids render as responsive cards < 640px; chart legends, Config, and Alerts pages fixed for narrow screens. Major dependency upgrades: React 18-19, Lingui 5-6, Vite 6-8, Zod 3-4, react-router-dom 6-7, and 8+ other packages. |
| 2.7     | 2026-05-19 | Datum-down auto-cancel (#199): when Datum stratum is unreachable for 3+ consecutive ticks, the controller cancels all active bids to stop spend. Also blocks new bid creation while stratum is down. Bidding resumes automatically when stratum recovers. The `datum_unreachable` alert copy updated to reflect the auto-cancel behavior. Pool luck 30d (#201): new `pool luck (30d)` right-axis chart overlay with retarget markers; Ocean panel gains `pool blocks 30d` (with luck multiplier) and `pool blocks all time` (count since daemon started tracking). Migration 0093 adds `pool_luck_30d`, `pool_blocks_30d_count`, `pool_hashrate_ph_avg_30d` to tick_metrics. Boot-time backfill and pool-luck recompute service extended to 30d window. Solo fleet best difficulty (#204): new `solo_best_difficulty` INFO event class, migration 0094 (`solo_best_difficulty_all_time` on runtime_state, `solo_best_difficulty_events` table), staircase chart overlay with trophy markers. |
| 2.8     | 2026-05-29 | Fee protection (#222): two new operator-configurable config fields. `max_acceptable_fee_pct` (default 0): mutation gate adds `FEE_THRESHOLD_EXCEEDED` denial when any active bid's `fee_rate_pct` exceeds this ceiling, blocking CREATE / EDIT / EDIT_SPEED but allowing CANCEL. Default 0 halts on any non-zero fee, lining up with the existing `beta_exit` alert. `bid_edit_deadband_pct` (default 20): replaces the hard-coded `editDeadband = max(tick_size, overpay/5)` in decide.ts with `max(tick_size, overpay × pct / 100)`. Default 20 = legacy `/5`. Migration 0099 adds both columns; supersedes the cancelled #200 (absolute-knob variant). Status panel's proposal strip renders the new gate reason as "Braiins fee above your threshold". Also fixes the pool-luck step tooltip (#223): replaced the mis-labelled "numerator went from X× to Y×" with "pool luck went from X× to Y×" - the X×/Y× values are luck multipliers, not numerator counts. |
| 2.11    | 2026-06-02 | #243: Braiins share-rejection rate. New per-tick capture from Braiins `/spot/bid/detail.counters_committed` (cumulative `shares_purchased_m / accepted_m / rejected_m` for the primary owned bid). Adds one extra GET per tick because the bids list endpoint doesn't carry counters. Migration 0106 adds three nullable REAL columns to `tick_metrics`. Dashboard Hashrate chart gains a `rejection rate (Braiins)` right-axis option derived client-side from per-tick deltas (`Δrejected / Δpurchased × 100`), with NULL on bid-rotation ticks (counter reset → negative Δpurchased) and on ticks where Δpurchased ≤ 0. Braiins service panel gets a `rejection rate` row showing a 10-min rolling-window aggregate. Graceful degradation: `getBidDetail` failure leaves the three fields NULL on that tick; the tick itself doesn't abort. |
| 2.12    | 2026-06-04 | v1.12 catch-up. **Public-IP change tracking** (#250, migration 0109): `PublicIpService` polls api.ipify.org every 60 s (dropped from 5 min), writes `ip_change_events` rows on old→new transitions, drives the DDNS updater immediate re-push, the DDNS card's "IP last changed" timestamp, and the router-icon markers on the Hashrate chart. **Drag-to-reorder Status cards** (#244, migration 0108): every block on the Status page is draggable via the header's `Rearrange` button; order saved per-device in browser localStorage (`dashboard_card_order` schema column reserved for future cross-device sync but currently dormant). **Net P&L return-on-spend** (#249): lifetime P&L card adds a "return on spend" row (`net / spent × 100`) below the net figure, green when positive, red when negative; hidden when spent = 0. **Marker colour overrides** (v1.12 marker keys): five new `chart_color_overrides` keys (`hashrate.pool_block_bip110`, `hashrate.marker_retarget`, `hashrate.marker_ip_change`, `price.marker_payout_gem`, `price.marker_deposit`) and a `price.unpaid → price.marker_deposit` rename with parser-side alias migration. Total slots now 22. Config UI reshuffled into Lines / Markers / Bid events sections with live SVG glyph previews per row. **Rejection-rate computation moved server-side**: `braiinsRejectionPctSince(since_ms, until_ms)` queries raw `tick_metrics` rows for first/last cumulative counter values across the selected chart range, so the Braiins card row and chart series agree at every range preset (replaces the earlier 10-min rolling-window client-side aggregate; the bucketed-data corner case that caused "All vs 6h" disagreement is gone). **Pool-luck step-marker algorithm rewritten**: dots anchor to the block's actual timestamp (`first tick at-or-after t`) instead of scanning forward for a count delta; multi-event ticks (e.g. one block ages out while another lands) collapse into a single marker with a combined tooltip that lists each contributing block under a green `FOUND` or red `AGED OUT` badge. **Chart bucket scaling** (v1.12): `pickBucketForSpan` replaced the 4-tier ladder with `bucketMs = ceil(spanMs / 1440)` clamped to the 60 s tick floor — no more 30× cliffs at preset boundaries when scrolling past 24 h. **Bitaxe rename** (v1.12, label-only): every user-facing "Solo miners" / "solo fleet" string in the dashboard, Config UI, alert labels, and right-axis chart series renamed to "Bitaxe miners" / "Bitaxe miner" since the integration only ever supported AxeOS firmware. Internal `solo_*` field names, table names, and code identifiers are unchanged. **Migration 0107**: scrubs orphan May 5-6 `primary_bid_shares_*` rows left behind on installs that ran the reverted #90 acceptance-ratio infrastructure. **Migration runner idempotency**: catches `duplicate column name` / `already exists` errors and stamps `_migrations` as applied, so a half-applied schema state self-heals on the next boot instead of crash-looping. |
| 2.10    | 2026-06-02 | #240 follow-ups and #241. **P&L collected semantic** (#240 follow-up): `/api/finance.collected_sat` reads `rewardEventsRepo.sumPaidUpTo(now)` (lifetime received at the payout address) instead of `payoutObserver.getLastSnapshot().total_unspent_sat` (current UTXO balance). A payout received then spent still counts toward collected; "we count what they put in." **Boot-time address-mismatch refresh** (#240 follow-up, migration 0105): `runtime_state.last_backfilled_payout_address` tracks which address was last fed to `runHistoricalBackfill`. On boot, daemon compares against `cfg.btc_payout_address`; on mismatch (including first-boot NULL) it clears `reward_events`, nulls `tick_metrics.paid_total_sat`, resets the payout-observer snapshot, kicks `scanOnce` + `runHistoricalBackfill` against the live address, stamps the new address. Save-event handler stamps symmetrically. **Boot-time additive backfill** (#240 follow-up): on every restart, if the address matches but `payoutObserver` is wired, the daemon additively re-runs `runHistoricalBackfill` (no DELETE, `INSERT ... ON CONFLICT DO NOTHING` on `tx_hash + output_index`). Catches users whose `reward_events` is stale because an earlier boot's backfill missed the TX (electrs hiccup, transient error, or a now-fixed code bug like the pre-build-558 coinbase-only filter). No-op on bitcoind-only setups (returns "electrs not configured" error string, logged). **Gap-backfill** (#241, migration 0104): `runGapBackfill` walks every `synthetic = 0` row in the last 365 days, finds all consecutive pairs where `delta > 10 min`, processes each gap independently. For each gap: clears stale synthetic rows strictly inside, collects retarget metadata (multi-retarget walk via `bitcoindClient.getblockhash` + `getblockheader` when wired; single pseudo-retarget at the latest retarget height's nearest-pool-block estimate as a fallback), generates a synthetic tick every 5 min plus one at each retarget's canonical time. Cadence ticks colliding with a canonical retarget's 30-min bucket (= 1w chart preset `bucketMs`) are skipped so the canonical sits alone in its bucket and the chart's `prev vs next > 0.5%` retarget-marker detector + sustained-check filter doesn't reject the marker. `runPoolLuckRecompute` query bypasses its `tick_at >= earliestBlock + 30d` eligibility gate for `synthetic = 1` rows: real polled rows still get the gate (protects their write-time-correct `pool_blocks_*_count`), synthetics get partial-coverage recompute (strictly better than null). Boot chain `pool-blocks-backfill -> gap-backfill -> pool-luck-recompute` now has independent `.catch` per stage (a transient pool-blocks-backfill failure no longer silently swallows gap-backfill). PayoutObserver's `getAddress` + `getHistoricalEnabled` closures live-read `cfgRefHolder.value` so dashboard-edited `btc_payout_address` takes effect on the observer's next scan without a daemon restart (was reading from boot-time `cfg` const). |
| 2.9     | 2026-06-02 | Consolidated catch-up covering #225-#239. **Chart marker cap** (#225) counts visible-range events, not buffered fetch. **Payout lifecycle Telegram alerts** (#226, migration 0101): `notify_on_payout_initiated` fires the tick `ocean_unpaid_sat` drops > 30% with residual below the on-chain payout threshold; `notify_on_payout_confirmed` fires once per new `reward_events` row, baselined at boot from `rewardEventsRepo.maxId()`. **Telegram + Display & Logging locale plumbing** (#227 + follow-ups, migration 0102): `display_number_locale` and `display_date_layout` promoted from browser-only localStorage to daemon-managed config so Telegram bodies render with the operator's number-format / date-layout preference; the test-notification preview path also goes through the same `formatInteger` / `formatBtc` / `formatSat` helpers. **Storage-key rename** (#228): all 14 legacy `braiins.*` localStorage keys renamed to `hashrate-autopilot.*` with one-shot migration on first mount; root `package.json` `name` updated. **Difficulty-adjustment tooltip enrichment** (#229) and follow-up coverage gate (#229 follow-up). **Historical network-difficulty backfill** (#230): boot-time service walks NULL `tick_metrics.network_difficulty` rows and writes the correct epoch's difficulty from bitcoind, with `IS NULL` guard so live observations are never clobbered. **BIP 110 scanner restructure** (#231 + follow-ups, #233, #235): range selector replaced with `Current epoch / All` toggle anchored at `BIP110_FIRST_SIGNALING_BLOCK_HEIGHT = 938,903`; per-epoch breakdown with expandable rows and dynamic UASF forecast (`now + (target - tip) × 600s` to match every block-time calculator); deployment-status tooltip lifecycle-aware (LOCKED_IN forecasts next boundary, ACTIVE distinguishes MASF / UASF via `deployment.since`, SIGNALING tense-switches its UASF clause when tip ≥ flag-day). **Solo right-axis at All chart range** (#232) no longer silently truncates to 24h (the previous `?? 24h` fallback fired on `windowMs === null`). **Pool / Miner column split** (#234, #237): coinbase extraction splits into `{ pool, miner }`; Ocean blocks surface both, non-Ocean blocks show pool only. **Right-axis constant-data rendering** (#236 + follow-up): when every tick formats identically the axis re-pads to a value-relative minimum, anchoring the actual value at top with nice round ticks below. **User-configurable chart colors** (#238, migration 0103): `chart_color_overrides` JSON object with per-series `#RRGGBB` overrides; Settings UI on Display & Logging exposes a swatch + native picker + reset per series across 18 named slots. **Pool-block-credited credit math** (#239): credit number now Ocean's actual unpaid-delta when computable, falling back to `~share_log_pct × reward` only on first alert post-restart, multi-block ticks, or right after a payout. Project-wide source sweep removed all em dashes (-) from `.ts` / `.tsx`. |
| 2.13    | 2026-06-07 | v1.13.0 release. **Configurable StatsBar tiles** (#266): operator picks from a ~22-tile catalogue (uptime decomposition, hashrate averages, cost/overpay, three pool-luck windows with window-aware emerald/amber/red bands, share log/rejection, wallet runway, hashrate target, Bitaxe fleet hashrate/power/J-per-TH/best-diff); per-slot picker dropdown, drag-to-reorder via hover-revealed grips, up to 24 tiles. Choice persists daemon-side in `config.dashboard_tiles` so the layout follows the operator across browsers. **Flat /history page** (#256 v2): dedicated route replacing the per-bid collapsible view; flat sortable table of every bid event, filter chips with Lucide glyphs, full bid id, locale-aware custom date picker (DatePicker.tsx replaces browser-native `<input type=date>`), denomination-aware `\|Δ price\| ≥ N` filter, server-side `before_id` cursor pagination. SQL coalesces orphan-CREATE rows whose `braiins_order_id` lands later (1 h window), carries `speed_limit_ph` forward across an order, and renders EDIT_SPEED rows with the bid effective last-known price in both before/after cells. **Synced crosshair** (#257): hovering either Status chart draws a vertical guide line on both with a floating readout of every visible series at the snapped tick; click to pin, Esc/click-outside dismisses, touch press-and-hold. **Drag-to-reorder dashboard cards** (#244 v2/v3): top-level Status blocks reordered via per-card grip handles (still gated behind a header Rearrange button after the v2 always-on gutter trial proved too costly horizontally). Card listeners bound to the grip button only so chart pan/zoom and panel buttons stay interactive while editing. **USD greys out instead of disappearing** (#274): denomination toggle distinguishes "USD disabled" (`btc_price_source = 'none'`; hide) from "USD configured but unreachable" (`btcPrice === null` with source set; render disabled with hover tooltip pointing at Config → Pool & Payout → BTC Price Oracle and the Test button). **BTC oracle Test button inline** (#270 follow-up): moves from below the helper text to inline-right of the Price source dropdown, matching the Pool URL / Datum / Telegram / bitcoind / electrs Test-connection idiom across Config. **`telegram_chat_id` redacted in `/api/debug/dump`** (#267 user report): pair with bot_token to message-spam private chats so it joins the personal-but-not-credential list alongside `telegram_instance_label` and the DDNS fields. **Scan-cancel v2** (#259 v2): `AxeOSScanner.cancel()` now aborts in-flight HTTP probes via an `AbortController` plumbed through `getSystemInfo(externalSignal)` so cancel-to-state-cancelled latency drops from ~1.5 s to a few ms; dashboard polls scan status while last seen state was running so the trigger button reliably reverts to "Scan local network". **NerdAxe numeric `bestDiff`** (#260): firmware reports the field as a raw number where stock ESP-Miner reports magnitude-suffixed strings ("4.29G"); parser now accepts both, formats for display, stores at full precision; one device's malformed payload can no longer take down the whole fleet's poll, and unreachable-device errors include the underlying network error code. **Hero price card mobile** (#268): in BTC denomination on iPhone the ~10-char "0,00046582" plus the absolute-positioned ±delta badge overflowed the half-width column; PRICE / DELIVERED stack vertically on `< sm`, big numbers drop to `text-3xl`, badge moves inline-below the number on mobile. Desktop layout unchanged. **Bid pending-cancel race** (#276): controller no longer re-mutates bids in `BID_STATUS_PENDING_CANCEL`; eliminates the duplicate-cancel ladder when Braiins is mid-tear-down. **Pool-luck step marker direction** (#266 follow-up): FOUND dot anchors at `max(luckBefore, luckAfter)`, AGED OUT at `min(...)`, so the dot Y always reflects the event kind rather than the per-block delta (which Ocean's window-snapshot reading can mute or invert). **Misc**: "rejection rate" renamed to "rejection ratio" everywhere (Braiins terminology, not a metric change); price chart Y-axis scales to visible window only (mirrors the hashrate chart's existing behaviour); stat tiles aggregate over the visible window not the prefetch buffer; chart-marker tooltips reposition to the side of the marker so a Hashrate-chart-marker tooltip stays inside the hashrate panel; `/api/debug/dump` covers every diagnosable subsystem; mobile nav folds into the hamburger so the top bar stays single-row on iPhone. No new migrations — `/api/stats.avg_share_rejection_pct` removed (single source of truth for share rejection is now `/api/finance/range.braiins_rejection_pct`, same as the Braiins panel row, so the two numbers can no longer disagree across bid rotations). |
| 2.14    | 2026-06-11 | v1.14 catch-up. **Bid-event lifecycle kinds** (#287, migration 0111): MODE_CHANGE / BID_PAUSED / BID_RESUMED as History rows (§12.3), always-visible price-chart markers, and idle-state background bands on both charts driven by per-tick `run_mode` (raw + worst-in-bucket via `/api/metrics`) with edges snapped to MODE_CHANGE timestamps; three new chart-color slots (25 total, §8). **History detail drawer + Reason column** (#285) with bidirectional chart links (jump scrolls to the chart and pulses the marker); sticky History filters. **Legend click-to-hide** (#280) and **EDIT_SPEED markers on the hashrate chart** (#281). **Pool-luck step-dot rule** extracted to a pure vitest-backed helper (largest directional single-tick delta with lower-median noise floor). **Crosshair readout dodges pinned tooltips**. **Payout backend relabeled "Electrum server"** (#273) - electrs / Fulcrum / ElectrumX. No control-loop shape changes. |
