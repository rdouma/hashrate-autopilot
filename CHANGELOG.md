# Changelog

## 2026-04-22

### `[Fix]` Price chart: fill no longer paints diagonal wedges across null gaps (#46)

Regression introduced by the #44 fix. That change made the price line break into multiple SVG subpaths on null (market-outage) ticks — correct for the line, but the fill wrapper still appended a single baseline closure at the very end (`${pricePath} L<lastX>,<bot> L<firstX>,<bot> Z`). SVG only closed the *last* subpath to the baseline; every interior subpath closed back to its own starting `M`, painting diagonal "sun ray" wedges across the gap.

Now a dedicated `areaPathWithNullGaps` helper emits one closed polygon per non-null sub-run, each anchored to the baseline at its own segment endpoints. The fill tracks right under the price line again, and genuine gaps render as gaps in both line and fill.

### `[Feature]` bid_budget_sat: 0 = "use full wallet balance" sentinel (#40)

`bid_budget_sat` is how much wallet gets slotted into `amount_sat` on each `CREATE_BID`. Because Braiins bids have no duration field and run until `amount_sat` is consumed, the value effectively decided how often the autopilot cycles through cancel/recreate — a second decision the operator was forced to make that doesn't really track how people think about their wallet ("I funded X sat, spend X sat").

Now `0` is a sentinel meaning **"use the full available wallet balance on each CREATE"**, resolved at decision time and clamped to Braiins' 1 BTC per-bid hard cap (spec §13). When the wallet is empty or the balance API is down, the CREATE is skipped silently that tick instead of proposing a doomed bid. Any positive value still pins every new bid to that exact amount like before, so existing operators keep their current behavior end-to-end.

New installs default to `0`. Existing installs are unaffected — their explicit value stays in `config.toml` unchanged. The Config page surfaces the live-resolved figure next to the field when it's set to `0` (e.g. "Currently ≈ 850,000 sat"), and the Status page's CREATE_BID "next action" detail reflects the resolved budget rather than the raw sentinel.

### `[UI]` Chart popovers: show relative age next to absolute timestamp (#45)

