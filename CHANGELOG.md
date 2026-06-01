# Changelog

## 2026-06-01

### `[Fix]` BIP 110 UASF forecast uses 600s target rate, drop em dashes project-wide (#233 follow-up #3)

Two corrections to the BIP 110 tooltip plus a project-wide cleanup. **UASF forecast**: the previous draft used the observed average block time from the in-progress epoch to project the UASF activation date, which read three days later than the standard 600s-per-block calculation that every block-time calculator (and the operator's own hand math at 144 blocks/day) uses. Switched to `now + (target - tip) × 600s` so the displayed estimate matches what the operator can verify independently. **Em dashes**: swept the source tree for em dashes (—) and replaced with ASCII hyphens per the no-em-dashes rule. The three new BIP 110 tooltip strings carried em dashes; 21 more files had them in code comments and JSDoc. 76 occurrences removed across 24 files. Locale .po catalogs re-extracted, three new translations added for NL and ES.

### `[UI]` BIP 110 deployment tooltip explains both activation paths (#233 follow-up #2)

The SIGNALING-state tooltip now names both BIP 110 activation paths and shows the UASF flag-day block (965,664) with a dynamically forecasted date from the average block time observed in the in-progress epoch. The previous one-paragraph "Your Bitcoin node is in the BIP 110 signaling window..." was read as time-related and didn't mention the user-activated path at all. New copy: "Your Bitcoin node supports BIP 110, currently in its activation window. Miner-activated (MASF): 55% threshold in any epoch locks in early. User-activated (UASF): at block 965,664 (estimated {date}), BIP 110-aware nodes — Bitcoin Knots included — enforce the rules regardless." The forecasted UASF date drifts with network conditions (blocks have been coming faster than 600s on average — earlier September-2026 calendar reference was already off). LOCKED_IN and ACTIVE tooltips unchanged. en + nl + es translations updated for six new strings.

### `[UI]` BIP 110 scanner: mobile header layout + drop "Core" terminology (#233 follow-up)

Two refinements after the per-epoch breakdown shipped on mobile. **Header layout**: the `tip | scanned | signaling | deployment` row with vertical `|` dividers wrapped awkwardly at narrow widths; now stacks vertically below `lg:` and only renders the dividers on `lg+`. **Deployment-status tooltip**: rewrote in plain English with per-status guidance ("Your Bitcoin node is in the BIP 110 signaling window..."). Dropped the old "Core's BIP 9 deployment status for BIP 110..." text — the operator runs Bitcoin Knots, and the project convention is to say "your Bitcoin node" generically (Core was the only outlier in user-facing UI). en + nl + es translations updated for the four new status/explanation strings.

### `[UI]` BIP 110 scanner: mobile layout, auto-expand current epoch, per-row MASF bar, forecasted end date (#233)

Four refinements to the BIP 110 scanner card. **Mobile layout**: the per-epoch table swapped to a stacked card layout below the `lg:` breakpoint so the row content stops overflowing the viewport; same data, no horizontal scrolling. **Auto-expand on scan**: after a scan completes, the in-progress epoch row is auto-opened so the signaling blocks are visible without an extra chevron click. **MASF progress bar per row**: the deployment-level progress bar moved out of the card header and into each epoch row, anchored to the absolute 1109-block (`ceil(2016 × 55%)`) threshold; amber below threshold, emerald at or above. The header retains a smaller deployment status badge with a tooltip explaining the BIP 9 chain-level state. **Forecasted end date**: the in-progress epoch's right-side date now shows the linear-extrapolated retarget date (computed from the average block time observed so far in the epoch) instead of the last-scanned block's time. Marked with `(est.)`. Backend extends `Bip110EpochBucket` with `expected_end_time_ms: number | null`; null for completed epochs and for in-progress when fewer than 2 blocks have been scanned (falls back to the target 600s × 2016 from start). en + nl + es translations updated.

## 2026-05-31

### `[UI]` BIP 110 scanner range: two-option toggle (`Current epoch` / `All`) (#231 follow-up #3)

The five-option epoch-count dropdown collapses to a two-option segmented toggle: `Current epoch` (in-progress epoch only) or `All` (every epoch since the first known BIP 110 signaling block, height 938,903 on 2026-03-01). `All` is the explicit "show me the historical view" opt-in — a bounded ~13k-block scan that takes single-digit seconds on a healthy node. Backend takes `?range=current|all`; the old `?epochs=N` / `?blocks=N` params are dropped (no external callers). Dashboard radio buttons reuse the existing TH/PH/EH segmented-toggle styling. Obsolete dropdown labels removed from the i18n catalogs by extract --clean; the two new strings (`All`, `BIP 110 scan range`) translated for NL + ES.

### `[Fix]` Right-axis solo-mining lines truncated to 24h at All chart range (#232)

At the `All` chart range, the right-axis solo-power / solo-hashrate / device-count / max-temp / max-best-difficulty lines silently rendered only the trailing 24h of data — narrower presets worked fine. `Status.tsx`'s `Date.now() - (CHART_RANGE_SPECS[preset].windowMs ?? 24*60*60_000)` fell through to the 24h fallback when `windowMs` is null (the All sentinel), so the solo-series query asked for `since = now - 24h`. Fixed with explicit All handling (`since = 0`) plus a backend tweak to honor `since=0` as "everything" instead of the previous `> 0` guard that quietly degraded it to 24h. Custom panned viewports now also use `vp.since_ms` directly instead of anchoring to "now", so a panned past window returns the correct slice.

### `[UI]` BIP 110 scanner shows date range per epoch (#231 follow-up #2)

The per-epoch breakdown's Block-range column now carries a secondary date-range line ("May 18 – Jun 1, 2026") derived from the first and last scanned block timestamps in each epoch. Locale-aware (UI-language driven month names) and collapses to a single date when both endpoints fall on the same calendar day (in-progress epoch right after a retarget). Backend extends `Bip110EpochBucket` with `start_time_ms` / `end_time_ms` populated from the same block headers we already fetch for signaling detection — no extra RPC.

### `[UI]` BIP 110 scanner consolidates two tables into expandable epoch rows (#231 follow-up)

The per-epoch breakdown and the signaling-blocks list were two separate tables stacked on top of each other. Replaced with a single table where each epoch row is clickable: rows with ≥1 signaling block expand to show those blocks inline (desktop signaling-block table / mobile cards reused as-is). Rows with zero signaling blocks have no chevron and aren't clickable — visually unmuted to mark them as "nothing to see here". Default state is all-collapsed. en + nl + es translations updated for the two new tooltip strings.

### `[UI]` BIP 110 scanner ranges by difficulty epoch, not block count (#231)

The scanner's range dropdown used to offer arbitrary block counts (2016 / 4032 / 8064 / 16128 / 32256) and report a single sliding-window percentage that didn't correspond to anything activation-relevant — BIP 9 / MASF evaluates signaling per difficulty epoch, so a 2016-block window that straddles two epochs produces a number with no meaning for activation. Replaced with epoch-aligned options: `Current epoch`, `Current + last 1`, `Current + last 3`, `Current + last 6`, `Current + last 12`. Backend computes the range as `floor(tip / 2016) * 2016 - N * 2016` through `tip` and returns a new `epochs[]` array with one bucket per epoch (start/end height, scanned, signaling count, signaling pct, in_progress flag). UI renders a per-epoch breakdown table above the existing signaling-blocks list — green percentage when an epoch is at or above the 55% MASF threshold, slate when below; the current (in-progress) epoch is tagged so it's clear the percentage is partial. The legacy `?blocks=N` query param is honored best-effort by rounding up to whole epochs so older callers don't break. en + nl + es translations updated.

## 2026-05-30

### `[Fix]` Boot-time backfill of historical network difficulty from bitcoind (#230)

The chart's network-difficulty line started mid-history because pre-existing tick rows hold `NULL` for `network_difficulty` — that column was added by a later migration than the rows themselves. Network difficulty is fully reconstructible from any Bitcoin block header (every header carries the difficulty target), and bitcoind RPC is already wired for payout observation; new boot-time service walks the NULL range, fetches one block header per epoch boundary via two batched RPC calls, and writes the appropriate epoch's difficulty into every tick whose timestamp falls inside it. Idempotent, bounded (~26 boundary lookups per year of gap), silent skip when bitcoind isn't configured or reachable. Crucially, the SQL UPDATE has an `IS NULL` guard on every write so live observations from the daemon are never overwritten — this is gap-fill only, the per-tick observation remains the canonical source. Existing installs will see the difficulty line extend back through full history on next daemon restart.

### `[Fix]` Test-notification preview honors Display & Logging → Number format (#227 follow-up #2)

The "Send test notification" button on Config → Notifications still produced English-formatted previews (`#948,512`, `1,062,144 sat`, `0.01062144 BTC`) for operators with Display & Logging set to `1.234,56`. Root cause: `notifications-test-event.ts`'s `SAMPLE_BUILDERS` hardcoded those numeric strings as English literals, so the synthetic values never passed through the same `formatInteger`/`formatBtc`/`formatSat` helpers the live alert path uses. The live alerts were already correct — only the test preview was lying. Each builder now takes a `ResolvedDisplayLocale` argument and routes every synthetic number through the format helpers; route handler resolves it from `cfg.display_number_locale`. Added regression test pinning `pool_block_credited`, `payout_initiated`, `payout_confirmed`, `wallet_runway`, `braiins_deposit`, and `solo_share_rejection` previews against both en-US and nl-NL so future builders can't reintroduce literal numbers. Also added `display_number_locale`, `display_date_layout`, `notify_on_payout_initiated`, and `notify_on_payout_confirmed` to `debug-dump.ts`'s `SAFE_CONFIG_FIELDS` whitelist so `/api/debug/dump`'s `app_config` shows their values (previously surfaced as `null`).

### `[Fix]` Pool-blocks-this-epoch hidden when prior epoch isn't fully covered (#229 follow-up)

The "pool blocks this epoch" row would have shown an artificially low count for any adjustment whose prior epoch started before the operator's pool_blocks data did — a fresh install five minutes before a difficulty adjustment would have read "0 blocks this epoch", misleading the operator into thinking Ocean had a horrible run when really we just didn't have the data yet. `countPriorEpochPoolBlocks` now requires at least one observed pool block at-or-before the prior-epoch's start height (proves we were already recording / backfilled to before the epoch began) and returns null otherwise. The tooltip's existing null-hide behaviour drops the row entirely on those events instead of lying with a low count.

### `[UI]` Enriched difficulty adjustment tooltip (#229)

The retarget tooltip on the Hashrate + Price charts now reads as a proper "difficulty adjustment" summary instead of a thin difficulty-only diff. Title renamed from "DIFFICULTY RETARGET" to "DIFFICULTY ADJUSTMENT" (the common bitcoiner term, per operator preference). New fields below the existing change row: **block height** of the retarget (derived from `pool_blocks` — any Ocean block in the new epoch snaps via `floor(height / 2016) × 2016`); **avg block time** over the prior epoch (computed exactly from the difficulty delta via Bitcoin's own retarget formula `600s × (old / new)`, format `9m 52s`); **network hashrate** at the new difficulty (`difficulty × 2³² / 600`, rendered in EH/s); **pool blocks this epoch** (count of Ocean blocks in the prior epoch's height range — operator-relevant context). All four fields are dashboard-side derivations, no daemon changes. Block height and pool-block count hidden when `pool_blocks` doesn't have a nearby block to anchor against. en + nl + es translations.

### `[Infra]` Renamed legacy `braiins.*` localStorage keys to `hashrate-autopilot.*` (#228)

The project was originally Braiins-only and the dashboard's browser-persistence keys inherited the brand prefix. After the project's market-agnostic repositioning, that prefix became misleading — DevTools and any browser-side tooling surfaced "braiins.*" for things that have nothing to do with the Braiins marketplace (dashboard password, UI language, number format, denomination toggle, chart right-axis selection, alert ack filter, etc.). Renamed all 14 keys to `hashrate-autopilot.*` across 11 source files. New `migrateLegacyStorageKeys()` helper runs once at app bootstrap (called from `main.tsx` before `createRoot().render`); copies any legacy `braiins.*` value into its new key and deletes the old. Existing operators keep every preference automatically — no re-login, no re-pick. Idempotent. Also renamed the root `package.json` `name` from `braiins-hashrate-control` to `hashrate-autopilot` and broadened the description to reflect the marketplace-agnostic positioning. Confirmed via deep audit that all remaining "braiins" references in the codebase (BraiinsClient, BraiinsService, `braiins_*` DB columns, `BHA_BRAIINS_*` env vars, UI strings naming Braiins as the marketplace, etc.) are legitimate references to the Braiins marketplace and stay as-is. Structural items deliberately untouched: repo slug, on-disk directory name, GHCR image path — renaming those would break CI/CD and operator setups.

### `[Fix]` Telegram now reads Display & Logging's number format (not notification_locale) (#227 follow-up)

The first cut threaded `notification_locale` (which is the message *language*) into the formatting helpers, but the operator's actual number-format preference lives in the **Display & Logging tab** under `braiins.numberLocale` localStorage. Those localStorage keys were browser-only and the daemon couldn't see them — so an operator with Display & Logging set to NL (`1.234,56`) still got comma-thousand US numbers in Telegram. Promoted both `numberLocale` and `dateLayout` to daemon-managed config (`display_number_locale`, `display_date_layout`) via migration 0102. The dashboard's `useLocaleState` now fetches daemon config on first mount, adopts a non-`system` value from the daemon, or one-shot-migrates the localStorage value up to the daemon when the daemon is still at default. Every setter PATCHes the daemon config so subsequent changes flow through. The Telegram render path reads `display_number_locale` (not `notification_locale`) via a new `resolveDisplayLocale()` helper that handles `'system'` (→ en-US fallback) and `'no-grouping'` (→ en-US with thousand separators disabled). Existing operators with localStorage already set keep their preference automatically.

### `[Fix]` Telegram messages now use the operator's notification_locale for number formatting (#227)

Every Telegram alert body used to hard-code `toLocaleString('en-US')` and bare `.toFixed(N)`, so a Dutch or Spanish operator running with `notification_locale: 'nl' | 'es'` received numbers with English thousand-and-decimal separators regardless of preference. Centralised the formatting in a new `packages/daemon/src/i18n/format-numbers.ts` module with locale-aware `formatInteger` / `formatBtc` / `formatSat` / `formatSatAmount` / `formatFixed` / `formatPct` helpers backed by `Intl.NumberFormat`, threaded through every alert body (~25 sites across `alert-evaluator.ts` and `braiins-deposit-watcher.ts`). The two duplicate `formatSatAsBtc` helpers (one in each file) collapsed into a single central `formatSatAmount`. EN output unchanged (comma thousands, period decimal); NL and ES now correctly render period thousands and comma decimal. 18-test isolated coverage of the helpers; existing alert-evaluator tests still pass.

### `[UI]` Payout-lifecycle Telegram message wording (#226 follow-up)

Operator review of #226's first cut: the `payout_initiated` body claimed the payout was "now committed to the coinbase of the next block Ocean finds." Empirically operators see payouts confirm in non-Ocean blocks too, so the language overcommits. Reworded to "A payout has been initiated. On-chain confirmation follows; you'll get a second message when the transaction lands." — sticks to what we can actually prove from the data (the balance dropped). The `payout_confirmed` body also dropped its "Coinbase payout of …" prefix in favour of plain "Payout of …" for the same reason, and the truncated tx id was removed entirely for operator privacy (the chart already deep-links each payout to a block explorer; broadcasting tx ids through Telegram chat history is more exposure than the event warrants). en + nl + es bodies updated symmetrically.

### `[Feature]` Telegram alerts for the Ocean payout lifecycle (#226)

Two new opt-in INFO Telegram alert classes, each gated by its own config toggle (Config → Notifications → Ocean events). Both default off, matching the existing `notify_on_pool_block_credit` (#117) and `notify_on_braiins_deposit` (#130) conventions. **`payout_initiated`** fires the tick the daemon observes Ocean debiting your unpaid balance: detected as a sharp one-tick drop in `ocean_unpaid_sat` (>30% of the prior value) with the residual below the 1,048,576-sat payout threshold. At that moment Ocean has committed the payout to the coinbase of the next block it finds; the transaction hasn't confirmed on-chain yet. Body includes pre-drop and residual balances plus the inferred payout amount. **`payout_confirmed`** fires when the on-chain payout scanner observes a coinbase output crediting your payout address — one INFO per new row in the `reward_events` ledger, with block height + payout amount + truncated tx id. Idempotency via an in-memory `lastNotifiedRewardEventId` watermark (silent-baseline on first tick after boot so a fresh-install backfill of historical rows doesn't fire a flood). Migration 0101 adds the two columns. en + nl + es alert copy.

## 2026-05-29

### `[Release]` v1.10.0

Fee protection + configurable EDIT_PRICE deadband + deadband visible in the EDIT_PRICE event tooltip; chart-marker cap now counts visible events (fixes "EDIT_PRICE markers vanish at the 12h/24h view"); pool-block dots on the unpaid line now correctly track distinct Ocean refresh steps; pool-luck tooltip wording correction. New migrations 0099 + 0100.

### `[Fix]` chart_max_markers cap now counts visible events, not the buffered fetch window (#225)

The dashboard pre-fetches 3× the visible range (1× visible + 1× buffer on each side) for pan/zoom snappiness, but the chart-marker cap was counting the full fetched set. On an actively-editing controller (~18 events/hour observed today), a 12h view fetched ~36h ≈ 650 events; the cap at 500 fired and the EDIT_PRICE drop step nuked every yellow marker, even though only ~220 were in the visible 12h. Shrinking to 6h made markers reappear because the fetch dropped to ~325 events. Now the cap counts events filtered to `vp.since_ms..vp.until_ms` (the settled viewport); the global step-down drops still apply to the arrays passed to PriceChart, so the buffered out-of-view events stay loaded for pan/zoom but don't inflate the cap decision. `markersHiddenCount` is also now the count visible would have been hidden, not the count in the buffered superset.

### `[UI]` Show bid_edit_deadband_pct in EDIT_PRICE tooltip (#224)

The EDIT_PRICE event tooltip's MARKET AT THIS TICK section now shows the deadband that was in effect at the moment of the edit, as a percentage and the equivalent sat/PH/day floor (e.g. `20 % (≈ 200 sat/PH/day)`). Captured per-tick into `tick_metrics.bid_edit_deadband_pct` via migration 0100 so historical events render the right value even after the operator changes the knob. The `DEFAULT 20` on the column backfills every existing row to 20 (the legacy hard-coded `overpay / 5` value), so tooltips on pre-#222 events show the historically correct deadband. Also fixes a missed Dutch translation of "Braiins fee above your threshold" from #222.

### `[Feature]` Configurable fee threshold + edit deadband (#222)

Two new operator-configurable knobs on Config → Strategy under a new "Fee protection" section. **Max acceptable fee** (`max_acceptable_fee_pct`, default 0): when any active owned bid carries a `fee_rate_pct` above this percentage, the mutation gate blocks new `CREATE_BID` / `EDIT_PRICE` / `EDIT_SPEED`. `CANCEL_BID` remains allowed so you (or the Datum-down auto-cancel) can still bail out of a fee-bearing bid. Default 0 = halt the moment Braiins exits beta and charges any fee, matching the existing `beta_exit` Telegram alert. The halt clears automatically once every active bid drops back at-or-below the threshold; the threshold itself is the operator's acknowledgement, no clear button. **Edit-price deadband** (`bid_edit_deadband_pct`, default 20): replaces the hard-coded `editDeadband = max(tick_size, overpay / 5)` in `decide.ts` with `max(tick_size, overpay × pct / 100)`. Default 20 preserves the legacy behaviour (1/5 = 20%). Raise to 50 to halve edit frequency and tolerate ~2x more price jitter before re-pricing - useful as a chart-noise reducer today and as per-edit-fee mitigation if Braiins ever introduces an EDIT fee. tick_size remains the hard floor regardless. Migration 0099 adds both columns with their defaults. The Status panel's proposals strip shows "Braiins fee above your threshold" when the gate fires the new reason code `FEE_THRESHOLD_EXCEEDED`. Supersedes the cancelled #200 (absolute knob).

### `[Fix]` Pool-luck step tooltip wording (#223)

The pool-luck step tooltip on the Hashrate chart was labelling the luck value as the "numerator" - e.g. "Block aged out of the rolling-24h window - numerator went from 1.14× to 0.91×." The numerator of the luck formula is actually the block count over the rolling window (an integer, N → N±1); the 1.14× / 0.91× values shown are the pool luck multiplier before and after the step. Reworded to "pool luck went from X× to Y×" on both step-up (block landed) and step-down (block aged out) variants. en / nl / es catalogs updated.

### `[Infra]` Reverted: profit per bucket overlay on the Price chart (#220)

The signed-bar profit overlay shipped on 2026-05-27 read as visually busy on the Price chart and didn't communicate net profit clearly when overlaid on top of the existing bid / fillable / hashprice / max-bid lines and the cube / pickaxe / fuel / gem markers above. Cancelled per operator review. The same chart slot is still available for a future profit visualisation; a line series (matching the existing right-axis pattern) is a more promising shape than bars if the idea is revisited.

### `[Fix]` Pool-block dots on the unpaid line now correctly match distinct Ocean refresh steps (#221)

When two pool blocks were found close together (within ~10 minutes), the per-block dot-projection loop on the Price chart's unpaid line restarted its baseline read from `cursor - 1` for every block. Block 2's scan would re-find the same first step block 1 had already claimed - so both dots projected to the same `(cx, cy)` even when the unpaid line had two distinct step-ups (e.g. `970k → 1.00M` for block 1, then `1.00M → 1.04M` for block 2). On the chart this looked like a single dot at the wrong (intermediate) height, and the second block's tooltip was unreachable. Now: the scan tracks a `scanFromIdx` that advances past each block's claimed step, so block N+1's baseline starts from the post-step plateau of block N. Distinct steps each get their own dot at the correct post-step Y. The genuine Ocean-batched case (block N+1's forward scan finds no further step) still inherits block N's anchor, with an 8-pixel horizontal stagger so multiple dots at one step remain individually hoverable.

## 2026-05-26

### `[Release]` v1.9.0

On-chain payout gems, Braiins deposit fuel markers with balance step-up connectors, BIP 110 activation progress bar with MASF/UASF tooltip, Braiins balance right-axis series, pool-probe error exposure, rich BIP 110 scan cards, and chart viewport/axis fixes. New migrations 0095-0098.

### `[UI]` Deposit markers and connectors in purple (#211)

Deposit fuel icons changed from amber to purple to match the Braiins balance line. When the right axis shows Braiins balance, a purple dot appears on the balance line at the step-up caused by each deposit, with a dotted connector line back to the fuel icon. Hovering either the dot or the connector opens the deposit tooltip.

### `[UI]` BIP 110 activation progress bar

The BIP 110 scan card now includes an inline progress bar showing the current signaling ratio against the 95% activation threshold. A tooltip explains the two-phase activation path: the current MASF (miner-activated soft fork) phase where miners signal readiness via version bits, and the UASF (user-activated soft fork) enforcement that activates unconditionally at block height 965,664 (~September 2026).

### `[UI]` Pool luck step-down tooltip shows from/to values

When a pool block ages out of the trailing luck window, the step-down tooltip now shows the previous and new luck values (e.g. "went from 1.42x to 1.18x"), matching the step-up format used when new blocks arrive.

## 2026-05-25

### `[Feature]` Pool-probe error in dashboard tooltip and daemon log (#212)

When the stratum probe fails, the dashboard now shows the actual error (e.g. "timeout after 2500ms", "connect ECONNREFUSED") as a tooltip on the "stratum DOWN" badge. When the probe succeeds, the tooltip shows latency in ms. Probe failures are also logged to the daemon console at warn level for post-mortem analysis.
