# Changelog

## 2026-04-21

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