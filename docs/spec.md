# Hashrate Autopilot - Specification (v2.4)

> Status: current, aligned with code through 2026-05-09 (v1.5.4 release).
>
> This spec has been through three pricing regimes. **v1.x** used a depth-aware "fillable + overpay" controller with escalation timers, lowering-patience, and a dampening subsystem. **v2.0** (2026-04-23, same day) retired all of it on the hypothesis that Braiins matched CLOB-style and the bid was a matching-access ceiling. **v2.1** (2026-04-23, hours later) reversed v2.0 after a direct A/B on the live account showed Braiins matches pay-your-bid - the bid price *is* the paid price. The current controller tracks `fillable_ask + overpay_sat_per_eh_day` (the v1.x primitive) without the v1.x timer machinery (which was only needed to simulate that target under a misread of the mechanic); the retired escalation/patience/min-lower-delta knobs stay retired.
>
> Earlier history: v1.0 (2026-04-14) was built around a constraint - that Braiins requires 2FA on every `POST`/`PUT` - which empirical testing on a live account on 2026-04-15 disproved for the owner-scope API token. v1.1 removed the confirmation bot, quiet-hours machinery, pending-confirmation / confirmation-timeout action modes, and operator-availability flag. v1.2-1.9 layered on depth-aware pricing, cheap-mode opportunistic scaling, the Ocean and Datum Gateway integrations, the hashprice-relative dynamic cap, and retention-managed persistence. The what-if simulator shipped in v1.8 and was retired in v2.0 along with the fill-strategy knobs.
>
> v2.2 added appliance packaging (Docker / GHCR / Umbrel / first-run web wizard); v2.3 was a doc-only consistency sweep. **v2.4** (this revision) brings the spec forward to cover the run of features shipped May 2026: the Telegram notification system (#100 / #109, including the per-event-class opt-out, the inline-keyboard ack, and the pool-block-credit "good news" toggle #117), the daemon-managed Dynamic DNS updater + public-IP visibility card (#110 / #111, supporting No-IP / DuckDNS / generic dyndns2), the stale-URL banner that catches a `destination_pool_url` mismatch on a live bid (#113), the wallet-runway alert wiring (#116, default 0 = off), the Config page reorganisation into four tabs with cross-tab search (#107), the price chart's paid / lifetime earnings series (#102) and difficulty-retarget markers, the hashrate chart's expand toggle (#105) and own-block-vs-BIP-110 marker swap (#115), and assorted Test connection buttons across the Pool URL / Datum stats API / DDNS surfaces (#112).
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
- **Network access recommended:** Bitcoin RPC or **much** better Electrs endpoint (LAN). This will allow you to
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
    - Transactions (on-chain + internal): `GET /v1/account/transactions`
- Block reward payouts observed via **Electrs** (preferred, instant lookups) or `bitcoind` RPC (`listreceivedbyaddress` / `gettransaction` / `scantxoutset` fallback) against any reachable Bitcoin node on the LAN. The node can be Bitcoin Knots / Bitcoin Core running on Umbrel, Start9, a NAS, a VPS, or bare metal; the daemon just needs RPC or Electrum-protocol reach to it.
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
- Pool blocks + luck: `pool_blocks_24h_count`, `pool_blocks_7d_count`, `pool_hashrate_ph_avg_24h`, `pool_hashrate_ph_avg_7d`,
  `pool_luck_24h`, `pool_luck_7d` (gap-based per-tick luck = `(600 / pool_share) / time_since_last_pool_block`). (#92)

The full DDL (with comments and migration numbers) lives in `architecture.md` §5; this list is the operator-facing inventory.

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
- `wallet_runway_alert_days` - threshold below which the wallet-runway Telegram alert fires (#116). **0 = disabled** end-to-end (no transition arming, no Telegram POST, no alert row). New installs default to 0 so a freshly-installed unfunded-wallet daemon does not IMPORTANT-alert mid-wizard; operator chooses a value when they are ready to be told. Field type is `nonNegativeInt`.

**Outage tolerance - profile selector + individual overrides:**

Dashboard surfaces a single profile dropdown: **Aggressive / Regular / Relaxed / Custom**. Selecting a profile sets
the thresholds to a preset bundle. Editing any individual threshold switches the profile to Custom.

| Threshold                                | Aggressive | Regular | Relaxed (default) |
|------------------------------------------|------------|---------|-------------------|
| `below_floor_alert_after_minutes`        | 10         | 30      | 60                |
| `zero_hashrate_loud_alert_after_minutes` | 30         | 120     | 360               |

Plus (not profile-driven; set once, rarely tuned):

- `pool_outage_blip_tolerance_seconds` (default 120)
- `api_outage_alert_after_minutes` (default 15)

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

**EDIT_PRICE deadband.** Emitted when `|target_price − current_bid_price| >= max(tick_size,
overpay_sat_per_eh_day / 5)`. At the default overpay this is a ~200 sat/PH/day deadband, absorbing the
±1-5 sat/PH/day orderbook jitter that would otherwise trigger a mutation per tick. Never below
`tick_size` - Braiins rejects smaller edits. Applied symmetrically to raises and lowers; the 10-minute
Braiins cooldown on price decreases is enforced one layer below by `gate.ts`.

**Cheap-mode interaction.** Cheap-mode (below) changes `target_hashrate_ph` opportunistically; the
pricing formula is unchanged.

- `handover_window_minutes` - manual-override suppression window.

**Daemon startup:**

- `boot_mode` - `ALWAYS_DRY_RUN` (default, safest) | `LAST_MODE` (resume, with PAUSED → DRY_RUN) | `ALWAYS_LIVE`.

**Opportunistic scaling (cheap-mode):**

Lives in its own section on Config -> Strategy (#136) with an explicit **Enable cheap mode** checkbox at the top. When unchecked, the three fields grey out and are non-interactive; the daemon's activation sentinel is `cheap_threshold_pct > 0` (toggle-on writes 95, toggle-off writes 0). Three knobs:

- `cheap_target_hashrate_ph` - higher-than-normal target to run when the market is cheap (default 0 = disabled).
- `cheap_threshold_pct` - cheap-mode activates when the market price drops below `hashprice x (cheap_threshold_pct / 100)`. The "market price" reference is `best_ask` (cheapest price at which any supply exists) - a coarser signal than the depth-aware `fillable_ask` the pricing formula uses, but sufficient for cheap-mode's on/off decision. Both `cheap_target_hashrate_ph` and `cheap_threshold_pct` must be non-zero to activate. When cheap-mode is active, the pricing formula is unchanged - only `target_hashrate_ph` is swapped out for `cheap_target_hashrate_ph`, which feeds into `cheapestAskForDepth` and the bid's `speed_limit_ph`.
- `cheap_sustained_window_minutes` - rolling-average window for the engagement check (#50). Default 0 keeps the legacy per-tick spot behaviour. When > 0, cheap-mode engages only when `avg(best_ask)` over this many minutes is below `cheap_threshold_pct x avg(hashprice)` over the same window - averages are computed from `tick_metrics` (no new columns). Avoids flapping cheap-mode on single-tick market spikes; natural hysteresis falls out of the window-based evaluation (the threshold only flips when the whole window crosses it). Requires >=5 samples in the window before honouring it; below that, falls back to the spot check (same "insufficient history" pattern used by `/api/finance/range`).

**Datum Gateway integration (optional, informational only):**

- `datum_api_url` - HTTP base URL of the Datum Gateway's `/umbrel-api` endpoint. When null, the dashboard's Datum
  panel shows a "not configured" empty state and the daemon writes `null` to `tick_metrics.datum_hashrate_ph`.
  Integration is never on the control path - if Datum is unreachable the control loop continues unchanged.
  See `docs/setup-datum-api.md` for the Umbrel-side port-exposure recipe.

**Retention (append-only tables):**

- `tick_metrics_retention_days` - default 365 (cheap numeric series; backs every chart). 0 disables pruning.
- `decisions_uneventful_retention_days` - default 7 (rows with no proposals; heavy JSON state snapshots - main bloat
  lever).
- `decisions_eventful_retention_days` - default 365 (rows with at least one proposal - rare and high-value forensic
  records).

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

**Integrations:**

- `btc_payout_address`
- `bitcoind_rpc_url` + `bitcoind_rpc_user` + `bitcoind_rpc_password` (live-editable; seeded from sops secrets on
  first boot)
- Optional `electrs_host` + `electrs_port` (preferred over `bitcoind` RPC for balance lookups - instant)
- `payout_source` - `none` | `electrs` | `bitcoind`
- `block_explorer_url_template` - URL template applied at click time on every dashboard surface that links to a block (Hashrate-chart cube markers, OCEAN panel "last pool block" row, BIP 110 scan results, BlockTooltip). Placeholders `{hash}` and `{height}` are substituted; at least one must be present. Default `https://mempool.space/block/{hash}`. Privacy-conscious operators point this at their own explorer (e.g. `http://umbrel:3006/block/{hash}`); the Config page exposes mempool.space / blockstream.info / blockchair.com / btcscan.org / btc.com presets plus a free-form custom field. (#22)
- `block_explorer_tx_url_template` - separate template for transaction links (the on-chain payout dot on the Price chart deep-links via this). Placeholders `{txid}` and `{hash}` are substituted; default `https://mempool.space/tx/{txid}`. Migration 0071 derives the value from the operator's existing block template via known-preset matching, falling back to a `/block/{hash}` -> `/tx/{txid}` string replacement (catches local-Umbrel mempool variants). Config-page presets set both block + tx templates atomically.
- `btc_price_source` - `none` | `coingecko` | `coinbase` | `bitstamp` | `kraken` (feeds the dashboard sat <-> USD toggle)
- `block_found_sound` - `'off'` (default) | bundled name (`cartoon-cowbell`, `glass-drop-and-roll`, `metallic-clank-1`, `metallic-clank-2`, `ocean-mining-found-a-block`) | `'custom'` (operator-uploaded MP3, <=200 KB, stored as SQLite blob via `POST /api/config/block-found-sound`). Dashboard fires the chosen sound once per new Ocean pool block (max-`height` increment over `/api/ocean.recent_blocks`); first-poll-after-load establishes a silent baseline so the existing backlog never replays. Operator's intent is "a block was found" not "an on-chain payout to my address confirmed" - the trigger is Ocean, not the `reward_events` payout-observer table. (#88, migration 0052)
- Braiins `owner_access_token` + optional `read_only_access_token` (stored in sops secrets, not the config table)

**Telegram notifications (#100 / #106 / #109 / #117):**

- `telegram_bot_token` - bot credential from @BotFather. Live-editable from the dashboard; mirrors the `bitcoind_rpc_password` dual-location pattern (config-table column overrides the secrets-table fallback). Empty string = unconfigured; the notifier short-circuits with `delivery_status='failed'`.
- `telegram_chat_id` - destination chat. Numeric ID from @userinfobot. Empty = unconfigured.
- `telegram_instance_label` - optional per-instance source label. When non-empty, the Telegram sink prefixes every message with `[<label>] ` so an operator running multiple daemons against the same bot/chat can tell them apart.
- `notifications_muted` - global mute toggle. When `true` the notifier still records every alert row with `delivery_status='muted'` for the audit trail, but skips the Telegram POST.
- `notification_retry_interval_minutes` - cadence between retry attempts while state remains bad. Default 30. First attempt fires immediately on threshold crossing; up to 4 retries follow at this cadence, then a final "giving up" message. Recovery messages bypass this entirely.
- `notification_disabled_event_classes` - per-class opt-out list (`string[]`, stored as comma-separated TEXT, #106). Empty = all classes enabled. When an event_class is in the list, the AlertEvaluator short-circuits before arming any timer - no alert row, no retry, no recovery. New event classes default to enabled (no migration required when adding one).
- `notify_on_pool_block_credit` - off-by-default INFO Telegram message at every TIDES credit (#117). Body contains block height, total reward, our share log %, our credit in sat, and unpaid-total progress toward the 1,048,576-sat on-chain payout threshold. Severity is INFO (no retry ladder, no inline ack button). The audible cue and the chart marker fire independently of this toggle.
- `notify_on_braiins_deposit` - off-by-default master toggle for the Braiins deposit lifecycle events (`braiins_deposit_detected`, `braiins_deposit_available`, `braiins_deposit_returned`). A single tile on the Notifications tab gates all three under one switch (#141 / #143).
- `notification_locale` - language for Telegram alert copy. `'en'` / `'nl'` / `'es'`; default `'en'`. Independent of the dashboard's display language (#131). Picker on Config -> Notifications.

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
- The controller does **not** currently auto-transition to PAUSED on sustained pool outages, nor
  auto-recover to LIVE. The v1.x spec called for both; they were not carried through the subsequent
  rewrites. Active bids continue to bid for hashrate regardless of whether the operator's pool is
  reachable - if the pool is down, Braiins may observe zero delivery and stop matching on that bid,
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

### 9.1 External notification channel (#100, shipped)

The dashboard's `/alerts` page is the source of truth for the audit trail; Telegram is the
external push channel that wakes the operator when the dashboard isn't being watched.

**Channel:** Telegram only in v1.6+. The notifier is structured around a `NotificationSink`
interface so a future Nostr / ntfy / email backend can be swapped in without touching the
event detectors. Setup walkthrough at [`docs/setup-telegram.md`](setup-telegram.md).

**Events that fire Telegram:**

IMPORTANT severity (9) - hard outages that need a phone alarm:

1. **Datum stratum unreachable** for `datum_unreachable_alert_after_minutes` (#135 - was `pool_outage_blip_tolerance_seconds × 5`; now an independent knob with an inline-minute input on the Notifications tab).
2. **Hashrate below floor** for `below_floor_alert_after_minutes`.
3. **Zero hashrate** for `zero_hashrate_loud_alert_after_minutes`.
4. **Braiins API unreachable** for `api_outage_alert_after_minutes`.
5. **Wallet runway** below `wallet_runway_alert_days`.
6. **Unknown bid detected** (already triggers daemon auto-PAUSE; now also rings Telegram).
7. **Bid sustained-paused by Braiins** for `sustained_paused_alert_after_minutes` (#135 - was `pool_outage_blip_tolerance_seconds × 5`; now an independent knob).
8. **Braiins deposit returned** - compliance bounced a deposit back (`return_tx_id` non-null on the on-chain endpoint). Real money on the line.

WARNING severity - soft warnings that can wait for the next dashboard glance:

9. **Beta-exit detected** - any active owned bid reports `fee_rate_pct > 0`.

INFO severity (opt-in, good news + lifecycle):

- **Pool-block credit** (TIDES) - opt-in Telegram via the `notify_on_pool_block_credit` toggle. Body contains block height, total reward, our share log %, our credit in sat, and unpaid-total progress toward the 1,048,576-sat on-chain payout threshold. No retry ladder; no inline ack button.
- **Braiins deposit detected** - fires when `braiins_total_deposited_sat` ticks up (mempool / first-confirmation). Gate: `notify_on_braiins_deposit` master toggle.
- **Braiins deposit available** - fires when the on-chain endpoint surfaces the deposit as `DEPOSIT_STATUS_CREDITED` (typically 6-12 min after detected). Same master toggle.
- Ocean own-found block (gold crown on the Hashrate chart - see §12.1).
- On-chain payout received (P&L panel).

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

- **Global mute** (`notifications_muted` config flag): silences all Telegram POSTs; alerts table still records every row with `delivery_status = 'muted'` for the audit trail.
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

- Total funded in (autodetected from `GET /v1/account/transactions` deposits; manual override possible).
- Current Braiins wallet balance.
- Cumulative spend (from filled bids; autopilot and foreign combined).
- Spend per calendar month.
- Cumulative block reward income detected at `btc_payout_address` via Electrs or `bitcoind` RPC, valued at BTC price
  at time of receipt. BTC price source: TBD - picked at implementation time.
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

Two pages: **Status** (default) and **Config**. Both bind to the LAN only (`0.0.0.0:3010` by default;
`HTTP_HOST=127.0.0.1` to restrict to loopback). Remote access is expected to go through a VPN / Tailscale
perimeter; the dashboard has a shared-password second gate, not full auth.

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
- **Time-range picker.** 3h / 6h / 12h / 24h / 1w / 1m / 1y / all. Persisted in `localStorage`. Drives
  both charts, the stats bar, and the per-day P&L card.
- **Stats bar.** UPTIME (counter-derived, see §11.1 notes on delivered hashrate), AVG BRAIINS, AVG
  DATUM, AVG OCEAN (three side-by-side hashrate averages), AVG COST / PH DELIVERED (same metric as the
  hero PRICE card; deliberately duplicated so each panel stands alone), AVG COST VS HASHPRICE
  (effective-vs-hashprice delta, signed).
- **Hashrate chart.** Three series: `delivered (Braiins)` (amber), `received (Datum)` (emerald), `received (Ocean)` (blue). Target + floor as dashed horizontal references. Per-series rolling-mean smoothing via `braiins_hashrate_smoothing_minutes` and `datum_hashrate_smoothing_minutes`; Ocean is server-smoothed. Each chart's title carries an **expand / collapse toggle** (#105) that doubles the chart height for closer reading. Pool-block markers (one per Ocean-credited pool block) follow a precedence-ordered shape vocabulary (#115): own block (Ocean credited the coinbase to our payout address) -> **gold CROWN**; BIP 110-signalling pool block -> **yellow CUBE** (#94, detection: `(version & 0xe0000000) === 0x20000000 && (version & 0x10) !== 0`, block-header version cached per `block_hash` via migration 0058); default pool block -> blue cube. Tooltip header label and color follow the same precedence (own > BIP 110 > default). Click opens the configured block explorer. A right-axis dropdown above the chart (#93, persisted to localStorage) selects one secondary series: `none` (default), `share_log %`, `network difficulty` (renders **difficulty-retarget markers** at every detected retarget tick - per-tick step > 0.5% with sustained-value check on the next non-null tick to filter spurious bucket-AVG detections; tooltip shows date, new difficulty, previous epoch's difficulty, and % change), `pool hashrate`, `pool luck (24h)` / `pool luck (7d)` (#92, gap-based per-tick luck = `count_in_window / (pool_share × (window + elapsed) / 600)`).
- **Price chart.** Four always-on lines: `our bid` (amber), `fillable` (cyan, the controller's tracking anchor), `hashprice` (violet, dashed), `max bid` / effective ceiling (red, with a red gradient above the line marking the off-limits region). Bid-event dots (yellow / cyan / red) on the amber line mark CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL events; clicking pins a detail panel with `fillable`, `overpay`, `hashprice`, cap inputs, effective cap at that tick, and a JSON export button. Per-range filtering: 3h-24h shows all four kinds; 1w drops EDIT_PRICE; 1m / 1y / all show none. See `CHART_RANGE_SPECS[r].showEventKinds` in `packages/shared/src/chart-ranges.ts`. A right-axis dropdown (#93) selects one secondary series: `none` (default), `effective rate` (#90/#93), `block reward`, `BTC/USD`, `unpaid earnings`, **`paid earnings (lifetime)`** (#102, monotonically non-decreasing cumulative on-chain payouts to the configured address; per-tick `paid_total_sat` derived from `reward_events` via migration 0066), **`lifetime earnings (paid + unpaid)`** (the natural metric that survives payout cliffs - paid_total + ocean_unpaid). When the right-axis is set to a step-event series (paid / unpaid / lifetime earnings), the chart renders **clickable dots** at each event - on-chain payout dots deep-link via `block_explorer_tx_url_template`, pool-block dots reuse the rich tooltip shape from the Hashrate chart (reward, our share, BIP 110 signal, explorer link).
- **Stale-URL banner** (#113, top of page when triggered). Renders when an active Braiins bid was created with a `dest_upstream.url` whose hostname:port (case-insensitive) differs from current `destination_pool_url`. IP-only DDNS pushes for the same hostname don't trigger it. Banner shows old vs new host:port, the unconsumed_sat that would be refunded, an exit-fee caveat, and a confirm-then-cancel button that calls Braiins's CANCEL_BID. Next decision tick auto-creates a fresh bid with the new URL via the existing CREATE_BID gate.
- **Service panels (three-column).** BRAIINS (API reachability, delivered vs target, wallet balance,
  runway at current spend rate). DATUM GATEWAY (stratum reachability, gateway-measured hashrate,
  connected workers - if `datum_api_url` is configured). OCEAN (API reachability, Ocean-credited hashrate,
  current hashprice, recent blocks, time to next payout, plus `pool blocks 24h/7d` rows with inline
  `Nx lucky/unlucky` annotations from #92 - share computed live from
  `pool_hashrate_ph / network_hashrate` so the example doesn't drift out of date).
- **BIP 110 scan card** (#95). Status-page diagnostic at the bottom of the page with a window selector
  (2016 / 4032 / 8064 / 16128 / 32256 blocks) and a Scan button that calls `GET /api/bip110/scan?blocks=N`.
  Returns deployment header (`status`, `bit`, retarget-window count/threshold/elapsed when the node is
  Knots-patched and reports the BIP 110 deployment) plus a table of signaling block heights, hashes,
  times (relative + UTC on hover), and `version` hex with mempool.space links. Locale-aware number
  formatting via `formatNumber(...intlLocale)`; sorted newest-first; full hashes (no truncation). The
  card is operator-facing scaffolding for verifying the crown marker (#94) against known signaling
  blocks; once that's verified it can be removed without touching the rest of Status.
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
| **Strategy** | Hashrate targets, Pricing (fillable-tracking overpay + two safety ceilings + cheap-mode), Budget, Daemon startup |
| **Pool & Payout** | Pool destination + Test connection button, Datum stats API + Test connection button, Dynamic DNS (provider + hostname + credentials + Test connection button + diagnostic IPs - daemon's public IP, hostname resolves to, match/mismatch note), Payout source (none / electrs / bitcoind + Test connection buttons), Profit & Loss scope, BTC price oracle |
| **Notifications** | Telegram bot token + chat ID + Test connection button, instance label, mute toggle, retry interval, wallet-runway threshold, per-event-class opt-out checklist, pool-block-credit toggle, block-found sound (off / bundled / custom upload) |
| **Display & Logging** | Block explorer URL template + transaction URL template, chart smoothing (Braiins / Datum / Braiins price), log retention (tick metrics / decisions uneventful / decisions eventful) |

Saves go through the Zod `AppConfigInvariantsSchema` and take effect on the next tick - no daemon restart needed. PUT `/api/config` snapshots the previous config before upsert and fires `onConfigSaved` callbacks; main.ts wires that to refresh the live `cfgRefHolder.value` immediately AND, when any DDNS-relevant field changed, kick the DDNS updater once so a Pool URL / hostname / credential edit pushes within seconds rather than waiting on the next periodic poll.

### 12.3 Alerts page

Dedicated `/alerts` page (#100 / #109 / #134 / #139): event-grouped audit trail of every alert the daemon evaluated. Events render as collapsible cards grouped into three buckets: **OPEN** (firing, not yet seen by the operator), **ACKNOWLEDGED** (operator clicked seen but the bad state hasn't cleared, or it's an INFO one-shot like pool-block-credited with no recovery semantics), and **RESOLVED** (recovery message has paired in via `paired_alert_id` FK). Open cards render expanded by default; the other two collapse to a header. A free-text search box filters across titles + bodies with hit-highlighting (#134). Sticky **Unacknowledged only** filter (persists per browser via localStorage). A **Mark all as seen (N)** bulk button next to the filter clears every unacked row in one click - server-side via `POST /api/alerts/acknowledge-all`. Telegram messages can also be acked in-place from the operator's phone via the inline-keyboard button (#109). A bottom-right **toast** appears in the dashboard the moment a new alert lands (#142), severity-coloured (red / amber / slate / emerald-for-resolved), with a 5 s auto-dismiss for INFO/recoveries and 15 s for the louder ones; clicking navigates to `/alerts`.

### 12.4 Things the v1 spec listed but the current build does not ship

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
  **[observed]** - Datum Gateway panel shows reachability, and a sustained below-floor state will
  surface the below-floor alert. No auto-cancel of the Braiins bid; operator decides.
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
  **[handled]** - EDIT_PRICE deadband at `max(tick_size, overpay/5)` absorbs it (see §8 "Pricing
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