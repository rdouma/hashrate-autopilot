# Changelog

## v1.0.1 — 2026-04-20

Point release for a significant autopilot-stalling bug (#33): a headless daemon would silently stop producing proposals once the hashprice cache aged past its 60-min freshness window, because only the dashboard refreshed it. Operators running without the dashboard open were losing uptime as bids drifted below fillable. Also includes a mobile-layout fix for the Bids table.

### `[UI]` Bids table: mobile-friendly bid ID cell (#34)

The full-width bid ID restored by #26 wrapped one character per line on mobile viewports because of `break-all` on an 18-character monofont string. On narrow viewports the id column now shows a shortened `B86611…5108` alongside a copy-to-clipboard icon; desktop keeps the full ID as before. Same `CopyIcon`/`CheckIcon` feedback pattern used on the Datum pool-URL row.

### `[Fix]` Keep the hashprice cache warm inside the daemon (#33)

The dynamic-cap guard refuses to trade when hashprice is unknown/stale — which was correct, but in steady state the only thing refreshing the cache was the dashboard's finance poll. A headless daemon running longer than the 60-min freshness window would silently stop producing proposals, the bid would drift below fillable, and hashrate uptime would collapse. Added a `HashpriceRefresher` service that polls Ocean every 10 min from the daemon itself, independent of any dashboard client. Also: the tick log now explicitly says `(no proposals — hashprice unknown/stale, dynamic-cap guard is holding trading)` when the guard fires, instead of the bland `(nothing to do)` that hid the problem.

## v1.0.0 — 2026-04-19

First stable release. Tagged so operators who don't want to track `main` daily have a pinned reference to run against.

**Highlights of what's in 1.0:**

- 24/7 price-taker autopilot for the Braiins Hashpower marketplace: creates / escalates / lowers bids against a per-tick target (fillable + overpay), capped by the tighter of a fixed maximum and a dynamic `hashprice + max_overpay` ceiling.
- Server-side-safe: honours Braiins' 10-min price-decrease cooldown and the Telegram-2FA-exempt owner-token path; respects run-mode gates (DRY_RUN / LIVE / PAUSED) and manual-override locks.
- Independent break-even reference via Ocean: dynamic cap gates on a fresh Ocean hashprice, refuses to trade when that reference is unavailable, and falls back to the fixed cap only when the operator hasn't configured the dynamic one.
- Full-history simulator that replays `tick_metrics` under candidate parameters and reports uptime / mutations / cost / overpay — now with the Braiins 10-min cooldown and the dynamic cap respected, so simulated stats match what the real controller can actually achieve.
- Dashboard with Status + Config pages, per-tick Next Action prediction, depth-aware price / hashrate charts, pinned event tooltips with full market context, and P&L per-day + lifetime panels.
- Datum Gateway + Ocean pool integration for end-to-end pipeline observation.

**Bug fixes since CHANGELOG introduction (issues #28–#32):**

- `[Fix]` Dynamic cap no longer silently collapses when the dashboard is closed (#28). Hashprice cache timestamps its writes, seeds from a boot-time Ocean fetch, and decide() refuses to trade when the cap is configured but hashprice is unknown or stale beyond 60 min.
- `[Fix]` Next Action countdown + progress bar agree from tick 1 and stop promising escalations that can't fire (#29). Above-floor shortfalls get a "no escalation scheduled" detail instead of a phantom 3-min countdown.
- `[Fix]` Pinned tooltip's overpay allowance reads from `config_summary` instead of a racy `configQuery`, so it's always truthful (#30).
- `[Fix]` P&L per-day rows stop disappearing on transient 0-spend or missing-income states; show `calculating…` when Ocean income hasn't landed yet (#31).
- `[Fix]` Simulator enforces the Braiins 10-min price-decrease cooldown; no more simulated lowerings 5–8 minutes apart that the real bot could never execute (#32).
- `[Polish]` Event tooltip units use the ≡ sat glyph and muted styling, matching the rest of the Status page.
- `[Polish]` Hashprice row moved from the Braiins card to the Ocean card, where it belongs — it's Ocean-derived, not Braiins-reported.
- `[Feature]` Tooltip now surfaces `max overpay vs hashprice` and `hashprice + max overpay` so operators can see which cap is binding at the event's tick.

---

## 2026-04-19

### `[Feature]` Max-premium-over-hashprice cap (#27)

New dynamic cap alongside the fixed `max_bid_sat_per_eh_day`: operator can set a maximum sat/PH/day premium over break-even hashprice, and the effective cap each tick is `min(max_bid, hashprice + max_overpay_vs_hashprice)`. Honored by the decider, the simulator, and the price chart (solid cap line, shaded excluded zone).

### `[Feature]` Run-decision-now bypasses all pacing (#25)

"Run decision now" now drops both the post-edit lock *and* the patience/settle window in one click, so the pending decision actually fires instead of requiring ~13 ticks to outlast the window. Also surfaces the resulting decision in a banner.

### `[Feature]` Bids table shows full bid IDs (#26)

Removed the `.slice(0, 10) + "…"` truncation; full Braiins order IDs are now displayed so they can be copied or cross-referenced.

### `[Feature]` Ocean-found blocks marked on the hashrate chart (#23)

Blocks credited to our worker are marked on the delivered-hashrate chart so it's obvious when we contributed to a found block.

### `[Feature]` Datum Gateway panel replaces legacy Pool card

Full Datum panel with stratum/stats reachability tags, pool URL split into protocol/host/port rows, workers connected, and Datum-reported hashrate. Daemon polls Datum stats each tick.

### `[Feature]` Datum hashrate plotted alongside Braiins

Hashrate chart now overlays Datum's reported hashrate on top of the Braiins delivered line for visual comparison.

### `[Feature]` Mutations stat card

New stat card counting bid mutations (create / edit price / edit speed / cancel) in the selected range, read from the `bid_events` log.

### `[Feature]` Lower-patience measures continuous market-cheap time

`lower_patience` window now tracks continuous time the market sat below the current bid price, not continuous time above floor. Better matches operator intent.

### `[Feature]` Simulator respects the dynamic cap

Simulator skips ticks where `fillable + overpay` exceeds the effective cap, plots the simulated cap instead of the historical one, and exposes "Max over hashprice" in the parameter bar.

### `[Feature]` P&L split into per-day and lifetime-total columns

Split into two panels; also moved next-payout date onto the Ocean panel, and retitled per-day numbers as projections.

### `[Feature]` Price tooltip surfaces max-overpay and dynamic cap

Pinned price-chart tooltip now includes market context plus max-overpay and dynamic-cap values, and clearly marks simulation-derived points.

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

Restored whole-account spend from `/spot/bid counters_committed.amount_consumed_sat`, split closed vs active bids in P&L, and repaired tooltips that broke in the split.

### `[Fix]` Auto-refetch status when countdown expires

Status polls kept counting down past zero without refetching when the daemon was mid-tick. Fixed — `RefreshCountdown` now keeps polling and the Datum badge says "API reachable" when live.

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

Removed the Total PH·h card from the default view; cleaned up the "delivered / cap" slash formatting on the Braiins panel.

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

CLAUDE.md: prefer `--body-file` for `gh issue create`, pick labels freely from `gh label list`, flip issues to `in-progress` on pickup.

### `[Infra]` Log raw `/spot/bid` response on first fetch

Logs the first `/spot/bid` response once per session so shape drift is easy to spot.

## 2026-04-18

### `[Feature]` Ocean panel with block data, pool stats, and user earnings

New Ocean panel on Status showing last block, blocks 24h/7d, unpaid earnings, and pool worker count. Merged the standalone "Braiins Balance" card into a single Braiins panel.

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

Added a backtesting simulator: runs past market data against edited parameters so the operator can see how changes would have performed. Integrated into the Status page as a real-time/simulation toggle. Polished with filter bar, events, spinners, parameter bar with escalation-mode selector, and visual distinction from live mode.

### `[Feature]` Opportunistic hashrate scaling (addresses #13)

When the market is cheap vs break-even hashprice, autopilot can scale the target hashrate up to a higher ceiling. Config UI added and polished.

### `[Feature]` Bitcoin node RPC credentials in dashboard config (addresses #14)

Moved Bitcoin node RPC host/user/pass out of env vars into the dashboard Config page.

### `[Feature]` Lower-patience window

Added a lower-patience window to prevent chasing short market dips — the autopilot will only lower the price after the market has sat cheap continuously for N minutes.

### `[Feature]` Hashprice + overpay-vs-hashprice as time series + stat

Hashprice and current `max_bid` are now logged as time series; an "overpay vs hashprice" stat card summarizes current premium.

### `[Feature]` Payout config: radio selector + conditional fields

Restructured payout config into a radio selector with conditional fields; auto-detect now runs once in a migration rather than every boot.

### `[Feature]` Total PH·h stat; renamed "expected" → "unpaid earnings"

Total delivered hashrate·hours added as a stat; renamed the "expected" earnings field to "unpaid earnings" to match Ocean's terminology.

### `[Feature]` Default HTTP port 3000 → 3010

Daemon's default port changed from 3000 to 3010 to avoid conflicts with common local-dev tools.

### `[Fix]` Next-action prediction capped at `max_bid` and sensible when above target

Prediction no longer overflows `max_bid`, and no longer shows nonsensical "escalation" text when already above the target price.

### `[Fix]` Post-CREATE stability + invalidate finance on config save

Fixed a flap where the controller would re-CREATE immediately after a CREATE; Finance panel now invalidates its cache when config saves.

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

Added a BTC/USD oracle and a global sats ↔ USD toggle at the top of every dashboard page. Chart Y-axis, hero delta, and top-bar balance all honor the toggle. Removed the action badge.

### `[Feature]` Ocean client rewritten from HTML scraping to JSON API

Replaced the fragile HTML-scraping Ocean client with one hitting Ocean's JSON API; also fixed Y-axis overlap on the hashrate chart.

### `[Feature]` Hashprice (break-even) in P&L and on the price chart

Added break-even hashprice line to the price chart and a row in the P&L panel showing current break-even.

### `[Feature]` In-place bid resize via `EDIT_SPEED`

Controller can now resize a bid in place via a new `EDIT_SPEED` proposal (Design A). Marker added to the price chart and to the legend; `bid_events.kind` CHECK constraint extended.

### `[Feature]` Full Money (P&L) panel replaces Collected-BTC card

Vertical Money panel with spend-scope toggle (autopilot vs whole account), run-rate footnotes for income/spend/net per day, and hourly data freshness.

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

Major pricing overhaul introducing a fillable-price telemetry track and a persisted floor. Chart split into separate price/hashrate axes; countdown bar + price delta surfaced.

### `[Feature]` Predictive next-action

Next-action card predicts the actual escalation step; bypasses the override lock on Run-decision-now; poll cadence slowed; breadcrumb "just executed" after a tick.

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

Replaced the "sat" text with an inline sat symbol icon; switched to fa-regular weight; used in the hero card; dropped the header `ModeBadge`; used satsymbol.com kit.

### `[UI]` Top nav + vertical Money panel + format picker in Config

Added a top nav; Money panel went vertical; parser fix around unit detection; format picker moved from Status to Config.

### `[UI]` Chart polish: viewport-aware tooltip + logical X-axis ticks

Tooltip stays inside the viewport; X-axis ticks fall on logical intervals.

### `[UI]` Dashboard cleanups

Decision reasons formatted in sat/PH/day with thousand separators; fillable surfaced on chart; EDIT_SPEED marker anchored to the price line.

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

Removed the emergency-cap machinery entirely; the fixed cap + new lower-patience window cover the cases it was for. Scrub remaining "max overpay" references from live UI.

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