The EDIT PRICE popover (yellow dot on price chart) and POOL BLOCK popover (block icon on hashrate chart) used to show only absolute timestamps — readers had to mentally subtract from "now" to answer "how long ago was this?" Now a muted `· 5m ago` / `· 18h 22m ago` / `· 2d 5h ago` suffix sits next to the human-readable line. Uses a new minute-resolution `formatAgeMinutes` helper — single-unit below an hour, two-unit (`Xh Ym` / `Xd Yh`) past that, and a quiet `just now` under a minute. No seconds (popovers don't tick).

### `[Fix]` Price chart: break fillable/hashprice/our-bid lines across null gaps (#44)

Market-outage periods (empty orderbook, no fillable, no hashprice) used to render as straight bridges on the Price chart — the fillable dashed orange line walked directly from the last valid sample to the first sample on the far side of the gap, visually implying the market had a continuous level it didn't. Confusing because the adjacent stats cards (AVG OVERPAY VS FILLABLE etc.) already correctly exclude null ticks from their range-weighted averages, so the eye was reading a visual that the math was explicitly ignoring.

`pathWithNullGaps` — the same helper `HashrateChart` uses for the sparse Datum/Ocean series — now drives the `our bid`, `fillable`, `hashprice`, and effective-cap paths. Null inputs break the line into discrete segments so a real data gap looks like one.

Does not touch the stats math (already correct per the #44 investigation — all three range averages `WHERE price IS NOT NULL AND {fillable,hashprice} IS NOT NULL` or `WHERE delivered_ph > 0`).

## 2026-04-21

### `[Feature]` P&L per-day: range-aware, averaged spend & income, collapsible card (#43)

The **Profit & Loss · per day** card used to mix a 3h-averaged spend with Ocean's 3h income estimate, and repriced the *entire* 3h window the instant the autopilot raised a bid — a 5% price bump made the projected spend number jump 5% for hours that had already happened at the old price. Two problems operators kept hitting: the numbers weren't keyed to the chart range dropdown above them, and mid-window price moves retroactively rewrote history.

Rewritten so both sides share the chart's selected range:
- **ocean est. income/day (3h)** — Ocean's own `daily_estimate_sat`, kept as-is for the authoritative pool-view estimate (always 3h per Ocean; tooltip notes this).
- **projected income/day (3h/6h/24h/…)** — new: `avg(hashprice) × avg(delivered_ph)` across whichever range the chart picker is on. Range-aware counterpart to Ocean's 3h value.
- **projected spend/day (3h/6h/24h/…)** — `avg(bid_price) × avg(delivered_ph)` over the same window. A mid-window price change no longer retroactively reprices earlier hours.
- **projected net/day (…)** = (projected income) − (spend), keyed off the range-aware income so both sides are symmetric.

Under the hood: new `spend_sat` column on `tick_metrics` (migration 0040; backfilled from the existing price + delivery columns) records per-tick sat-spend at insert time, and a new `/api/finance/range?range=<ChartRange>` endpoint returns the aggregates + derived `spend_per_day_sat` / `projected_income_per_day_sat` / `projected_net_per_day_sat` in one call. Dashboard queries the endpoint keyed on `chartRange` (60s refetch) and falls back to the legacy `projectedDailySpendSat3h` path when the server returns `insufficient_history` (< 5 ticks in the window — fresh installs, post-prune, daemon just started).

The card is now **collapsible** — chevron in the header, state persisted per-browser under `pnl-per-day-collapsed`. Operators who want the hashrate chart uncluttered by finance projections can fold it away.

### `[Feature]` Hashrate chart: per-series smoothing windows for Braiins and Datum (#42)

Ocean's hashrate line is an inherently 5-min server-side rolling average (`/user_hashrate` returns it that way), while Braiins-delivered and Datum-received are raw per-tick samples. On the 3h view the raw series jitter wildly around the smooth Ocean line and it's hard to eyeball whether all three sources actually agree on what's being delivered.

Two new Config-page spinners — **Braiins (delivered)** and **Datum (received)** — control independent rolling-mean minute windows applied client-side in `HashrateChart`. Integer, step 5, min 1; `1 = raw (no smoothing)`. Setting both to 5 lines the three lines up on the same cadence and makes disagreements between Braiins, Datum, and Ocean pop out visually.

Implementation: `rollingMean()` in `HashrateChart.tsx` is a time-window (not sample-count) smoother so uneven tick spacing doesn't skew the mean. Ocean is not touched. Null inputs are skipped in the mean; an all-null window yields null so `pathWithNullGaps` still breaks the line on Datum outages. The daemon stores the two settings in `config` (migration 0039) but never reads them — pure display.

### `[UI]` Config page: hide the unwired "Alerts & timers" section (#41)

The five fields in that panel (`below_floor_alert_after_minutes`, `zero_hashrate_loud_alert_after_minutes`, `pool_outage_blip_tolerance_seconds`, `api_outage_alert_after_minutes`, `wallet_runway_alert_days`) were exposed on the Config page but never read by any runtime code — they were scaffolding for a dashboard-alerting layer that was never built, and the closely-related Telegram notifier path (#18) is still unshipped. Surfacing them as editable inputs was actively misleading.

Section removed from `SECTIONS` in `Config.tsx`. The schema fields, DB columns, and API types are left intact so reintroduction (whichever path wins in #41 — wire dashboard alerts, ship Telegram, or delete) is cheap and doesn't need a new migration.

### `[UI]` Sim panel: three-way Esc. mode picker, relocated to header row

Follow-up on the `above_market` landing earlier today (#38). The Sim Parameters bar only exposed a two-way Dampened/Market toggle, which meant the operator couldn't actually backtest `above_market` behaviour against historical ticks — they'd have had to flip the live autopilot to evaluate it, which defeats the whole point of having a simulator.

Two changes:
- **Three-way picker** — Dampened / Market / Above mkt. Re-uses the same amber pill styling as before; above-market uses the short label to keep the pill compact.
- **Moved to the header row** — the Esc. mode control sits alongside the Reset / Apply to config buttons instead of inside the numeric-inputs grid. Rationale: the numeric grid dropped from `lg:grid-cols-8` back to `lg:grid-cols-7`, giving the remaining seven inputs (Overpay, Max bid, Max over hashprice, Esc. step, Esc. window, Wait to lower, Min delta) a noticeable bit of extra horizontal breathing room on wider viewports. The mode selector is a tool-level control (like Reset / Apply), not a field-level input, so its new location is semantically cleaner too.

Under the hood: `simParams` stays a `Record<string, number>` for the numeric-field loop; `escalation_mode` is now a separate typed state slot (`'dampened' | 'market' | 'above_market'`) on `StatusPage`, threaded into `SimParamBar`. The sim query key includes both, so changing the mode re-runs the replay engine. The Apply-to-config flow writes the string straight through — no more 0/1 boolean indirection.

### `[Feature]` escalation_mode: add `above_market` (preemptive raise) (#38)

New third value for `escalation_mode` alongside `market` and `dampened`. Where the existing two modes are **reactive** (they wait for delivery to drop under the floor for `fill_escalation_after_minutes`, then either step up or jump to target), `above_market` is **preemptive** — the instant the market catches up enough that `current_bid < fillable + overpay`, a new `below_target_since` timer starts. When it clears `fill_escalation_after_minutes`, the autopilot jumps to target (same as `market`), even while delivery is still fine. Defends the fill instead of recovering from a cut-off.

No new numeric parameters. Reuses `overpay_sat_per_eh_day` (defines the target gap), `fill_escalation_after_minutes` (how long the trigger condition must hold), and `lower_patience_minutes` (unchanged — the lowering path is identical across all three modes). Same effective cap (`min(max_bid, hashprice + max_overpay)`) — preemptive mode cannot push past the ceiling any more than reactive escalation can.

Wired end-to-end:
- **Daemon**: new persisted `below_target_since_ms` on `runtime_state` (migration 0038), mirroring the existing floor/lower timers so a restart doesn't reset the window. `tick.ts` populates it each tick via a new `computeBelowTarget()` predicate. `decide.ts`'s `shouldTriggerEscalation` branches on `escalation_mode` — reads `below_target_since` under `above_market`, `below_floor_since` under the others. The `above_market` raise path shares the `market`-mode price calc (jump to target, not stepped).
- **Simulator** (`routes/simulate.ts`): mirrored — new `belowTargetSince` tracker, same branching on mode so sim replay matches live decisions.
- **Next Action predictor** (`routes/status.ts`): new preemptive-raise countdown surfaces `Market caught up to bid (X < target Y sat/PH/day). Preemptive raise in N min.` when `above_market` mode is selected and the bid is below target. Honours the dynamic/fixed cap the same way the reactive predictor does.
- **Dashboard Config page**: third option on the escalation-mode selector (`Above market (preemptive — raise before cut-off)`) with a help note explaining the reactive-vs-preemptive distinction.

Sim panel's two-way escalation toggle still flips between `market` and `dampened` only — a three-way picker on the sim bar is a follow-up. Operators testing `above_market` flip it on the Config page and observe the live autopilot.

### `[Feature]` Dashboard login: "Remember me on this device" checkbox (#39)

Basic-Auth password was stored in `sessionStorage`, which tab-scoped closes/backgrounds drop on mobile — operators were re-entering the password on every visit from their phone. Added a **Remember me on this device** checkbox to the login form (default: checked). When ticked, the password writes to `localStorage` so it survives tab closes and device reboots; unticked keeps the old per-tab behaviour. `getPassword()` reads localStorage first, then sessionStorage, so the rest of the app is oblivious to which backend is in use. `clearPassword()` clears both (for the sign-out path, belt-and-braces).

Security note: LAN-only dashboard behind a password — the realistic threat is physical device access, which `localStorage` persistence doesn't meaningfully worsen.

## v1.1.1 — 2026-04-21

Polish release on top of v1.1.0. No schema changes, no migrations — safe to upgrade in place with `./scripts/deploy.sh`.

The headline fix: projected spend/day and the Braiins runway date no longer jitter tick-to-tick. Both figures now ride the same 3-hour rolling average of delivered hashrate that Ocean uses for its income estimate, so the two sides of the P&L panel are finally on the same cadence. Under that: a `min_delta`-as-floor correction for escalation (builds 78/79 treated it as a veto, which stalled fills when the market moved in tiny increments — now it rounds the next step up to `current + min_delta` instead of skipping entirely), a 3 h range preset on the chart (and a bug fix so the picker actually renders it), and a batch of UI polish — Ocean panel regrouped by meaning, last-pool-block reward relabeled to "our earnings (est.)", Sim **Apply to config** now has visual feedback, amber-500 for the yellow delivered/our-bid lines, and the "US$" label drops the "US" prefix for non-en-US locales. Denomination toggle now appears immediately after enabling the BTC price oracle (no page reload needed).

### `[Fix]` P&L "projected spend/day" and Braiins runway: smooth over 3 h of delivered hashrate

Both figures were computed from the current tick's per-bid `avg_speed_ph`, which
wobbles noticeably minute-to-minute — the headline "projected spend/day" number
on the P&L panel jumped around tick-to-tick even when the autopilot hadn't
changed anything, and the Braiins-card runway date slid back and forth with it.
The income side of the same panel already reads Ocean's "earnings at the
3-hour hashrate" estimate, so operators were comparing a smoothed income
projection against a jittery spend projection.

Fixed by exposing a rolling 3 h average of `delivered_ph` on `/api/status`
(`avg_delivered_ph_3h`, sourced from `tick_metrics` with `AVG(delivered_ph)
WHERE tick_at >= now − 3h`) and switching both callsites to a new
`projectedDailySpendSat3h(bids, avgDeliveredPh3h)` helper that multiplies a
capacity-weighted average of active-bid prices by the 3 h average delivered
hashrate. Single-active-bid case (the common one) collapses to the intuitive
`price × 3h_avg_ph`. Falls back to the instantaneous figure when there's less
than 3 h of history (fresh install / pruned retention). Matches Ocean's own 3 h
window so the income and spend sides of the P&L panel are now on the same
cadence. Tooltip on "projected spend/day" updated to say so.

### `[UI]` Ocean panel: grouped by meaning; last-block "reward" → "our earnings (est.)"

Three tweaks:

- `hashprice (break-even)` moved up under `ocean hashrate`. Both are current observations (same flavour as Datum's `datum hashrate` or Braiins' `delivered`) — nothing to do with our accrued earnings. Grouping them at the top and adding a divider below makes the panel read top→bottom as "what's happening now" → "what we've earned / will earn" → "pool-wide context".
- The last-pool-block section's `reward` row (the full block reward, irrelevant to us) is now `our earnings (est.)` — `total_reward × current share_log`, same math the chart tooltip uses. Approximation for older blocks since share_log drifts, but operator-relevant: it answers "how much did that block put in my unpaid bucket" instead of "what did the pool collectively win".
- Divider inserted between the current-observations group and the earnings group.

### `[UI]` Sim "Apply to config" now has visual feedback

The button swallowed clicks silently — the only "feedback" was that it eventually disappeared when `dirty` went false after the config round-trip, with nothing in between. Added a local `applyState` machine: `Applying…` during the save (button disabled), `Applied ✓` in emerald for 1.5 s on success, `Failed — retry` in red on error (persists until next click). Reset button disables while applying too.

### `[Fix]` Escalation min-delta is a floor, not a veto

Operator clarified the intent of the symmetric min-delta work: when the natural next price sits less than `min_delta` above the current bid, the autopilot should still raise — it just rounds **up** to `current + min_delta` so we never sit one sat above the previous step. The previous behaviour (build 78/79) skipped the escalation entirely, which stalled fills when the market was moving in tiny increments. Raising is now: `min(max(naive_step, current + min_delta), effective_cap)`. Lowering keeps its deadband semantics (`min_delta` remains a veto there — lowering burns the Braiins 10-min cooldown and isn't worth a small saving).

Applied to both `decide.ts` (real controller) and `routes/simulate.ts` (replay engine) so sim and live behave identically.

### `[Fix]` 3 h range selector now visible in the chart picker

Status-page picker was hardcoded to `['6h', '12h', '24h', '1w', '1m', '1y', 'all']` — the shared `CHART_RANGES` array added `3h` but the picker wasn't iterating over it. Swapped the literal for `CHART_RANGES.map(...)` so future ranges are picked up without touching the render site.

### `[Feature]` Chart range picker: added 3 h preset

New `3h` option at the left end of the range picker, sitting before `6h`. Same raw-rows (no-aggregation) treatment as the other short presets, events overlay on. Added to the shared `CHART_RANGES` array + `CHART_RANGE_SPECS` map so the server-side aggregation logic and the dashboard picker stay in lockstep.

### `[UI]` Delivered (Braiins) / our-bid: amber-400 → amber-500

Operator eyecheck: on the live dashboard the Hashrate chart's yellow `delivered (Braiins)` line read pale next to the PriceChart's "our bid" line, even though both were the same `#fbbf24`. Bumped both shared constants to Tailwind amber-500 (`#f59e0b`) — a deeper, more orange amber — so the Braiins-side colour reads saturated across both charts. Sim mode moves to `#f97316` (orange-500) on both charts for a consistent toggled-on overlay. The gold found-by-us block cube keeps `#fbbf24`, now the unique "jackpot" accent.

### `[Fix]` Denomination toggle reacts to config save; USD label drops the "US" prefix (#37)

Two small fixes in one pass:

- Enabling the BTC price oracle in Config (`btc_price_source: none` → `coingecko`/etc.) now makes the sats/USD toggle in the header appear immediately after Save. Previously the operator had to reload the page — the config-save `onSuccess` invalidated the status / finance / stats / metrics queries but forgot `['btc-price']`, so the DenominationToggle kept seeing `btcPrice === null` until the next 5-min poll. Added the invalidation.
- On non-`en-US` locales, USD values rendered as "US$ 36,48" because `Intl.NumberFormat` disambiguates the currency symbol by default. That "US" prefix ate horizontal space on the narrow PRICE card and every stat-card value without adding information — inside a Bitcoin dashboard "dollars = USD" is already unambiguous. Replaced the four `style: 'currency', currency: 'USD'` sites (Status PRICE card, Status unit label, PriceChart Y-axis, the shared `formatUsd` helper) with a plain `$` prefix plus locale-aware number formatting. Grouping + decimals still honour the operator's locale; only the symbol changed.

## v1.1.0 — 2026-04-20

Observability release. The dashboard's Hashrate chart grows from two series (Braiins delivered + Datum received) to three — Ocean-credited hashrate is now a first-class line, polled every tick. Every Ocean pool block credited to the operator's wallet is marked on the chart with a clickable cube that opens the configured block explorer. The Ocean panel's "last pool block" is clickable too. A new runway-forecast row on the Braiins panel projects when the account will run dry at the current spend rate. Plenty of UI polish — stat cards split by source, chart palette reassigned for accessibility, Ocean panel re-ordered so the operator's own stats sit at the top. Under the hood: symmetric `min_delta` gate (no more +2/+7 sat price flutter), Ocean refresh dropped 5 min → 60 s, and `monthly_budget_ceiling_sat` removed as a bookkeeping concept that never had enforcement behind it. Migrations 0033-0037 apply on startup.

No controller behaviour changes beyond the `min_delta` tightening; the observability work is purely additive.

### `[Perf]` Dedupe Ocean user_hashrate HTTP call; extract shared spend-per-day helper

Review-pass cleanup. Three issues found, all fixed:

1. **Duplicate `/v1/user_hashrate` HTTP call (MEDIUM).** The per-tick `OceanHashrateService` and the cached `OceanClient` were both hitting the same Ocean endpoint every minute — 2 req/min per wallet where 1 suffices. The split existed because `OceanClient` originally cached for 5 min; that rationale died when the TTL was dropped to 60 s in build 76. Removed the dedicated service; the observe tick path now reads `user_hashrate_5m_ph` off the shared cached `oceanClient.fetchStats()` call.
2. **Duplicated daily-spend calculation (MEDIUM).** The Braiins-panel runway row inlined the same filter + reduce the `FinancePanel`'s `useMemo` already runs. Extracted `projectedDailySpendSat(bids)` to `packages/dashboard/src/lib/finance.ts`; both callers now share it. The inline 50-line `.map` callback became a `<BraiinsBalances>` subcomponent so the reduce runs once per render instead of once per balance row, with a `useMemo` around it.
3. **`fmtHashrate` inline duplicates `formatHashratePH` (NIT).** Two sites (`StatsBar` and `OceanPanel`) were hand-rolling `${n.toFixed(2)} PH/s` when `lib/format.ts#formatHashratePH` exists for exactly this. Swapped both.

Plus minor comment cleanup in HashrateChart (stripped two comments that narrated the commit rather than explained the code) and a spurious double blank line.

### `[Infra]` Remove monthly_budget_ceiling_sat (#35)

Scope-changed #35 — instead of wiring up enforcement (new decide gate, Next-Action hint, alert dedupe, P&L progress indicator) for a knob the operator doesn't want, pulled the field out entirely. Per-bid budget + Braiins account balance already bound outflow; a monthly ceiling on top was cognitive overhead without a real constraint behind it. Migration 0037 drops the column from deployed DBs, the Zod schema / state type / dashboard Config page lose the field, and the Budget section on the Config page now has a single row ("Per-bid budget") instead of two.

### `[Feature]` Block tooltip shows estimated our-share + our-earnings

The block-marker tooltip now renders an "our share (est.)" sub-block when an Ocean share_log value is available: share log % + estimated sat earnings for that block (`reward × share_log / 100`). The estimate uses the *current* share_log, which is approximate for older blocks since share_log drifts as pool hashrate changes — annotated in the tooltip so it's not read as precise history.

### `[Feature]` Braiins panel: runway forecast row

New "runway" row on the Braiins card, under total. Calculated as `total_balance / projected_spend_per_day` (same projected-spend math the P&L panel already uses — sum of `price × effective_speed` across active owned bids), rendered as `X.Y days · ~Apr 25`. Since the Braiins account doesn't auto-replenish, this is the "when does the tank run dry" forecast at the current spend rate. Deliberately not a moving-average — too much overkill for now; a flat snapshot is good enough for pre-deposit planning.

### `[Fix]` Simulator honours symmetric min-delta gate; sim panel label matches

The symmetric `min_delta` gate landed in build 78 updated the real controller (`decide.ts`) but not the simulator's inline replay (`routes/simulate.ts`). Result: the simulated price chart kept painting +87 style escalation edits in market-mode stretches where the live autopilot correctly refused to move. Extended the simulator's escalation path with the same `nextPrice - current >= minLowerDelta` check. Also flipped the lower-path comparison from `>` to `>=` so both gates are consistent. Sim panel field label re-tagged "Min lower delta" → "Min delta" to match the Config page.

### `[UI]` Ocean chart line recoloured to block-cube blue; avg-ocean tooltip spells out the poll/window split

Two operator asks layered on top of build 78:

- The cyan Ocean line in build 78 still disappeared into the green Datum line at the operator's eye-check. Swapped to saturated blue (`#3b82f6`), matching the colour of the TIDES-credited block cubes elsewhere on the chart — reinforces the "Ocean → blue" association and gives a hard contrast against green.
- The Avg Ocean stat tooltip referenced `/v1/user_hashrate` and "5-minute sliding window" without explaining the relationship between our **poll cadence** (every 60 s) and the **window size** of the value we read (`hashrate_300s`, 5 min). Rewritten: "sampled every minute, each sample is a 5-minute smoothed value."

### `[Feature]` Status-page polish pass (operator backlog)

A batch of follow-up tweaks that piled up while other work was in flight:

- **Stat bar redesign.** Dropped the "mutations" card; split the combined "avg hashrate" into three dedicated cards — "avg braiins", "avg datum", "avg ocean" — so the three sources sit side-by-side instead of being packed into one slash-separated cell. Still seven cards total, now a hair narrower to fit.
- **Hashrate chart palette.** `delivered (Braiins)` is now **yellow** (matches the "our bid" yellow on the price chart — semantic "what we pay"), `received (Datum)` is **green** (was the delivered colour), `received (Ocean)` is **cyan** (was the Datum colour). Simulation mode moves to **orange** so the toggled-on sim still reads distinct from delivered. The purple / blue Ocean line was near-invisible for colour-blind operators.
- **Ocean panel reorder.** Operator-centric rows (ocean hashrate, share log, unpaid, next block est., income/day est., next payout, break-even hashprice) are now at the top of the panel — parity with the Braiins / Datum panels, where the panel's own hashrate is always the first row. Pool-wide context (last pool block, pool blocks 24h / 7d, pool users, pool workers) moved to the bottom under a divider.
- **Explorer link style.** The "last pool block" value is still sky-blue and hover-brightens, but the underline is gone — colour alone communicates "click me" without the visual noise.
- **"Min lower delta" → "Min delta".** The deadband now applies in **both directions**: the autopilot no longer fires EDIT_PRICE on a +2 / +7 sat market tick either. Storage key (`min_lower_delta_sat_per_eh_day`) unchanged so existing configs keep their value; label + description rewritten to reflect the symmetric gate.
- **Next Action copy fix.** The "too expensive to fill" message referenced the config *variable* name `max_overpay_vs_hashprice` — operators see the human label "Max premium over hashprice" on the Config page, which is what the hint now links them to.

### `[Infra]` Remove block-marker miner-identity enrichment

Pulled the whole enrichment feature landed in builds 73 / 75 / 76. It required bitcoind RPC regardless of the operator's payout-source choice, which muddied the Config panel; the `getblock` coinbase parse rarely yielded a useful operator tag anyway; and the Ocean feed already tells us these are all Ocean blocks by construction, so "pool_name = OCEAN" wasn't buying much on its own. Tooltip is back to reward / subsidy / fees only — cleaner and doesn't rely on a local bitcoind being reachable.

Reverts: `services/coinbase.ts`, `state/repos/block_metadata.ts`, the bitcoind-client `getBlock` helper, the `OurBlock.pool_name` / `miner_tag` fields, the Ocean-panel "miner" row, and the always-visible bitcoind RPC fields in the Config panel (they're gated behind `payout_source === 'bitcoind'` again, which is how it was before). Adds migration 0036 to drop the unused `block_metadata` table on deployed DBs.

### `[Perf]` Ocean panel refreshes every 60 s (was 5 min); enrichment picks up new blocks within a minute

The Ocean panel was on a 5-min refresh (both client-side refetch and server-side cache) which felt sluggish — and because block-marker enrichment only runs on a cache-miss of `/api/ocean`, new blocks took up to 5 minutes to get their `Simple Mining · OCEAN` style label. Dropped both to 60 s, aligned with the chart / tick cadence. Net cost is ~4 req/min to Ocean's public API per wallet — well below any sane rate limit and on par with what Ocean's own dashboard does.

### `[UI]` Bitcoin Core RPC always visible in Config; dual-purpose hint

The bitcoind RPC credentials were previously only shown when "Bitcoin Core RPC" was selected as the on-chain-payout backend. With block-marker miner-identity enrichment added, the credentials are now used by that feature regardless of the payout choice — so an operator running Electrs for payouts was left with the enrichment silently disabled and no UI surface to configure the RPC. Pulled the three fields out from behind the radio-selector gate; they now render unconditionally with a help note that swaps wording based on whether the Electrs or bitcoind payout path is in use.

### `[UI]` Ocean panel shows Ocean-credited hashrate; chart line recoloured to match the block cubes

Follow-up polish on #36 after operator testing. Two tweaks:

- The Ocean panel now has an "ocean hashrate" row alongside the other user-stats rows, sourced from the same 5-min `hashrate_300s` sliding-window the chart plots. Parity with the Braiins / Datum panels which already surface their respective hashrate readings.
- The chart's `received (Ocean)` line was recoloured from violet to the same blue as the TIDES-credited block cubes (#3b82f6). Reinforces the branding association (Ocean → blue), reads more clearly on colour-blind-adjacent displays, and plays nicely with the rest of the palette. Still distinct from the cyan Datum line.

### `[Feature]` Hashrate chart: third series for Ocean-credited hashrate (#36)

The chart previously showed Braiins-delivered and Datum-received, but not what Ocean's own API credits to our payout address — arguably the single most important number ("what hashrate does the pool actually see from us?"). Added a violet `received (Ocean)` line sourced from Ocean's `/v1/user_hashrate` endpoint (the `hashrate_300s` field, a 5-min sliding window — responsive but smooth at a 1-min tick cadence).

Plumbing: new `tick_metrics.ocean_hashrate_ph` column (migration 0035), a small stateless `OceanHashrateService` polled each tick from `observe()` alongside the existing Datum poll, and a `State.ocean_hashrate_ph` field piped through to the metrics API. No control-loop impact — purely observational. The main `OceanClient` keeps its 5-min cache for blocks / pool_stat / statsnap, since none of those need per-tick freshness.

### `[Feature]` Block-marker tooltip shows the miner identity ("Simple Mining · OCEAN")

Block explorers display the miner behind a block as e.g. "Simple Mining · OCEAN", distinct from the Stratum worker label (which, for TIDES-credited pool blocks, is some other operator's rig-name like `14283759` and is meaningless to us). Added local, privacy-preserving enrichment: on each Ocean poll, the daemon calls `getblock <hash> 2` on the operator's own bitcoind node, extracts the coinbase scriptSig, and picks the first operator-meaningful ASCII token as the miner tag. The pool is hardcoded to "OCEAN" for every block (since they come from Ocean's API — no pool-tags database needed).

No external HTTP — no third-party block explorer learns about this node. Enrichment is cached forever per block hash in a new `block_metadata` table (blocks are immutable). Falls back to the Stratum workername when bitcoind RPC isn't configured or the coinbase yields nothing.

Surfaced on the Hashrate-chart cube tooltip (replacing the bare "worker" field) and the Ocean panel (new "miner" row between "found" and "reward").

### `[UI]` Config: Block explorer moved up so P&L and BTC price oracle pair again

Inserting the new "Block explorer" section between the existing "Profit & Loss" and "BTC price oracle" sections broke their side-by-side pairing — both became half-width cards stranded in their own rows. Moved the Block explorer section up one slot (above Profit & Loss) so the P&L + BTC-price-oracle pair reunites on a single row.

### `[UI]` Hashrate chart block tooltip: "worker" → "miner"

Block-marker tooltips labelled the Stratum worker name as "worker", which doesn't read naturally next to the block-explorer vocabulary most operators are used to (where the row is usually called the miner / coinbase tag — e.g. "Foundry USA"). Relabelled to "miner" to match that convention, even though the value still comes from Ocean's `workername` field (the Stratum side, not the coinbase tag).

### `[Feature]` Configurable block explorer; clickable block links (#22)

New config field `block_explorer_url_template` (default `https://mempool.space/block/{hash}`). The Config page exposes it under a new "Block explorer" section with quick-fill preset pills for mempool.space, blockstream.info, blockchair.com, btcscan.org, and btc.com; operators running their own explorer on a local address paste a custom template like `http://umbrel.local:3006/block/{hash}`. Both `{hash}` and `{height}` placeholders are substituted at click time.

Wiring: the Ocean panel's "last pool block" row is now a link to the configured explorer. Block-marker cubes on the Hashrate chart also link out from their tooltips.

### `[UI]` Hashrate chart block tooltips: interactive, richer fields, localised dates

Replaced the SVG `<title>` hover text with an interactive HTML tooltip matching the price-chart edit-event style — dark pill, rounded, pins on click, closes on outside click or the × button. Fields: block height, localised full timestamp (uses the dashboard's configured locale — no more hard-coded American M/D/Y), UTC line, pool reward / subsidy / fees all in BTC with the ₿ symbol (8-decimal mining precision), finder worker, and an "open in block explorer" link. The raw hex block hash, Bitcoin-network difficulty, and transaction count were dropped as non-essential for the operator's day-to-day question of "did we earn anything and where do I dig deeper". The solo-finder ("found by us") case keeps the existing gold colour; TIDES-credited pool blocks (the common case) are now blue (Tailwind blue-500) — distinct from the Datum cyan and the teal delivered curve.

### `[Fix]` Hashrate chart: cubes for every TIDES-credited pool block (#23)

Original issue #23 implementation filtered pool blocks by `username === our_payout_address`, i.e. only marked blocks our own worker literally found — a solo-lottery event that, at 3 PH/s against the network, effectively never happens. The operator saw Ocean's panel report `last pool block 1h 30m ago` and reasonably expected a cube at 15:30 on the chart; none appeared.

Under Ocean TIDES every pool block credits everyone with shares in the 8-block reward window, so the chart now marks every recent pool block returned by Ocean. The rare "our worker found it" case is still distinguished visually — solid-ish dashed line for found-by-us, faint dotted line for TIDES-credit — and the hover tooltip says `FOUND BY US` vs `credited via TIDES`. Legend label is now "pool block". MVP simplification: we do not yet cross-check whether our shares were actually in the reward window at the time of a given block, so a long daemon outage would display cubes for blocks that did not, in reality, credit us.

### `[UI]` Ocean panel: "last block" rows relabeled "last pool block"

The Ocean panel's "last block / blocks 24h / blocks 7d" rows are pool-wide figures (Ocean's `recent_blocks` feed), not blocks found by the operator's own payout address — but the unqualified "last block" read as "your last block." Operators who saw `found 22 min ago` next to no marker on the hashrate chart were correctly confused: the chart only marks blocks credited to the configured payout address (that's issue #23's whole point), and the 22-min-ago block wasn't one of them. Renamed the three rows to `last pool block` / `pool blocks 24h` / `pool blocks 7d` so the distinction is visible on-panel.

### `[UI]` Hashrate chart block markers: isometric cube, matching Ocean's icon

Replaced the `₿` glyph that sat above the block-marker line with a small isometric cube SVG — three rhombus faces (top, front, right) in the gold block-marker colour — so the marker style matches the cube icons Ocean uses on its own block viewer.

## v1.0.3 — 2026-04-20

Defaults polish. The v1.0.2 setup wizard got the installation *process* smooth on a fresh Ubuntu box, but the defaults it wrote in were intentionally-conservative placeholders from the very first prototype — fine to start with, but not what most operators actually want to run. This release retunes them to the values the operator has been running against the live market for weeks, flips escalation mode to `market`, turns the dynamic hashprice cap on by default, and switches P&L to the whole-account scope. Plus a fix for a phantom "Escalation overdue" countdown on the Next Action card when the dynamic cap is what's blocking.

No schema changes, no migration — existing installs keep every stored value; only fresh setups see the new defaults.

### `[Infra]` P&L spent-scope defaults to whole account

Fresh installs now default `spent_scope` to `account` instead of `autopilot`. The whole-account view totals every bid Braiins has on the account (autopilot-placed plus anything else), which tends to match what operators actually want to reconcile against on-chain. The per-autopilot-only view is still available via the toggle on the P&L panel. Existing installs keep their stored preference.

### `[Infra]` Updated first-install config defaults

Fresh installs now start with operator-tested values instead of intentionally-conservative placeholders. All the defaults below express sat/PH/day (the dashboard's unit); stored internally in sat/EH/day.

- `max_bid_sat_per_eh_day` → **49,000 sat/PH/day** (was 60,000)
- `max_overpay_vs_hashprice_sat_per_eh_day` → **2,000 sat/PH/day** (was disabled)
- `overpay_sat_per_eh_day` → **100 sat/PH/day** (was 500)
- `fill_escalation_step_sat_per_eh_day` → **100 sat/PH/day** (was 300)
- `fill_escalation_after_minutes` → **3** (was 30)
- `min_lower_delta_sat_per_eh_day` → **100 sat/PH/day** (was 200)
- `lower_patience_minutes` → **3** (was 15)
- `bid_budget_sat` → **200,000 sat** (was 50,000)
- `monthly_budget_ceiling_sat` → **1,000,000 sat** (was 500,000)

Existing installs keep their stored values — no migration.

### `[Fix]` Next Action card respects the dynamic cap, not just `max_bid`

When the effective cap was `hashprice + max_overpay` (tighter than the fixed `max_bid`) and `fillable + overpay` exceeded it, the card showed a phantom "Escalation in X min … market mode will jump to Y" countdown that could never fire — decide() was correctly refusing because `desiredPrice > effectiveCap`, but the predictor only compared against the fixed cap. Now the predictor computes the effective cap the same way decide() does and, when blocked, shows the specific detail: "Fillable + overpay 47,671 sat/PH/day exceeds your dynamic hashprice+max_overpay cap (47,075 sat/PH/day). Raise max_overpay_vs_hashprice in Config to unblock."

### `[Infra]` Default escalation mode is now `market`

Fresh installs and unconfigured rows default to market-mode escalation (jump straight to `fillable + overpay` when below floor) instead of dampened stepping. The dampened ladder is still available from the Config page; it just isn't the default any more. Existing installs keep their current setting.

## v1.0.2 — 2026-04-20

The "fresh-install survives first contact with Ubuntu" release. v1.0.1 worked well on a machine that was already set up, but a fresh clone on a fresh host surfaced a long list of small paper cuts — missing prerequisites in the README, a dashboard package that didn't declare its own workspace dep, a setup wizard that prompted for dead fields (Telegram, bitcoind RPC), committed secrets files that confused `pnpm run setup`, a `--force` flag that deleted history as a "side effect", copy buttons that silently failed on LAN HTTP, and a price chart that let a far-above-the-data cap line squash 70% of the plot area. This release rolls all of those up plus a new diagnostic tick-log message that surfaces the actual reason `decide()` returned no proposals.

No API or schema changes; safe to upgrade in place with `./scripts/deploy.sh`.

### `[UI]` Price chart: cap line no longer hijacks Y-axis scaling

When the effective cap (fixed `max_bid` or the dynamic `hashprice + max_overpay`) sat well above the live data, the cap line forced the Y-axis to stretch up to accommodate it — squashing the bid/fillable/hashprice lines into a thin strip at the bottom and filling the remaining ~70% of the chart with the red "excluded zone" gradient. This regressed the earlier `ddb5a15` work ("Exclude max bid from price chart Y-axis scaling") once the cap line started tracking the *effective* cap (issue #27) instead of plain `max_bid`. Fix: drop `capPoints` from the auto-scale sample. The cap renders if it falls in the auto-scaled range, and the excluded-zone shading clips to the top edge otherwise.

### `[Infra]` Logger: concrete reason when decide() returns no proposals

`(no proposals — nothing to do)` was a catch-all that hid the actual blocker — whether the market was too expensive vs the effective cap, the orderbook was too thin at the target depth, or the dynamic-cap guard was holding trading. Added an `inferNoActionReason` helper in `main.ts` that mirrors decide()'s decision tree and emits a specific diagnostic reason per tick. Complements the work in #33.

### `[Fix]` `pnpm run setup --force` no longer destroys the history DB

`--force` used to `rm data/state.db` as part of its "overwrite" path, silently wiping every tick_metrics, decisions, bid_events, and owned_bids row on what the operator thought was just a secrets-file refresh. Split into two flags: plain `--force` now only rewrites secrets + age key + sops policy (and the DB-config row is idempotently upserted, preserving all history); explicit `--wipe-db` is required to delete the DB. Retroactive protection for operators coming back from the previous behavior is impossible — but this closes the footgun for anyone re-running setup from here on.

### `[Fix]` Copy buttons work over plain HTTP (LAN hostnames)

The pool-URL and bid-ID copy buttons did nothing when the dashboard was accessed over plain HTTP on a LAN hostname (e.g. `http://clarent:3010`) because `navigator.clipboard` is only defined in secure contexts (HTTPS or localhost). Added `lib/clipboard.ts` with a `copyToClipboard` helper that falls back to an ephemeral `<textarea>` + `document.execCommand('copy')` when the async Clipboard API isn't available, and routed all three existing copy buttons (pool URL, bid ID, price-chart pinned-tooltip JSON) through it. The tooltip JSON copy already had the fallback inline; this consolidates the three into one helper.

### `[Infra]` Drop bitcoind RPC prompts from `pnpm run setup`

`#14` moved bitcoind RPC credentials to the dashboard Config page, but the setup wizard was still prompting for URL / user / password on every fresh install — dead weight, and worse, `bitcoind_rpc_user` validation rejected empty input even though the credentials are only needed when the operator picks `bitcoind` as the payout source (Electrs is the default). Prompts removed. `SecretsSchema`'s three bitcoind fields are now `.optional()`; main.ts's legacy seed-from-secrets path still works when the fields happen to be present, but fresh installs no longer touch them. Read-only Braiins token prompt stays — it's a legit privilege-separation optimization for `READ_ONLY`-scoped API calls.

### `[Infra]` Drop Telegram prompts from `pnpm run setup`

The setup wizard was still asking for a Telegram bot token and chat ID on every install, even though the owner-token API path doesn't need 2FA and in-app notifications haven't been wired up (that's #18). Prompts removed; the corresponding Zod fields in `SecretsSchema` are now `.optional()` and `telegram_chat_id` in `AppConfigInvariantsSchema` defaults to an empty string so existing DB rows keep parsing. The underlying DB columns stay in place pending a later migration alongside the notifications work.

### `[Fix]` Dashboard build order: declare the `@braiins-hashrate/shared` workspace dep

Fresh clones of the repo failed at `pnpm build` with `Cannot find module '@braiins-hashrate/shared'` from the dashboard package. Root cause: `packages/dashboard/package.json` imported from `@braiins-hashrate/shared` without declaring it as a workspace dependency, so pnpm's recursive-build topological sort ran dashboard's `tsc --noEmit` in parallel with shared's build, and dashboard typechecked before shared's `dist/` existed. Worked on already-built machines because `dist/` was stale-but-present. Added the `workspace:*` dep so the two build in order.

### `[UI]` Footer links to the CHANGELOG on GitHub

Dashboard footer now carries a `changelog` link next to the build + hash, pointing at `CHANGELOG.md` on `main`. No local
render — for the curious, a click away.

### `[UI]` Price-chart legend: max-bid swatch is now solid, matching the chart

The legend swatch for "max bid" was drawn dashed while the actual cap line on the chart is solid — visually inconsistent
with no functional reason. Legend now renders solid for that entry.

## v1.0.1 — 2026-04-20

Point release for a significant autopilot-stalling bug (#33): a headless daemon would silently stop producing proposals
once the hashprice cache aged past its 60-min freshness window, because only the dashboard refreshed it. Operators
running without the dashboard open were losing uptime as bids drifted below fillable. Also includes a mobile-layout fix
for the Bids table.

### `[UI]` Bids table: mobile-friendly bid ID cell (#34)

The full-width bid ID restored by #26 wrapped one character per line on mobile viewports because of `break-all` on an
18-character monofont string. On narrow viewports the id column now shows a shortened `B86611…5108` alongside a
copy-to-clipboard icon; desktop keeps the full ID as before. Same `CopyIcon`/`CheckIcon` feedback pattern used on the
Datum pool-URL row.

### `[Fix]` Keep the hashprice cache warm inside the daemon (#33)

The dynamic-cap guard refuses to trade when hashprice is unknown/stale — which was correct, but in steady state the only
thing refreshing the cache was the dashboard's finance poll. A headless daemon running longer than the 60-min freshness
window would silently stop producing proposals, the bid would drift below fillable, and hashrate uptime would collapse.
Added a `HashpriceRefresher` service that polls Ocean every 10 min from the daemon itself, independent of any dashboard
client. Also: the tick log now explicitly says
`(no proposals — hashprice unknown/stale, dynamic-cap guard is holding trading)` when the guard fires, instead of the
bland `(nothing to do)` that hid the problem.

## v1.0.0 — 2026-04-19

First stable release. Tagged so operators who don't want to track `main` daily have a pinned reference to run against.

**Highlights of what's in 1.0:**

- 24/7 price-taker autopilot for the Braiins Hashpower marketplace: creates / escalates / lowers bids against a per-tick
  target (fillable + overpay), capped by the tighter of a fixed maximum and a dynamic `hashprice + max_overpay` ceiling.
- Server-side-safe: honours Braiins' 10-min price-decrease cooldown and the Telegram-2FA-exempt owner-token path;
  respects run-mode gates (DRY_RUN / LIVE / PAUSED) and manual-override locks.
- Independent break-even reference via Ocean: dynamic cap gates on a fresh Ocean hashprice, refuses to trade when that
  reference is unavailable, and falls back to the fixed cap only when the operator hasn't configured the dynamic one.
- Full-history simulator that replays `tick_metrics` under candidate parameters and reports uptime / mutations / cost /
  overpay — now with the Braiins 10-min cooldown and the dynamic cap respected, so simulated stats match what the real
  controller can actually achieve.
- Dashboard with Status + Config pages, per-tick Next Action prediction, depth-aware price / hashrate charts, pinned
  event tooltips with full market context, and P&L per-day + lifetime panels.
- Datum Gateway + Ocean pool integration for end-to-end pipeline observation.

**Bug fixes since CHANGELOG introduction (issues #28–#32):**

- `[Fix]` Dynamic cap no longer silently collapses when the dashboard is closed (#28). Hashprice cache timestamps its
  writes, seeds from a boot-time Ocean fetch, and decide() refuses to trade when the cap is configured but hashprice is
  unknown or stale beyond 60 min.
- `[Fix]` Next Action countdown + progress bar agree from tick 1 and stop promising escalations that can't fire (#29).
  Above-floor shortfalls get a "no escalation scheduled" detail instead of a phantom 3-min countdown.
- `[Fix]` Pinned tooltip's overpay allowance reads from `config_summary` instead of a racy `configQuery`, so it's always
  truthful (#30).
- `[Fix]` P&L per-day rows stop disappearing on transient 0-spend or missing-income states; show `calculating…` when
  Ocean income hasn't landed yet (#31).
- `[Fix]` Simulator enforces the Braiins 10-min price-decrease cooldown; no more simulated lowerings 5–8 minutes apart
  that the real bot could never execute (#32).
- `[Polish]` Event tooltip units use the ≡ sat glyph and muted styling, matching the rest of the Status page.
- `[Polish]` Hashprice row moved from the Braiins card to the Ocean card, where it belongs — it's Ocean-derived, not
  Braiins-reported.
- `[Feature]` Tooltip now surfaces `max overpay vs hashprice` and `hashprice + max overpay` so operators can see which
  cap is binding at the event's tick.

---

## 2026-04-19

### `[Feature]` Max-premium-over-hashprice cap (#27)

New dynamic cap alongside the fixed `max_bid_sat_per_eh_day`: operator can set a maximum sat/PH/day premium over
break-even hashprice, and the effective cap each tick is `min(max_bid, hashprice + max_overpay_vs_hashprice)`. Honored
by the decider, the simulator, and the price chart (solid cap line, shaded excluded zone).

### `[Feature]` Run-decision-now bypasses all pacing (#25)

"Run decision now" now drops both the post-edit lock *and* the patience/settle window in one click, so the pending
decision actually fires instead of requiring ~13 ticks to outlast the window. Also surfaces the resulting decision in a
banner.

### `[Feature]` Bids table shows full bid IDs (#26)

Removed the `.slice(0, 10) + "…"` truncation; full Braiins order IDs are now displayed so they can be copied or
cross-referenced.

### `[Feature]` Ocean-found blocks marked on the hashrate chart (#23)

Blocks credited to our worker are marked on the delivered-hashrate chart so it's obvious when we contributed to a found
block.

### `[Feature]` Datum Gateway panel replaces legacy Pool card

Full Datum panel with stratum/stats reachability tags, pool URL split into protocol/host/port rows, workers connected,
and Datum-reported hashrate. Daemon polls Datum stats each tick.

### `[Feature]` Datum hashrate plotted alongside Braiins

Hashrate chart now overlays Datum's reported hashrate on top of the Braiins delivered line for visual comparison.

### `[Feature]` Mutations stat card

New stat card counting bid mutations (create / edit price / edit speed / cancel) in the selected range, read from the
`bid_events` log.

### `[Feature]` Lower-patience measures continuous market-cheap time

`lower_patience` window now tracks continuous time the market sat below the current bid price, not continuous time above
floor. Better matches operator intent.

### `[Feature]` Simulator respects the dynamic cap

Simulator skips ticks where `fillable + overpay` exceeds the effective cap, plots the simulated cap instead of the
historical one, and exposes "Max over hashprice" in the parameter bar.

### `[Feature]` P&L split into per-day and lifetime-total columns

Split into two panels; also moved next-payout date onto the Ocean panel, and retitled per-day numbers as projections.

### `[Feature]` Price tooltip surfaces max-overpay and dynamic cap

Pinned price-chart tooltip now includes market context plus max-overpay and dynamic-cap values, and clearly marks
simulation-derived points.

### `[Fix]` Terminal bids persisted across refreshes (#24)

Closed/fulfilled bids are cached locally so the daemon doesn't re-paginate the full `/spot/bid` list on every refresh.

### `[Fix]` `above_floor_since` persists across restarts

State was being reset on daemon restart, causing the patience window to restart every boot. Now persisted.

### `[Fix]` `tick-now` actually armed the pacing bypass

The route was clearing the post-edit lock but not the patience window. Now both are bypassed.

### `[Fix]` Stale `tick_metrics` + `decisions` rows pruned hourly (#21)

Old tick-metrics and decisions rows are now GC'd hourly to stop unbounded DB growth.

### `[Fix]` Ocean block timestamps parsed as UTC

Ocean API returns UTC timestamps without the Z; we were parsing them as local time.

### `[Fix]` FinancePanel `useMemo` ordering

`useMemo` hook was called after a `!data` early return, violating hook rules.

### `[Fix]` Zero whole-account spend / closed-vs-active split / broken tooltips

Restored whole-account spend from `/spot/bid counters_committed.amount_consumed_sat`, split closed vs active bids in
P&L, and repaired tooltips that broke in the split.

### `[Fix]` Auto-refetch status when countdown expires

Status polls kept counting down past zero without refetching when the daemon was mid-tick. Fixed — `RefreshCountdown`
now keeps polling and the Datum badge says "API reachable" when live.

### `[Fix]` Honor Datum's reported hashrate unit

Datum reports hashrate in varying units; we were assuming Th/s unconditionally.

### `[Fix]` Tick fires right after saving config

Config save now triggers an immediate tick so the UI reflects changes without a 60s wait.

### `[UI]` Reorder Status panels into the pipeline flow

Panels now flow Ocean → Braiins → Datum → P&L, matching the conceptual pipeline.

### `[UI]` Consistent "updated Xm Ys ago" headers

Every periodic panel now renders the same "updated … ago" header for visual consistency.

### `[UI]` Refresh-in-X countdown on every panel

Datum panel and other periodic panels now show a countdown to the next refresh.

### `[UI]` Braiins/Datum pair shown on avg-hashrate stat

The avg-hashrate card shows both the Braiins-delivered and Datum-reported hashrate side by side.

### `[UI]` Hide Total PH·h; tighten avg-hashrate slash

Removed the Total PH·h card from the default view; cleaned up the "delivered / cap" slash formatting on the Braiins
panel.

### `[UI]` Reorder Braiins pricing rows; drop budget line

Braiins price rows reordered for scanning; redundant budget line removed (budget already shown under Caps).

### `[UI]` Split the P&L into two panels

Spend vs income now live in separate sibling panels instead of sharing one.

### `[Perf]` Polish tick-result banner and refresh countdowns

Consolidated repeated polish work on the banner shown after each tick and the various countdown chips.

### `[Docs]` README + spec + architecture caught up through 2026-04-19

Behavioral changes shipped over the week were folded back into `README.md`, `spec.md`, and architecture docs.

### `[Docs]` Refresh dashboard / simulator / config screenshots

Replaced stale screenshots in the README and added the scrubbed config screenshot.

### `[Docs]` Rewrite Datum setup doc with verified recipe

`docs/setup-datum-api.md` rewritten after verifying the actual Datum integration recipe end-to-end.

### `[Infra]` Document: strip `agent-ready` on pickup/ship

CLAUDE.md: remove `agent-ready` when flipping an issue to `in-progress` and always before `review`.

### `[Infra]` Document: never apply `user-request`

CLAUDE.md: `user-request` is reserved for external-user reports; agent never applies it.

### `[Infra]` Document issue-body, label, and in-progress conventions

CLAUDE.md: prefer `--body-file` for `gh issue create`, pick labels freely from `gh label list`, flip issues to
`in-progress` on pickup.

### `[Infra]` Log raw `/spot/bid` response on first fetch

Logs the first `/spot/bid` response once per session so shape drift is easy to spot.

## 2026-04-18

### `[Feature]` Ocean panel with block data, pool stats, and user earnings

New Ocean panel on Status showing last block, blocks 24h/7d, unpaid earnings, and pool worker count. Merged the
standalone "Braiins Balance" card into a single Braiins panel.

### `[Feature]` `deploy.sh` for pull-build-restart on the deployment machine

Added the one-shot deploy script so the operator can pull + rebuild + restart with a single command on the remote box.

### `[Feature]` Build number + git hash footer

Dashboard footer now shows `build N · hash` so the operator can tell at a glance which revision is running.

### `[Fix]` Suppress browser native auth dialog on 401 responses

401 from the status API was triggering the browser's own Basic-Auth dialog. Dashboard now handles 401 cleanly in-app.

### `[Fix]` Trim decision JSON + `stop.sh` robust against orphans

Decision JSON payloads trimmed to essentials; `stop.sh` now cleans up orphaned processes instead of leaving zombies.

### `[Fix]` Exclude `max_bid` from price chart Y-axis scaling

Having `max_bid` inside the Y-axis scale squashed the actual price line. Now excluded from autoscale.

### `[UI]` Single-field config sections render side by side

Tightened vertical space: config sections with only one field now render side by side instead of stacking.

## 2026-04-17

### `[Feature]` What-if simulator (fully integrated)

Added a backtesting simulator: runs past market data against edited parameters so the operator can see how changes would
have performed. Integrated into the Status page as a real-time/simulation toggle. Polished with filter bar, events,
spinners, parameter bar with escalation-mode selector, and visual distinction from live mode.

### `[Feature]` Opportunistic hashrate scaling (addresses #13)

When the market is cheap vs break-even hashprice, autopilot can scale the target hashrate up to a higher ceiling. Config
UI added and polished.

### `[Feature]` Bitcoin node RPC credentials in dashboard config (addresses #14)

Moved Bitcoin node RPC host/user/pass out of env vars into the dashboard Config page.

### `[Feature]` Lower-patience window

Added a lower-patience window to prevent chasing short market dips — the autopilot will only lower the price after the
market has sat cheap continuously for N minutes.

### `[Feature]` Hashprice + overpay-vs-hashprice as time series + stat

Hashprice and current `max_bid` are now logged as time series; an "overpay vs hashprice" stat card summarizes current
premium.

### `[Feature]` Payout config: radio selector + conditional fields

Restructured payout config into a radio selector with conditional fields; auto-detect now runs once in a migration
rather than every boot.

### `[Feature]` Total PH·h stat; renamed "expected" → "unpaid earnings"

Total delivered hashrate·hours added as a stat; renamed the "expected" earnings field to "unpaid earnings" to match
Ocean's terminology.

### `[Feature]` Default HTTP port 3000 → 3010

Daemon's default port changed from 3000 to 3010 to avoid conflicts with common local-dev tools.

### `[Fix]` Next-action prediction capped at `max_bid` and sensible when above target

Prediction no longer overflows `max_bid`, and no longer shows nonsensical "escalation" text when already above the
target price.

### `[Fix]` Post-CREATE stability + invalidate finance on config save

Fixed a flap where the controller would re-CREATE immediately after a CREATE; Finance panel now invalidates its cache
when config saves.

### `[Fix]` Stat card height mismatch caused by tooltip wrapper

Tooltip wrapper was adding 1px that broke alignment across cards.

### `[UI]` Instant hover tooltips replace browser native title

Replaced `title=` attributes with instant-show React tooltips so there's no 1.5s delay.

### `[UI]` Adaptive X-axis labels and polish

X-axis labels adapt to the time range; stat card units moved below the number; simulation unit uses the sat symbol.

### `[UI]` Reorganize stats above charts

Stats panels moved above the charts for primacy; individual stats use large values and consistent label typography.

### `[UI]` "Wait before lowering" label

`Lower patience` relabeled as `Wait before lowering` for clarity.

### `[Infra]` Remove `hibernate_on_expensive_market` config

Always skip silently when the market is expensive; the configurable toggle was redundant.

### `[Docs]` README caught up to current state

README updated to reflect the project's shipped state at 2026-04-17.

### `[Docs]` Future stats panel ideas

Appended a brainstorm section to the Datum API doc covering future panels.

## 2026-04-16

### `[Feature]` BTC/USD price oracle + global denomination toggle (addresses #12)

Added a BTC/USD oracle and a global sats ↔ USD toggle at the top of every dashboard page. Chart Y-axis, hero delta, and
top-bar balance all honor the toggle. Removed the action badge.

### `[Feature]` Ocean client rewritten from HTML scraping to JSON API

Replaced the fragile HTML-scraping Ocean client with one hitting Ocean's JSON API; also fixed Y-axis overlap on the
hashrate chart.

### `[Feature]` Hashprice (break-even) in P&L and on the price chart

Added break-even hashprice line to the price chart and a row in the P&L panel showing current break-even.

### `[Feature]` In-place bid resize via `EDIT_SPEED`

Controller can now resize a bid in place via a new `EDIT_SPEED` proposal (Design A). Marker added to the price chart and
to the legend; `bid_events.kind` CHECK constraint extended.

### `[Feature]` Full Money (P&L) panel replaces Collected-BTC card

Vertical Money panel with spend-scope toggle (autopilot vs whole account), run-rate footnotes for income/spend/net per
day, and hourly data freshness.

### `[Feature]` Hourly Money panel; split metadata TTLs

Settings TTL 1h, fee TTL 15m; Money panel refreshes hourly with live "updated N ago" ticking each second.

### `[Feature]` Avg-hashrate stat + 5-column layout

New avg-hashrate stat card; stats row restructured into a consistent 5-column layout.

### `[Feature]` Decisions list: 2000-row limit, full-width, 60s poll

Decisions view bumped to 2000 rows, full-width layout, 60-second polling.

### `[Feature]` Server-side stats with duration weighting

Moved stats aggregation to the server with proper duration-weighted averages instead of simple means.

### `[Feature]` Tuning stats bar between charts and cards

New tuning stats bar sits between the charts and the summary cards on Status.

### `[Feature]` Live dashboard + on-chain payout observer

Initial rollout of the live Braiins execution path, the dashboard, and the on-chain payout observer.

### `[Feature]` Pricing model overhaul; fillable telemetry; persist floor

Major pricing overhaul introducing a fillable-price telemetry track and a persisted floor. Chart split into separate
price/hashrate axes; countdown bar + price delta surfaced.

### `[Feature]` Predictive next-action

Next-action card predicts the actual escalation step; bypasses the override lock on Run-decision-now; poll cadence
slowed; breadcrumb "just executed" after a tick.

### `[Feature]` Live EDIT_SPEED test script

Added a live test script for the new `new_speed_limit_ph` PUT semantics.

### `[Fix]` `below_floor_since` timer reset on bid-state flicker (#10)

Brief bid-state flickers were resetting the patience timer; now the timer survives single-tick flicker.

### `[Fix]` Cap `spend/day` at `speed_limit_ph`

`spend/day` was using raw `avg_speed_ph` which could exceed the speed cap; now clamped.

### `[Fix]` `btc-price` query retries after pre-login 401

Initial request hit a 401 from the auth middleware before the token was loaded; now retries once after login.

### `[Fix]` Stats SQL CTE bound-param bug

Rewrote stats SQL to inline subqueries instead of a CTE, which was mishandling bound params in SQLite.

### `[Fix]` `StatsBar` shows placeholder cards instead of vanishing

Stats cards now render placeholders while loading rather than unmounting and causing layout shift.

### `[Fix]` `nice` Y-axis ticks; `sat` symbol in bids table

Y-axis ticks quantized to round numbers; inline sat symbol used in the bids table.

### `[Fix]` Lock horizontal scroll on mobile

Added `overflow-x-hidden` on body to prevent accidental horizontal scroll on mobile.

### `[Fix]` Kill "sat sat"

Dropped a double-suffix bug where the sat icon rendered alongside the literal "sat" text.

### `[UI]` Sat symbol via Font Awesome kit

Replaced the "sat" text with an inline sat symbol icon; switched to fa-regular weight; used in the hero card; dropped
the header `ModeBadge`; used satsymbol.com kit.

### `[UI]` Top nav + vertical Money panel + format picker in Config

Added a top nav; Money panel went vertical; parser fix around unit detection; format picker moved from Status to Config.

### `[UI]` Chart polish: viewport-aware tooltip + logical X-axis ticks

Tooltip stays inside the viewport; X-axis ticks fall on logical intervals.

### `[UI]` Dashboard cleanups

Decision reasons formatted in sat/PH/day with thousand separators; fillable surfaced on chart; EDIT_SPEED marker
anchored to the price line.

### `[UI]` Money panel polish

Match sibling card typography; color only the net; full-width layout with ETA timestamp on the next-payout footnote.

### `[UI]` Trim Status header; format-first labels

Trimmed Status page header; labels now lead with the format.

### `[UI]` Center Config page; rename Money → Profit & Loss

Config centered; "Money" panel renamed to "Profit & Loss" throughout.

### `[UI]` Mute unit suffixes globally

All info panels now display unit suffixes in a muted color to de-emphasize them.

### `[Perf]` Memoize expensive dashboard computations

Memoized derived values across dashboard components to avoid recomputation on each render.

### `[Infra]` Remove `emergency_max_bid` and `below_floor_emergency_cap`

Removed the emergency-cap machinery entirely; the fixed cap + new lower-patience window cover the cases it was for.
Scrub remaining "max overpay" references from live UI.

### `[Infra]` `TickingAge` tick cadence 1s (not 10s)

"Age" indicators now tick once per second so they feel live.

### `[Infra]` Rename `max_overpay` → `overpay`

Renamed the config field to reflect reality — it was never a `max`.

### `[Infra]` CLAUDE.md with issue-lifecycle convention

Initial project CLAUDE.md covering the never-close / apply-review label convention.

### `[Infra]` `/check-specs` and `/check-code` slash-commands

Added two project-local commands.

### `[Infra]` Scrub Telegram/2FA-gate machinery from docs

Removed legacy Telegram/2FA references from README/spec/architecture (owner-token API bypasses the gate empirically).

### `[Docs]` Document Datum API setup for Umbrel

Recorded the Datum/Umbrel wiring recipe (not yet applied at commit time).

## 2026-04-15

### `[Infra]` Monorepo scaffold

Added the monorepo scaffold, `README`, `LICENSE`, and gitignore hygiene.

## 2026-04-14

### `[Infra]` Initial spec, research, and permissions log

Initial commit: project spec, research document, and the permissions log used by `/optimize-autonomy`.