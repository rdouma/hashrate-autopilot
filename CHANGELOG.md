# Changelog

## 2026-05-30

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
