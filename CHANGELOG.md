# Changelog

## 2026-05-02

### `[Feature]` Audible notification when a block is found (#88)

The dashboard now plays a configurable sound when a new pool block paying our payout address is detected. Off by default; existing installs aren't surprised by audio after upgrade. Operator picks one of four bundled cues (`cartoon-cowbell`, `glass-drop-and-roll`, `metallic-clank-1`, `metallic-clank-2`) or uploads a custom MP3/OGG/WAV/WebM (≤200 KB) via the Config page. A "Test sound" button auditions the current selection without saving. Detection runs off the `reward_events` table, which is now populated by the bitcoind payout-observer on each `scantxoutset` pass: any newly-seen coinbase UTXO at the payout address gets a row inserted (de-duped by `txid:vout`). The dashboard polls `/api/reward-events` every 60s, tracks the max id seen in localStorage, and rings once when a new id appears. The first poll after a fresh page load establishes a silent baseline so the operator doesn't get a barrage for the existing backlog. Migration 0052 adds `block_found_sound` + a custom-blob/mime pair on the config table; the blob is write-only via a dedicated `POST /api/config/block-found-sound` endpoint (base64 JSON, header-sniffed for audio magic bytes) and read-back via `GET /api/config/block-found-sound` for `<audio src=…>`. NL + ES translations added for the 14 new operator-facing strings.

### `[Fix]` BTC + TH/PH/EH toggles - third sweep (#87)

Two more spots were ignoring the toggles: the hero PRICE big number stayed in raw sat/PH/day regardless of the toggle (the muted subtitle below it switched correctly, so the visible 4xl number contradicted the unit shown immediately under it), and the green `JustExecutedBanner` line above NEXT ACTION ("Just lowered bid: 48,924 → 48,461 sat/PH/day") was rendering raw daemon text. Hero PRICE now routes through `formatSatPerPhDay` and strips the trailing unit. JustExecutedBanner runs through `relabelSummary`. The relabeller was also broadened to handle (a) `sat/EH/day` rates (Braiins's native unit; some daemon paths emit it), (b) hashrate arrow pairs (`4 → 5 PH/s`), and (c) consistent canonicalisation regardless of which unit the daemon used. No translations needed - all changes are formatter routing.

### `[UI]` BTC + TH/PH/EH toggles - second sweep (#87)

Hero PRICE card subtitle now follows the rate suffix instead of hardcoding "/PH/day". NEXT ACTION sentences ("Bid filling at X PH/s.", "Will edit bid to Y sat/PH/day on the next tick.", "Will lower to..." etc.) now route through the formatters and respect the toggle. AVG COST stat-card label dropped the hardcoded "PH" - was contradictory ("AVG COST / PH DELIVERED" with a "sat/EH/day" sub-label below in EH mode); now reads "AVG COST / HASHRATE DELIVERED" and the unit follows the toggle. Last-tick proposal lines ("EDIT B... 48,189 -> 48,444 sat/PH/day") are post-processed client-side via a regex relabeller until the daemon emits structured fields - the operator now sees these in the selected unit too. NL + ES translations added for the renamed strings.

### `[UI]` BTC currency option + TH/PH/EH hashrate-unit toggle (#87)

The header had a two-way `sats | USD` denomination toggle. To make cross-marketplace comparisons easier (NiceHash quotes BTC/TH/day, Braiins sat/PH/day), the dashboard now has two independent three-way header toggles: `sats | BTC | USD` for currency and `TH | PH | EH` for hashrate unit. Both choices persist per-browser to localStorage and affect every value rendered on the dashboard immediately - hero PRICE / DELIVERED card, stats bar (UPTIME / AVG cards), service panels, hashrate + price chart Y-axis labels and tick numbers, active bids table. Internal storage stays sat / PH/s (canonical schema units); the toggles are presentation-only. USD slot hides itself when no BTC-price oracle is configured (existing behaviour); BTC stays available regardless because the conversion is a static 100,000,000 multiplier independent of the oracle. NL + ES translations updated.

### `[Fix]` UPTIME ignores zero-delivery time (#86)

The UPTIME stat-card read 87.5% on a 3h window where ~70 of 180 minutes (≈ 39%) had zero delivered hashrate - reality was ~61%. Both the numerator and denominator of the SQL filtered on `delivered_ph > 0.05`, so zero-delivery ticks were dropped from BOTH sides instead of counting as downtime in the denominator. The metric was effectively reading "% of the time when there was already meaningful delivery, the counter was incrementing close to expected" - a tautology that contradicted the tooltip ("Duration-weighted % of time with delivered hashrate > 0"). Denominator is now total clock time over the window (every tick with reasonable `dur`); numerator counts ticks where the COUNTER-derived hashrate (`delta * 86_400_000_000 / (our_bid * dur)`) is >= 0.05 PH/s. Counter-derived rather than `delivered_ph` so the #52 freeze (where Braiins's lagged field stays elevated after delivery dies) still reads as downtime. Same window now reads 61.11%, matching the chart's red boxes. Operator restart required.

## 2026-05-01

### `[Feature]` Storage-estimate hints in Log retention panel (#85)

The three retention knobs (tick metrics / decisions uneventful / decisions eventful) used to be qualitative ("compact numeric series", "main bloat lever") with no quantitative anchor for how much disk a given setting actually translates to. Each knob now shows a daily-growth + at-current-setting cap underneath the input ("~ 230 KB/day · ~ 80 MB at 365 days"), and the section header surfaces the combined cap across all three plus the current size of the SQLite file. Numbers come from a new `/api/storage-estimate` endpoint that samples rows-per-day and bytes-per-row from the last 7 days of recorded data, so they reflect this autopilot's actual behaviour rather than a hardcoded guess. Knobs at 0 ("keep forever") show the daily growth without a finite cap. Indexes and SQLite page padding are excluded from the projection - it's a planning aid, not a guarantee. NL + ES translations updated.

### `[Release]` v1.4.8

Ships the #84 UPTIME fix.

### `[Fix]` UPTIME under-reads after lowering target hashrate (#84)

The UPTIME stat-card was calibrated to an absolute counter-rate threshold (`delta > 1 sat/sec`) that only made sense at higher target hashrates. After the operator lowered target from 3 PH/s to 1 PH/s, expected per-tick accrual dropped from ~100 sat to ~33 sat - well under the 60-sat absolute floor for a 60s tick - and legitimate delivery started getting marked as downtime (76.7% on a window where actual uptime was ~100%). The threshold is now relative: a tick counts as uptime when `delta >= 50% of expected_sat`, where `expected_sat = our_bid * delivered_ph * dur / 86_400_000_000`. Normal ops sit near 100% (Braiins computes delta and delivered_ph consistently); the original 2026-04-23 freeze incident still registers as downtime (~3%, well below the 50% line). Operator restart required.

### `[Release]` v1.4.7

Ships the #83 copy-correctness pass. The Cheap-threshold help text on Config no longer claims CLOB pricing; it now correctly reflects pay-your-bid (you pay your bid price, not a matched ask). NL + ES translations updated. Six internal comments / JSDoc blocks that still framed current behaviour as CLOB were scrubbed at the same time. No behavioural changes - pure operator-facing copy correctness.

## 2026-04-29

### `[Fix]` Stale CLOB references contradict pay-your-bid (#83)

The dashboard's Cheap-threshold help text claimed *"Under CLOB you pay the matched ask, so this is the price we can actually reach"* — operator-facing copy that directly contradicts the pay-your-bid model verified in #53 (and which every other piece of pricing copy on the dashboard already reflects). Audited every CLOB mention in the codebase: 1 operator-facing string in Config.tsx and 6 internal comments / JSDoc blocks (4 in PriceChart.tsx, 1 in routes/status.ts, 1 in routes/stats.ts) that framed the current behaviour as CLOB. All seven rewritten to reflect the verified pay-your-bid reality (bid IS the per-EH-day price; the consumed counter is the source of truth for settlement, not because "bid is just a ceiling" but because it's the authoritative number from Braiins independent of our model). Historical references in migrations, version-history changelogs, research.md §1.8, and architecture.md were left intact — those correctly describe the v2.0 → v2.1 transition. NL + ES translations updated for the operator-facing string. No behavioural changes; pure copy / comment correctness pass.

## 2026-04-28

### `[Release]` v1.4.6

Bundles today's chart-fidelity fixes (#82, #81, #79), the retention-defaults bump (#80), and the sats/USD toggle default (#77) into one release. Long-range charts now stay readable on fresh installs (no more 1m / 1y collapsing to a handful of points), the effective-rate line renders on every preset, pool-block tooltips use the historical share_log when we have it, and tick-metrics retention defaults to 365 days for installs that haven't been touched.

### `[Fix]` Charts no longer flatten when actual data span is shorter than the preset window (#82)

Picking 1m or 1y on a database with only a few days of recorded ticks (fresh install, recent retention prune) was over-collapsing the chart: 1y on 6 days of data rendered as ~6 daily points; 1m as ~144 hourly points. Each preset's bucket was sized for a *full* preset window, not the available span. The bucket-resize logic that already existed for the `all` preset now applies to every bounded preset using `pickBucketForSpan(min(windowMs, actualSpan))`. `pickBucketForSpan` boundaries also re-tuned to match the preset bucket scale exactly: ≤24h → raw, ≤30d → 30 min, ≤365d → 1h, else 1d (the old "≤7d → raw" boundary contradicted the 1w preset's explicit 30-min bucket). Long-history installs see no change at full-window ranges because `actualSpan` saturates the window; short-history installs now get readable charts across all presets.

### `[Fix]` Effective-rate line now renders on long Price chart ranges (#81)

The "Show effective rate on price chart" toggle worked on 3h / 6h / 12h / 24h but the emerald line (and its legend entry) silently disappeared on 1w / 1m / 1y / all. Root cause: PriceChart computed effective rate from per-tick `primary_bid_consumed_sat` deltas with a fixed 5-minute `MAX_EFFECTIVE_DT_MS` cap on per-pair gaps. The longer ranges pre-aggregate at the API into 30-min / 1-h / 1-day buckets, so every pair exceeded the cap and the inner accumulation loop bailed before emitting anything. The cap, the aggregation window, the minimum-span gate, and the minimum-nonzero-pair gate now all scale with the median dt of the points stream, so bucketed data flows through naturally while raw-tick guards (real daemon-restart gaps in 1-min data) still trip on the short ranges.

### `[UI]` Log retention defaults bumped, panel reflowed (#80)

`tick_metrics_retention_days` 7 → 365 and `decisions_eventful_retention_days` 90 → 365: tick_metrics is a compact numeric series that backs every chart, and eventful decisions are rare (~10% of ticks) and high-value forensic records — both are cheap to keep long. `decisions_uneventful_retention_days` stays at 7 because uneventful rows carry the heavy JSON state snapshots that drive disk bloat. Existing installs on the old defaults get lifted by migration 0051; deliberately-set values are left alone. Config panel layout reworked: tick_metrics gets its own row, the two `decisions_*` knobs sit side-by-side on a second row with a shared `Decisions log —` label prefix, and the help text now explicitly clarifies that the per-tick measurements (price, hashrate, share log) live in tick_metrics regardless of how aggressively the decisions log is pruned — fixing a real "am I losing my pricing history?" confusion.

### `[Fix]` Block tooltip uses historical share_log for blocks within tick history (#79)

The pool-block tooltip on the Hashrate chart was applying the *live* share_log_pct to every block plus an unconditional "approximation for older blocks, since share_log drifts as pool hashrate moves" caveat - even for blocks mined 10 minutes ago, where we already had the actual share_log recorded by the closest tick. New behavior: the Ocean route joins each pool block to the nearest tick_metrics row within ±5 minutes and surfaces that historical share_log on the block. The chart tooltip prefers the per-block value (no caveat) and only falls back to the live share_log + drift caveat when no tick within tolerance has a value (i.e. the block predates our tick-level history). The Ocean panel's "last pool block / our earnings (est.)" row uses the same preference. No new collected data - just a join + UI change against the existing migration 0048 column.

## 2026-04-27

### `[Fix]` Sats/USD toggle now visible on fresh installs (#77)

The denomination toggle was hidden by default because `btc_price_source` defaulted to `'none'`, which makes `btcPrice` resolve to null and the dashboard suppresses the toggle. Default flipped to `'coingecko'` (free public API, no auth, no Bitcoin RPC dependency, one HTTPS call every 5 min). Existing installs running on the old default get a one-shot SQL migration that bumps `'none'` → `'coingecko'`; operators who deliberately picked any other value (including `'none'`) keep their choice. Not released as a standalone version - rides along with the next feature.

### `[Release]` v1.4.5

Bundles today's Price-chart fixes (#76, #75) with the v1.4.4 footer fix
that was reverted after a publish failure. Skips v1.4.4 because that
tag's image is broken on GHCR and may have hit a few users; v1.4.5 is
the canonical successor to v1.4.3.

### `[Fix]` 1w Price chart: data series rendered as vertical sticks (#76)

Removing the EDIT_PRICE markers at 1w (#75) exposed an underlying bucketing problem: the 1w preset was bucketing at 5 minutes, producing 2,016 points across ~784px of usable chart width (2.6 points per pixel). Adjacent points squashed into single columns, and the line series zigzagged within each column - rendering as a forest of vertical sticks once the dense markers no longer hid them. Bucket bumped to 30 minutes (336 points, ~0.43 per pixel) so lines render continuously. PriceChart's `MAX_BRIDGE_MS` is now adaptive (3× the median data spacing, floor 5 min) so a single missing bucket doesn't break the line at long ranges while real multi-bucket outages still show as visible breaks.

### `[Fix]` Footer reads `vunknown` on Docker/Umbrel installs

The version-in-footer feature shipped in v1.4.3 worked on bare-metal builds (vite read umbrel-app.yml off disk during the build) but rendered `vunknown` on Docker-built images, because `.dockerignore` deliberately excludes `rdouma-hashrate-autopilot/` from the build context. Fixed by threading `APP_VERSION` as a Docker build-arg (same pattern as the existing `GIT_SHA` arg): the publish workflow parses `version:` out of `umbrel-app.yml` and passes it through, the Dockerfile re-declares it in the builder stage, and `vite.config.ts` prefers the env var, falling back to the file read for bare-metal builds. Both paths share one canonical source of truth.

### `[UI]` Price chart: hide EDIT_PRICE markers from 1w on (#75)

The 1w view of the Price chart was unreadable - hundreds of yellow EDIT_PRICE dots clustered into a band that hid the bid / fillable / hashprice lines underneath. The `showEvents: boolean` per-range flag is replaced with a finer-grained `showEventKinds: readonly BidEventKind[]` allowlist: 3h-24h shows all four kinds; 1w drops EDIT_PRICE but keeps the rare CREATE_BID / EDIT_SPEED / CANCEL_BID; 1m / 1y / all show no markers (unchanged). The legend chip now only renders kinds that are actually shown at the current range.

### `[UI]` App version in dashboard footer (#74)

Footer now leads with the app version (e.g. `v1.4.3 · build 158 · abc1234 · changelog`) so users reporting issues from Umbrel / Docker installs can cite the release without having to read the build number off the manifest. Sourced from `rdouma-hashrate-autopilot/umbrel-app.yml` `version:` at vite-build time, so it cannot drift from what the Umbrel community store publishes - they read the same canonical file.

### `[Fix]` AVG COST stats no longer undercount due to lagged delivered_ph (#73)

The `AVG COST / PH DELIVERED` and `AVG COST VS HASHPRICE` cards were reading ~3-5% lower than the actual bid during periods of patchy delivery. Numerator was correct (Δconsumed_sat = exactly what Braiins charged under pay-your-bid). Denominator used Braiins's reported `avg_speed_ph` - a 5-minute lagged rolling average that stays elevated for minutes after delivery actually drops to zero. Result: delivery dips contributed 0 to numerator but >0 to denominator, dragging the ratio below the bid and confusing operators ("Braiins is pay-your-bid - how can my realised cost be lower than what I bid?"). Fix switches both formulas to counter-derived hashrate (the same `Δsat ÷ bid ÷ Δt` signal driving the chart's amber line). The math simplifies to `SUM(Δsat) ÷ SUM(Δsat ÷ bid)` - the delta-weighted harmonic mean of the bid - which equals the bid exactly when the bid is constant across the window, and the spend-weighted average when the bid varies. Tooltips on both cards rewritten to be honest about what's actually computed.

### `[Infra]` CI gate prevents broken Umbrel image pins from reaching users

Post-mortem follow-on to today's v1.4.1 hang. Adds `.github/workflows/umbrel-image-pin-check.yml` and a CLAUDE.md "Umbrel image pin convention" section. The workflow runs on every push to `main` and PR touching `rdouma-hashrate-autopilot/**`, and asserts four invariants: (1) `umbrel-app.yml` `version:` == `docker-compose.yml` image tag; (2) the image tag is bare-semver, not `v`-prefixed; (3) the image tag is not `:latest`; (4) the tag actually resolves on GHCR (anonymous-pull manifest probe). Any failure turns the merge red. Catches the f396098-class mistake before users hit it.

### `[Fix]` Umbrel install hangs forever on v1.4.1

`rdouma-hashrate-autopilot/docker-compose.yml` pinned the image to `ghcr.io/rdouma/hashrate-autopilot:v1.4.1`, but the publish workflow's `docker/metadata-action` strips the `v` prefix from semver tags by convention - the actual published GHCR tags are `1.4.1` / `1.4` / `1` / `latest`, never `v1.4.1`. Every Umbrel install or update of v1.4.1 was pulling a 404'ing image and hanging in "updating". The pin now matches the bare-semver tag, and the publish workflow also produces `v`-prefixed mirrors so a future copy/paste of `:vX.Y.Z` can't 404 either. App content is unchanged from v1.4.1 - this release is purely the install fix; the v1.4.1 NEXT ACTION deadband fix ships in this image too.

## 2026-04-26

### `[Fix]` NEXT ACTION panel: mirror the deadband decide() actually applies (#71)

The status route's `describeNextAction()` predicted "Will edit bid" any time `|current - target| >= tickSize` (1 sat/PH/day), but `decide()` only fires the EDIT_PRICE when delta is above `max(tickSize, overpay/5)` (~60 sat/PH/day at the default overpay=300). So any delta in the 1 to 60 sat/PH/day band produced a confident prediction that never fired - operator saw "Bewerkt bod naar X" stick on the panel for many ticks while nothing actually happened. The prediction now uses the same deadband as `decide()`, so the panel and the controller agree. Operator restart required for the new logic to take effect.

### `[UI]` Wizard polish + drop "Braiins" prefix from app branding

The setup wizard now opens with a language picker at the top of the card so a fresh install lets the operator switch language before reading anything else, and shows `build N - <sha>` underneath the card for debugging across versions.

App headers no longer prefix "Braiins" - the brand was leaking the marketplace name into chrome that should stay neutral as v2 prepares to support multiple markets. `Braiins | Hashrate Autopilot` in the top header collapses to `Hashrate Autopilot`. `Braiins Autopilot` titles on the login and setup-wizard cards become `Hashrate Autopilot`. The literal "Braiins" string survives only where it refers to the actual marketplace product (Braiins API access section, "Pool destination (where Braiins delivers)" hint, panel labels).

Range-picker labels (`3 h`, `6 h`, etc.) tightened to `3h` / `6h` / `12h` / `24h` / `1w` / `1m` / `1y` to match the unit-glued-to-number convention used everywhere else on the dashboard. NL translation swaps `h` for `u` (`3u`, `6u`, ...). `localizedRangeLabel()` moved into a shared `lib/range-label.ts` so chart components can call it directly. PriceChart event tooltip's local `SatUnit` now translates `/PH/day` (was an unfixed duplicate of the Status helper).

### `[Feature]` Plot Ocean share_log % on the hashrate chart (#72)

New opt-in fourth series on the Hashrate chart: our share of Ocean's TIDES window (`share_log %`), rendered as a violet line on a right-side Y-axis labelled `% of Ocean` and formatted to 4 decimals (e.g. `0.0182%`) to match Ocean's own display. Useful for tracking how our slice of the pool drifts as Ocean's total hashrate grows or our delivered PH/s fluctuates - a single signal that captures both effects.

The daemon records `share_log_pct` once per tick (migration 0048) from the same Ocean `/statsnap` + `/pool_stat` fetch that already supplies `hashprice_sat_per_ph_day`, so the new data costs zero extra HTTP traffic. The dashboard exposes a new boolean toggle `show_share_log_on_hashrate_chart` (migration 0049, default `false`) under Chart smoothing on the Config page; when off, the chart is layout-identical to today (no extra padding, no axis stub). Null samples (Ocean unreachable, pre-migration history) break the line into segments via the existing `pathWithNullGaps` helper. The controller never reads this value - display only.

### `[Fix]` i18n: unit suffixes, mode badges, range labels, time-relative strings (#1 followup)

Sweep of every unit/abbreviation that should follow the active language but didn't:

- `/PH/day` rendered everywhere (Braiins panel rows, Ocean panel rows, P&L rows, hero card, bid table) was a literal English suffix. Now translates to `/PH/dag` in NL and `/PH/día` in ES via the central `SatUnit` renderer.
- Range picker labels (`3 h`, `6 h`, `12 h`, `24 h`, `1 w`, `1 m`, `1 y`, `All`) localized through a small `localizedRangeLabel()` helper - hour labels become `u` in NL (uur), `All` becomes `Alle` / `Todo`. Stats card labels referencing the active range pick up the localized form.
- Run-mode toggle and `ModeBadge` (DRY RUN / LIVE / PAUSED) now translate. NL: `GEPAUZEERD`, ES: `PAUSADO`. `LIVE` stays `LIVE` everywhere by intent (universal).
- Ocean payout countdown date (`~May 04`) now formats via the operator's `intlLocale` instead of browser locale.
- `formatNextPayout` translates the upstream Ocean unit text ("11 days", "5 hours", etc.) per locale.
- NL `formatAge` strings now use `u` for hour ("2d 4u geleden") instead of the English `h` the prior translation pass left in.

### `[Fix]` i18n: next-action panel + price-chart Y-axis now translate (#1 followup)

Two leftover English strings on a translated dashboard. The "next action" panel kept rendering English (`Will edit bid to 47,733 sat/PH/day on the next tick.` / `Current 47,772 sat/PH/day - tracking fillable + overpay.`) because the daemon was returning pre-formatted English summary/detail strings on the wire and the dashboard rendered them verbatim. The price-chart Y-axis displayed the literal `sat/PH/day` regardless of locale.

Daemon now emits a structured `descriptor` (a discriminated union of `paused`, `unknown_bids`, `braiins_unreachable`, `awaiting_hashprice`, `no_market_supply`, `will_create_bid`, `bid_pending`, `cooldown_active`, `will_edit_bid`, `on_target`) on every `next_action` response, alongside the existing English `summary` / `detail` strings (which stay for backward compatibility). Dashboard switches on the descriptor and renders through Lingui catalogs, so all the next-action prose follows the operator's language. Falls back to the legacy summary/detail when descriptor is `null` (older daemon, newer client).

Y-axis label now uses `t\`sat/PH/day\`` (and `t\`$/PH/day\`` for USD mode), translated to `sat/PH/dag` in NL and `sat/PH/día` in ES.

### `[Feature]` i18n: dashboard now translatable into Dutch and Spanish (#1)

The dashboard UI is fully translatable. A language picker sits in the header next to "sign out"; the choice persists to `localStorage` and the page boots in the operator's stored language (or browser language as fallback). Three launch locales: `en` (source), `nl`, `es`. Czech is deferred until a CZ reviewer is available. The format-locale picker (number/date display) on the Config page is unchanged and remains independent: it governs how 1,234.56 looks, not which language the surrounding chrome speaks.

Under the hood: @lingui/react v5, with macros that hash message IDs at compile time and one code-split catalog chunk per locale (~30 KB gzipped each, lazy-loaded). 421 source strings extracted across the dashboard - Status, Config, Setup wizard, Login, header chrome, the bids/event panels, the hashrate + price charts, time-relative format helpers (`5m ago`), and the bid-status labels. Units (`PH/s`, `sat/PH/day`, `BTC`), proper nouns (`Datum`, `Ocean`, `Braiins`, `Bitcoin Core`, `Electrs`, `TIDES`, `Stratum`), and mode badges (`DRY-RUN`, `LIVE`, `PAUSED`) deliberately stay in English regardless of locale.

`lib/locale.ts` was reframed in its header doc to clarify it's the format-locale picker only - distinct from the new UI-language picker.

### `[Fix]` Dashboard footer: bake real git SHA into the Docker image

The footer line `build N - <hash>` was reading "dev" instead of the actual short SHA on every Umbrel/Docker install. Cause: `vite.config.ts`'s `getBuildInfo()` ran `git rev-parse --short HEAD` at build time, but `.dockerignore` strips `.git/` from the build context so the git command always failed inside the image build, falling back to the literal string "dev". Fix: thread `GIT_SHA` in as a Docker build-arg from the publish workflow (`${{ github.sha }}`), surface it as an env var in the builder stage, and have `vite.config.ts` prefer it over the git CLI. Bare-metal builds keep working via the existing git fallback.

### `[Infra]` Umbrel manifest: Datum dep + auto-set datum_api_url

Re-added `datum` to `dependencies:` in `umbrel-app.yml`. Joining the Datum app's docker-compose project network gives our containers cross-network access to the Datum HTTP API on `datum_datum_1:21000` (the Umbrel package overrides Datum's default 7152 to match its app_proxy). docker-compose.yml now sets `BHA_DATUM_API_URL=http://datum_datum_1:21000`, which the daemon's existing env-override layer applies on top of any DB-stored value. Net effect on Umbrel: the wizard never needs to ask for the Datum API URL, and the dashboard's worker-count + reported-hashrate panels populate on first boot. `bitcoin` deliberately stays out of `dependencies:` because the autopilot does not need a co-located Bitcoin RPC to bid (Bitcoin RPC is only used by the optional P&L panel).

## 2026-04-25 (later)

### `[Fix]` Umbrel install: app_proxy hostname + container DB write permissions

Two bugs that surfaced on the operator's first Umbrel install. (1) `app_proxy` was pointing at `hashrate-autopilot_web_1`, but Umbrel uses the app dir as the docker-compose project name and we renamed that dir to `rdouma-hashrate-autopilot/` to satisfy the community-store prefix convention. The proxy retried forever and the dashboard surfaced "There was a problem connecting to Hashrate Autopilot." (2) The daemon crash-looped with `unable to open database file` because Umbrel bind-mounts `${APP_DATA_DIR}/data` over `/app/data`, and the host directory is created with ownership the in-container `node` user (uid 1000) cannot write to. Switched the runtime user to root so the daemon can always open the bind-mounted state dir; security boundary is the app_proxy sidecar, which is untouched.

### `[Fix]` Docker image: drop `pnpm prune --prod` so workspace symlinks survive

The v1.3.0 image built and pushed cleanly but crash-looped on every container start with `ERR_MODULE_NOT_FOUND: Cannot find package '@braiins-hashrate/bitcoind-client' imported from /app/packages/daemon/dist/main.js`. Operator caught it on first `docker run` against `:latest`. Cause: `pnpm prune --prod` deletes `node_modules` and reinstalls without the workspace-link wiring that the daemon needs to resolve sibling packages at runtime. Removed the prune step; image is ~100 MB larger but actually runs. v1.3.1 republishes with the fix.

### `[UI/Docs]` Rename Docker container/volume to `hashrate-autopilot`

The README's `docker run --name braiins-autopilot` line and the matching `--volume braiins-autopilot-data` predated the operator's "v2 supports multiple marketplaces" goal and read as Braiins-specific. Changed every README mention to `hashrate-autopilot` to match the registry path (`ghcr.io/<owner>/hashrate-autopilot`). Image name was already generic; this is a docs fix.

### `[Infra]` Multi-arch Docker image + GHCR publish workflow (#58)

New `Dockerfile` (multi-stage, `node:22-slim` base) builds the daemon + dashboard into a single image and runs the daemon as a non-root user. Includes a `HEALTHCHECK` that probes `/api/health` (#67), `VOLUME /app/data` for persistent state, and the standard appliance env vars (`HTTP_HOST`, `HTTP_PORT`, `DB_PATH`) wired up.

`.github/workflows/docker-publish.yml` runs in two modes: on every push/PR it does a `linux/amd64` validation build (no push); on `v*` tags it builds `linux/amd64` + `linux/arm64` and publishes to `ghcr.io/<owner>/hashrate-autopilot` with semver-derived tags (`vX.Y.Z`, `vX.Y`, `vX`, `latest`). ARM64 is mandatory: Pi-class hardware on Umbrel/Start9 won't run amd64-only images.

`.dockerignore` excludes `node_modules`, `dist`, `data`, secrets, and editor noise from the build context. README gets a "Running with Docker" section between the bare-metal install and the SOPS appendix.

### `[Feature]` Wizard auto-detects bitcoind RPC creds from appliance env vars (#60)

Both Umbrel and Start9 inject standard env vars (`BITCOIN_RPC_HOST`/`PORT`/`USER`/`PASSWORD`, optionally `BITCOIN_RPC_URL`) when an app declares a Bitcoin Core dependency. New `detectBitcoindEnv()` helper reads them and the setup-info endpoint surfaces both pre-filled defaults *and* a `detected_bitcoind` summary so the wizard can show a green "Detected from environment" badge above the RPC fields. Operator can still override; falls back cleanly to empty defaults when no vars are present. When the URL is detected, `payout_source` defaults to `bitcoind` (instead of `none`) so an Umbrel install gets an end-to-end working setup with no manual data entry on the payout side.

### `[Infra]` Graceful SIGTERM in setup mode + 8s hard force-exit fence (#61)

Operational shutdown already handled SIGTERM/SIGINT (drain tick loop → close HTTP → close DB), but the NEEDS_SETUP path didn't — a `docker stop` mid-wizard would force-kill the daemon and risk a half-flushed WAL. Added a setup-mode shutdown handler that closes the wizard server + DB cleanly on signal, and a `forceExitAfter(8_000)` fence on both shutdown paths so a stuck Braiins API call inside an in-flight tick can't ride out the 10 s Docker grace and earn a SIGKILL with the WAL mid-flush. Hard exit code is 124 (matching `timeout(1)`'s convention). Setup-mode handlers are removed before `bootOperational` installs its own — otherwise both fire on the next signal and the setup handler closes the DB out from under the operational shutdown.

### `[UI]` Setup wizard polish: eye toggles, hard-reload on success; Config page address↔worker binding

Three operator-feedback fixes:

- **Eye-toggle on every secret field** in the wizard (owner token, optional read-only token, dashboard password + confirm, bitcoind RPC password). Operators copy-paste tokens and want to verify what they pasted before submitting. Click-to-reveal SVG icon, no library dependency.
- **Hard reload after wizard success** instead of `navigate('/')`. SetupGate's poll runs every 30 s, so its cached probe state lags a wizard completion by up to that interval — a soft navigation could land on `/`, get bounced back to `/setup` by the stale probe, and then 401 on `/api/setup-info` (no longer in setup mode). `window.location.replace('/')` drops React state, refreshes the gate, and lands cleanly. Also: setup page now self-redirects home if `setup-info` returns 401, as a belt-and-suspenders defence against the same race.
- **Config page now mirrors the wizard's address ↔ worker binding.** BTC payout address moved from the on-chain-payouts section into the Pool destination section, sitting directly above the worker identity. Editing the address auto-derives the worker (`<address>.<label>`) preserving the operator's chosen label. Editing the worker into anything that doesn't have the address as its prefix surfaces a hard-red mismatch warning (same logic as the wizard) so an operator can't silently route shares to a different address. The on-chain-payouts section now displays the address read-only with a pointer to where to edit it.

### `[Fix]` Login page also bounces to wizard on NEEDS_SETUP

Belt-and-suspenders for the SetupGate redirect race. SetupGate already redirects when the daemon reports needs-setup, but if a browser is running a stale JS bundle (cached from a prior install where SetupGate didn't exist) it never gets there — it falls through `RequireAuth` to `/login`. The Login page now re-probes `/api/health` on mount and, if `NEEDS_SETUP`, clears any stored auth and redirects to `/setup` itself. Even an old-bundle browser eventually catches itself.

### `[Fix]` Setup wizard: in-place transition; spinner step 0.5

The wizard previously exited the daemon via `process.exit(0)` after writing config + secrets, on the assumption that systemd / Docker / a supervisor would relaunch. That breaks on plain `./scripts/start.sh` deployments — `start.sh` has no respawn loop, so the daemon stayed dead and the wizard's poll-for-OPERATIONAL hung indefinitely.

Refactor `main.ts` to extract the operational boot into a `bootOperational(deps, secrets, cfg)` function. The `onSetupComplete` callback now stops the setup-mode HTTP server (releasing port 3010), re-loads secrets + config from db, and calls `bootOperational` directly — same process, same DB handle, no exit. Wizard's polling sees `mode: OPERATIONAL` within a couple seconds and signs the operator in. No external supervisor required, which is what every appliance platform expects anyway.

Also: the wizard's PH/s number inputs used `step="0.1"` + `min="0.001"`, which combine to make `3.0` invalid (browser thinks the valid grid is 0.001, 0.101, …, 2.901, 3.001). Switched to `step="0.5"` + `min="0.5"` so whole and half PH/s values are valid.

### `[UI]` Setup wizard: clear stale auth, payout backend selector, worker-identity guard

Three first-bug-report fixes after shipping the wizard:

- **`SetupGate` clears stored auth when the daemon reports `NEEDS_SETUP`.** Operators with a remembered password from a previous install on the same host were getting routed straight to the auth flow on a fresh install, never seeing the wizard. Caught us once on a genuine fresh install — the operator's browser remembered the dashboard from a wiped+re-cloned working directory.
- **Mining step now has a "Payout tracking" backend selector** (None / Bitcoin Core / Electrs) with per-backend connection fields. The previous wizard hardcoded Bitcoin Core RPC as the only option, hiding the Electrs path entirely.
- **Worker identity is auto-derived from the BTC payout address** (`<address>.<label>`). Editing the address now follows through to the worker. Editing the worker to anything that doesn't have the address as its prefix surfaces a hard error blocking submission — Ocean TIDES credits shares by the address prefix, so a mismatch silently routes shares to nobody.

### `[Docs]` README: lead with the web wizard; SOPS becomes a power-user appendix

The Getting started section now points operators at `./scripts/start.sh` followed by opening the dashboard, where the wizard handles everything `setup.ts` used to. SOPS-related prerequisites and instructions moved into a single "Power-user setup with SOPS" section near the bottom, including the resolution-priority table (env > SOPS > db > NEEDS_SETUP) so power users can see exactly where their values come from. "Editing secrets later" + "Running on a second host" updated to reflect `data/state.db` as the canonical store.

### `[Feature]` First-run web onboarding wizard (#57, #67)

Daemon no longer hard-fails on missing config or secrets. When either is absent the daemon boots a slim NEEDS_SETUP HTTP server exposing a 3-step wizard at `/setup`: access (Braiins token + dashboard password), mining (target + floor hashrate, pool URL, worker identity, payout address; optional bitcoind RPC), review. On submit the daemon writes both rows to `state.db` and exits — the process manager (Docker, systemd, `restart.sh`) brings it back into operational mode, while the dashboard polls `/api/health` until `mode: OPERATIONAL` and auto-signs the operator in.

Secrets resolution is now `env > SOPS file > db-backed wizard > NEEDS_SETUP`. Power-user `setup.ts` + SOPS path is unchanged. New `secrets` table (migration 0047) co-locates wizard-collected secrets with the existing config row, so the appliance backup/restore story is a single directory.

Public `GET /api/health` (no auth) returns `{ status, mode }` in both boot phases. App-store hosts (Umbrel, Start9) consume it as the basic liveness probe (#67); the dashboard's `SetupGate` consumes the `mode` field to route between the wizard and the normal status flow.

Foundation for #56 (appliance packaging umbrella). Closes #57 and #67.

### `[Feature]` Configuration via `BHA_*` environment variables (#59)

Every field in `AppConfig` and `Secrets` now also resolves from a matching `BHA_<UPPER_SNAKE>` environment variable, with priority `env > db > defaults`. Read once at boot and re-validated through the same Zod schemas the dashboard uses, so a malformed value fails loudly on startup rather than being silently ignored. New `docs/configuration.md` lists every variable; README links to it.

Foundation for #57 (web onboarding wizard) and the wider appliance-packaging effort (#56). Power-user SOPS path is unchanged — env-vars overlay on top of whatever the SOPS file produces, so a `docker run -e BHA_BRAIINS_OWNER_TOKEN=…` rotation works without touching the encrypted file. Cross-field invariants (e.g. `floor <= target`) are still enforced after the overlay.

## 2026-04-25

### `[Fix]` Hero PRICE card: cap at bid + lengthen window to 30 min (#55)

The first round of this fix earlier today switched the hero card to a 10-min trailing duration-weighted average, expecting that to wash out the per-tick polling and metering jitter. It addressed the wild per-tick swings, but the operator caught a deeper bug: the smoothed value still read above the bid (52k vs a 47k bid) — physically impossible under pay-your-bid, where the bid is a hard ceiling.

Root cause: `delivered_ph` is sourced from Braiins's `avg_speed_ph`, which is itself a *trailing* moving average, while `Δprimary_bid_consumed_sat` is real-time. When recent delivery has trended above the smoothed reading, Σ Δsat / Σ (delivered_ph × Δt) overshoots the bid by 5–15%. The stats card already handles this by capping at the duration-weighted average bid (see stats.ts → "the bid is a hard ceiling"); the hero query just missed the same cap.

Two changes:
- **Cap at the weighted-average bid** in `effectiveSatPerEhDayWindow`, mirroring `/api/stats`. Eliminates the above-bid impossibility regardless of window length.
- **Lengthen the window to 30 min**. At 5–20 min the raw ratio routinely exceeds the bid, so the cap pegs the value flat at the bid (useless — just a duplicate of NEXT ACTION). At 30+ min the avg_speed_ph lag bias washes out and the unfiltered metric is self-consistent on the operator's data, while still being far shorter than the stats card's range so the hero stays "live."

Hero card tooltip + `live_effective_sat_per_ph_day` field doc updated to match.

## 2026-04-24

### `[UI]` Hero PRICE card: live effective rate, not the 3h average (#55)

The top-left price figure was reading `avg_cost_per_ph_sat_per_ph_day` — the same range-averaged number the `avg cost / PH delivered` stats card already showed below. Hero now reads a new `live_effective_sat_per_ph_day` field computed from just the most recent valid inter-tick `primary_bid_consumed_sat` delta (`Δsat × 86_400_000_000 / (delivered_ph × Δt_ms)`), matching the "current" semantics the operator expects from a hero card. The stats row keeps the range-averaged figure. Same zero-dip filter as the existing spend/hashrate helpers.

### `[UI]` Stats card: colour-code "avg cost vs hashprice" by sign (#54)

Negative values (we paid under hashprice — cheaper than mining at current difficulty) now render emerald green; positive values (we paid over hashprice) render red. Null / zero keep the default slate. Mirrors the hero PRICE card's delta coloring so the stat strip reads consistently at a glance.

### `[Infra]` Migrations 0043/0045: preserve `overpay_sat_per_eh_day` through the CLOB-redesign retirements

Earlier the pair dropped (0043) then re-added (0045) `overpay_sat_per_eh_day`, resetting every operator's configured value to the 1,000 sat/PH/day default on upgrade. Revised 0043 to preserve the column (semantics are identical pre-#49 and post-#53, so the operator's value remains meaningful). Revised 0045 to a no-op (SELECT 1;) so the migration sequence stays contiguous and operators who already applied the column-adding version on dev don't re-execute it.

Net effect: main-branch users pulling post-v2.1 keep their existing overpay through the upgrade rather than silently resetting. The other v1.x fill-strategy knobs (escalation_mode, fill_escalation_*, lower_patience_minutes, min_lower_delta_sat_per_eh_day) stay retired — they have no counterpart in the post-#53 controller.

### `[UI]` Event-detail tooltip: promote `fillable` + `overpay` to first-class rows

They were previously folded into an italic sentence at the bottom of the panel ("(fillable X + overpay Y)") while less-central values like `hashprice + max overpay` got line items. Swapped: `fillable` and `overpay` now appear as top rows in the "market at this tick" block — they're the load-bearing inputs the controller used to decide that edit, so the tooltip leads with them.

### `[UI]` Price chart: draw `fillable` as a first-class cyan line

The controller targets `fillable_ask + overpay_sat_per_eh_day` every tick, yet the price chart had no line for fillable — so the operator saw the amber bid stepping around and hashprice drifting underneath, with no visible signal explaining *why* the bid moved. Every edit is explained by fillable moving; it belongs on the chart.

Added a cyan `fillable` line below the amber bid. The vertical gap between the two is exactly `overpay_sat_per_eh_day` (clamped by the cap), so the cushion is now visually explicit. The line gets null-gap-bridged like hashprice and participates in Y-axis auto-scaling.

## 2026-04-23

### `[Feature]` Config toggle: show the effective-rate line on the price chart

Off by default. The emerald effective-rate line is window-aggregated Δconsumed_sat ÷ (delivered_ph × Δt) — legitimately dramatic dips every time Braiins' counter settles in lumps, which autoscales the Y-axis down by 10–15 k sat/PH/day and crushes the flatter bid/fillable/hashprice/max-bid detail into a thin band at the top. Flip on from Config → Chart smoothing when you want to eyeball settlement behaviour; you'll lose resolution on the finer controller movements in exchange.

The hero PRICE card and the AVG COST / PH DELIVERED stat already surface the effective rate as a number without hijacking the chart, so the line is only useful for operators specifically inspecting the settlement rhythm.

### `[UI]` Hero PRICE + stats "avg cost" card: clarify these are averages, not spot (#53)

The hero PRICE card read "48,290 sat/PH/day effective" while NEXT ACTION read "current 47,130" — same underlying question ("what am I paying?"), two different numbers, no tooltip explaining the relationship. Operator reasonably wondered why those disagreed.

Added a tooltip on the hero PRICE card ("Average effective rate over the selected chart range — not the live bid. For the current bid see NEXT ACTION") and rewrote the AVG COST / PH DELIVERED stats tooltip to match. The two numbers are the same metric on the same window; they're deliberately duplicated so each panel stands on its own.

### `[Fix]` Pay-your-bid controller: deadband on EDIT_PRICE to stop the jitter storm (#53)

First hour on the new controller surfaced a flap mode: `fillable_ask` naturally jitters ±1-5 sat/PH/day tick-to-tick as distant supply levels reshuffle, and the EDIT_PRICE tolerance was `tick_size = 1,000 sat/EH/day = 1 sat/PH/day` — so every jitter proposed a mutation. Dashboard filled with yellow edit-price dots, each lower burned the 10-min cooldown, the chart became unreadable.

Deadband now scales to `max(tick_size, overpay/5)`. At the 1,000 sat/PH/day default overpay this is 200 sat/PH/day — below that, the current bid is still comfortably above fillable and chasing the noise buys nothing. NEXT ACTION's "will lower from 47,062 → 47,049 (delta 13 sat/PH/day)" style micro-moves are now absorbed.

### `[Feature]` Pay-your-bid controller: track `fillable_ask + overpay` (#53)

Direct A/B on live data this afternoon falsified the CLOB assumption behind the #49 redesign: lowering
`max_bid_sat_per_eh_day` from 50,000 → 49,000 dropped effective cost from ~50,300 → ~49,899 sat/PH/day while the
fillable ask sat unchanged at ~47,158 the whole time. Braiins matches pay-your-bid — the gap between bid and
fillable was money left on the table, every tick, for weeks.

New controller: each tick the bid is set to `min(fillable_ask + overpay_sat_per_eh_day, effective_cap)` where
`effective_cap = min(max_bid, hashprice + max_overpay_vs_hashprice)`. The new `overpay_sat_per_eh_day` config
knob (default 1,000 sat/PH/day) is the one pricing dial: higher = more headroom against short upward market
moves and bigger premium; lower = closer to the cheapest fillable price and more sensitive to noise.

The retired fill-strategy machinery from v1.x (`escalation_mode`, `fill_escalation_*`, `lower_patience_minutes`,
`min_lower_delta_sat_per_eh_day`) stays retired — under direct fillable tracking the optimal price is already
proposed every tick, and Braiins' 10-min price-decrease cooldown in `gate.ts` is the only pacing rule needed.
Reopened #15, #16, #38, #48, #51 for operator triage against the new design; each now has a comment referencing
#53 and the empirical data.

### `[UI]` Stats card: rename "avg overpay vs hashprice" → "avg cost vs hashprice"

The label said *overpay* but the value is routinely negative (paying below break-even hashprice is the normal, desirable case under CLOB). "Overpay" implied we were always paying above — contradicted by a `−1,097` reading. Renamed to "avg cost vs hashprice" and rewrote the tooltip so the sign convention reads correctly: negative means we matched asks below break-even (good), positive means above.

### `[Fix]` Effective-rate line: per-pair lag filter catches outage-dominated deep dips

Earlier fix skipped zero-delta pairs and required ≥3 non-zero pairs in the window. Worked for "counter flat through settlement lulls", but missed the other failure mode: outage ticks where the counter barely ticks (delta 4–6 sat/min) while `delivered_ph` carries its stale 3.67 PH/s reading. Those pairs have non-zero deltas so they passed the earlier filter, but their implied rate is near zero (2,000 sat/PH/day where we actually pay 45,000). The effective-rate line still dipped to the floor during today's 10:00 outage.

New per-pair guard: skip any pair where observed `delta / (our_bid × delivered_ph × dt / 86.4e6)` < 0.30 — i.e. we charged less than 30 % of what delivered_ph × our_bid would predict. Normal CLOB matches run at ~80 % of bid; outage pairs run at < 10 %. The 30 % cutoff sits comfortably between them.

Empirical on 12 h of real data: minimum rate went from ~2,000 → 32,464; 33 lag-dominated pairs dropped across ~750 total. The line now stays honest during outages — it goes dark rather than plunging toward zero.

### `[Fix]` Hashrate chart + UPTIME: use counter-derived delivered instead of Braiins' lagged avg (#52)

The dashboard trusted `tick_metrics.delivered_ph` — Braiins' own `avg_speed_ph` rolling-average — as the truth about "how much hashrate are we actually getting right now". That field lags reality by minutes: during the 2026-04-23 12:55-12:59 outage the counter delta dropped to ~4 sat/min (95% cut) and Datum/Ocean both fell below 0.2 PH/s, but `delivered_ph` still read 3.67 PH/s. Visible consequences: the hashrate chart's orange Braiins line sat flat through the outage (contradicting the other two series), and the UPTIME card advertised 100% through a multi-minute no-matching event.

Now the Braiins-side delivered is computed from counter deltas: `Δprimary_bid_consumed_sat × 86.4e9 / (our_bid × Δt)`. Same signal the PRICE chart's effective-rate line already uses, just rearranged to solve for hashrate. Applied to:

- Hashrate chart's "delivered (Braiins)" series (client-side; falls back to `delivered_ph` for pre-migration rows or null-counter ticks).
- `/api/stats` `uptime_pct`: now "time with Δ > dur/1000" (i.e. more than 1 sat per second of span — catches the 4-sat/tick incident; normal 90+ sat/tick passes).
- `/api/stats` `avg_hashrate_ph` and `total_ph_hours`: counter-derived, time-weighted.
- `TickMetricsRepo.avgDeliveredPhSince` (used by `/api/status` for the 3h hashrate readout).

Sanity-checked on the real 3h window: old uptime 100% → new uptime 94%; old avg hashrate 3.43 PH → new 2.85 PH. The 6% gap and ~0.58 PH discrepancy are exactly the Braiins-lag leakage the operator was seeing.

The BRAIINS service panel's "delivered" row still reads the raw Braiins API value — keep the cross-check visible.

### `[Fix]` Effective-rate line: no more misleading dips across Braiins settlement lulls

The Price chart's `effective` line computed `Σdelta / Σ(delivered×dt)` over a rolling window. When Braiins' `primary_bid_consumed_sat` counter went flat for several minutes (a normal settlement-batching artifact — the counter doesn't tick every minute even though `delivered_ph` keeps reporting ~full delivery via its own lagged rolling average), the numerator stalled but the denominator kept accumulating. Result: effective rate read ~2,000 sat/PH/day through stretches where we were actually paying our normal ~45,000 — visually implying we got hashrate almost for free during settlement lulls.

Two guards now applied inside the rolling-window loop:

1. **Skip zero-delta pairs entirely** — neither numerator nor denominator advances across a "counter unchanged" pair. Those pairs carry no pricing information; averaging them in only pulls the estimate toward zero.
2. **Require ≥3 non-zero pairs in the window** before emitting a point. Below that, the line goes dark (truthful gap) rather than drawing a rate we can't stand behind.

Empirical on 12 h of real data: minimum effective rate went from 2,126 → 14,889; only 22 of 568 points dropped; rate distribution is now tight (p05 37,937, median 47,118, max 71,320).

### `[Docs]` README: rewrite around CLOB mental model; retire simulator + fill-strategy framing

The README was still pitching the pre-CLOB worldview: "careful bidding", three-mode escalation ladder, `lower_patience_minutes`, overpay-vs-fillable stats, and the what-if simulator. All of that has been retired in the code over the last week. Rewrote the narrative sections (hero description, Why, How it works, Key features, Configuration) around the actual design: bid is a matching-access ceiling, we pay the clearing ask, one bid held at `min(max_bid, hashprice + max_overpay_vs_hashprice)`, effective rate as a first-class measured metric. Added a short "How Braiins matches" section naming the CLOB mechanic explicitly and pointing at `scripts/verify-pricing-model.ts`. Removed `docs/images/simulator.jpg`. `dashboard.jpg` and `config.jpg` will be refreshed by the operator once market conditions give a good screenshot.

### `[Feature]` Cheap-mode: sustained-average engagement window (#50)

Cheap-mode previously engaged on a per-tick spot comparison of `best_ask` vs `hashprice × cheap_threshold_pct`. A single flash-dip in best ask was enough to flip the target up; a single spike back flipped it straight off — with a matching EDIT_SPEED on each flip, each one requeuing the bid and incurring stale shares during resubscribe.

New `cheap_sustained_window_minutes` config (default 0 preserves legacy behaviour). When > 0, cheap-mode engages only when `avg(best_ask)` over that many minutes is below `cheap_threshold_pct × avg(hashprice)` over the same window — averages computed from `tick_metrics` (no new columns). Natural hysteresis falls out of the window: cheap-mode only flips when the window as a whole crosses the threshold. Requires ≥5 samples before honouring; below that it falls back to the spot check.

Lives on the Config page under Hashrate targets next to `cheap_target` / `cheap_threshold`. Help text calls out the insufficient-history fallback.

### `[Fix]` P&L + runway: measured spend, not modelled bid × delivered

Under CLOB the bid is a ceiling and the *actual* price we pay comes from matched asks. The dashboard had been computing "projected spend/day" and runway from `bid × delivered × time / 1_440_000` — the pay-your-bid formula. With a 48k bid, 3 PH/s delivery, and real spend matching asks around 41k, this consistently **overstated daily spend by 15-20%** and understated runway by the same amount. Wherever we used `bid`-based modelling, we now use `primary_bid_consumed_sat` deltas (the authoritative Braiins counter).

- **P&L per-day card**: "spend/day" and "net/day" are measured, not projected. Tooltips updated. "Avg bid price" input row deleted — it was the multiplier for the dropped model. Income/day stays as a projection (`avg hashprice × avg delivered`).
- **Braiins panel runway** ("3.9 days · ~26 apr") now divides available balance by `actual_spend_per_day_sat_3h` — the last 3 h of real consumed sat, scaled to 24 h. Same zero-dip filter as the stats SQL so a transient bid-swap blink can't swing the forecast.
- **Server**: `/api/finance/range` gains `actual_spend_sat` + `actual_spend_per_day_sat`, drops `avg_price_sat_per_ph_day` and `sum_spend_sat`. `/api/status` gains `actual_spend_per_day_sat_3h`. Backend: new `TickMetricsRepo.actualSpendSatSince()` with the zero-dip filter.
- **`tick_metrics.spend_sat` column**: stopped being populated (writes always null) — the modelled value had no remaining readers. Column kept for schema continuity.
- `packages/dashboard/src/lib/finance.ts` deleted. All 212 tests pass.

### `[Fix]` Effective-rate zero-dip inflation; retire fillable UI; expandable price chart; cheap-mode to best-ask

**Root cause nailed for the "800k sat/PH/day" hero display**: when Braiins snapshots the primary bid during a CREATE/EDIT cycle, `amount_sat` and `amount_remaining_sat` can both read zero for one tick — so our `amount_consumed_sat = amount_sat - amount_remaining_sat` dips to 0 and back up to the real counter on the next tick. `LAG()` across that dip turns the entire recovery value (hundreds of thousands of sat) into a bogus delta that then dominates every window-aggregate it lands in. On the operator's DB a single 311,495-sat spurious delta turned a real 41k sat/PH/day rate into a reported 800k+. Fix: require **both** endpoints of every delta to be > 0 in the stats SQL and the chart's effective-rate computation. Belt-and-suspenders: clamp the displayed effective rate to our own bid (physical CLOB ceiling).

**Fillable removed from the dashboard.** Under CLOB the bid is a ceiling and we pay the matched ask — "fillable" (the depth-aware price at which our whole target would fit) became a meaningless abstraction in October but was still plastered across the UI. Gone: the Braiins panel row, the orange dashed line + legend entry on the Price chart, the fillable / fillable+overpay rows in the pinned-event tooltip, and the fillable references in Config help text. The underlying `tick_metrics.fillable_ask_sat_per_eh_day` column is still populated and still surfaces on the Next-Action predictor for now — pure UI cleanup.

**Cheap-mode now activates on `best_ask` instead of `fillable`.** Under CLOB the cheapest reachable price is whatever sits at the top of the ask ladder — exactly what cheap-mode semantics ("opportunistic scale-up when the market is cheap") want. Config help text reworded accordingly.

**Price chart expand/collapse.** New "expand" button next to the Price chart title doubles the chart height so closely-stacked lines (bid, hashprice, max bid, effective) can be read independently. Tightened the Y-axis headroom from ±10%/±15% to ±5% so the chart doesn't waste half its space on empty range above the top data point.

### `[UI/Fix]` Hero PRICE: effective rate + delta vs hashprice; stats SQL filter consistency

Two fixes on the CLOB redesign:

**Hero PRICE widget** — the big number at the top of the Status page was showing our bid price with a "+N" delta vs fillable. Under CLOB the bid is a ceiling, not what we pay. Replaced with the window-aggregated **effective rate** (from `/api/stats.avg_cost_per_ph_sat_per_ph_day`), and the ±N delta is now against the **spot hashprice** (negative = paying below break-even, profitable; positive = above). New tooltip re-explains.

**Stats SQL filter mismatch** — operator reported AVG COST / PH DELIVERED showing ~1M sat/PH/day (should be ~46k). Root cause: the numerator filter (`delta IS NOT NULL`) was looser than the denominator filter (`delta IS NOT NULL AND delivered_ph > 0 AND dur > 0`). A tick with a non-null consumed delta but zero delivery at that instant (Braiins' counter caught a match from earlier while our snapshot saw delivery=0) counted in the numerator without a corresponding denominator share, inflating the rate. Also added a 5-min cap on `dur` to discard restart-gap intervals. Numerator and denominator now share a single `valid` condition. Same fix applied to `avg_overpay_vs_hashprice`.

### `[Feature]` Retire the fill-strategy machinery — CLOB redesign (#49 master)

Empirical verification confirmed Braiins matches CLOB-style: the bid is a ceiling, the actual price paid is the matched ask. Our entire fill-strategy subsystem (overpay-above-fillable, three-way escalation mode, lowering patience, min-lower-delta) was authored under a pay-your-bid assumption and turned out to be pointless complexity. This release removes it.

**Daemon**:
- Migration 0043 drops `overpay_sat_per_eh_day`, `escalation_mode`, `fill_escalation_step_sat_per_eh_day`, `fill_escalation_after_minutes`, `min_lower_delta_sat_per_eh_day`, `lower_patience_minutes` from the config table.
- `decide()` rewritten from 329 lines to ~130: compute effective cap, keep one bid at it, EDIT_SPEED on cheap-mode transitions. No timers, no patience gates, no escalation modes.
- `controller/tick.ts` loses its `lowerReadySince` / `belowTargetSince` / `manualOverrideUntilMs` state — dead under the new model.
- `/api/simulate` endpoint + `SimulateRoute` deleted entirely. Replaying "what if overpay=X" against historical ticks had no decision value under CLOB.
- `/api/stats` — `avg_cost_per_ph_sat_per_ph_day` and `avg_overpay_vs_hashprice_sat_per_ph_day` now computed from `primary_bid_consumed_sat` deltas (actual effective rate), not bid price. `avg_overpay_sat_per_ph_day` removed (bid-vs-fillable is meaningless under CLOB).
- `/api/status` next-action inference simplified to match.

**Dashboard**:
- Simulation tab removed. No more Real-time / Simulation toggle.
- Config page — entire "Fill strategy" section deleted.
- Header stats bar loses "AVG OVERPAY VS FILLABLE" card. "AVG COST / PH DELIVERED" and "AVG OVERPAY VS HASHPRICE" re-label tooltips to explain they're effective-rate-based.
- Status page's `SimParamBar` + `SIM_NUMBER_FIELDS` + sim-event synthesis + simulated-metric-overlay logic all removed. Price chart's sim-mode price line gone.

The "our bid" line on the price chart is kept for now — once stable, it will be removed too (it equals the effective cap at all times).

**Tests**: `decide.test.ts` rewritten to cover the minimal new contract (16 tests down from 51 — the deleted ones tested escalation/lowering/patience paths that no longer exist).

Existing installs need a fresh pull + restart to pick up migration 0043. Any operator still relying on the retired knobs: they no longer exist. The autopilot now just sits at `min(max_bid, hashprice + max_overpay_vs_hashprice)` and lets CLOB do the work.

## 2026-04-22

### `[Fix]` Effective rate: suppress thin-data transients at window edge (#49 follow-up)

Inspected the operator's DB directly: the weird 52k → 40k "crash" on the effective line right after the migration backfill was an artifact of thin-data aggregation. Braiins' `amount_consumed_sat` counter updates ~every minute on their side, so the very first observation in a fresh window sees a *catch-up delta* — the first Δ we compute spans more real matching activity than its wall-clock interval implies, and with only 1–2 intervals in the aggregation window the inflated first interval dominates. Manual calc on the DB: first aggregated rate came out 88k (outlier-filtered), second 52k (inside the 1.5×-bid guard so it rendered), then it collapsed to the real 40–46k range as the window filled with real data.

Fix: require the aggregation to cover at least `max(90s, window/2)` of wall-clock span before emitting a point. With smoothing off (3-min window) that means waiting ~90s post-restart; with 30-min smoothing, ~15 min. The line starts drawing once its value is meaningful rather than showing spurious spikes that settle into the real value.

### `[Fix]` Effective rate: include in Y-axis scaling so the line is visible (#49 follow-up)

Empirically the window-aggregated effective rate sits 2-20% below bid (~38k-46k sat/PH/day in fresh observation vs a ~47k bid), but the chart's Y-axis was auto-scaling off bid/fillable/hashprice only — so the effective line was rendering BELOW the visible viewport. Only the handful of points that happened to brush the 46k lower edge poked into the chart, drawing as near-vertical strokes from off-chart-bottom up to the 46k floor. The rest of the line was invisible.

Effective is back in the Y-axis sample now. The previous reason for excluding it — rogue per-tick rate spikes — no longer applies now that computation is window-aggregated (Σ numerator / Σ denominator), plus the 1.5×-bid last-chance outlier filter keeps the scale safe. Legitimate effective-below-bid is exactly what the chart needs to show.

### `[Fix]` Effective rate: window-aggregate Σconsumed / Σ(delivered × dt) instead of averaging ratios (#49 follow-up)

Per-tick rates were meaningless: Braiins' `amount_consumed_sat` counter updates asynchronously from our tick loop, so some ticks report Δ=0 and the next absorbs a catch-up Δ that spans multiple ticks. Per-tick rates swung wildly between zero and multiples of the real rate; naive rolling-mean of those ratios amplified the problem, and the outlier filter thinned the survivor set into sparse disconnected points rendered as vertical spikes or missing lines entirely (depending on the smoothing window).

Correct approach ships now: aggregate the numerator (Σ Δconsumed) and denominator (Σ delivered_ph × Δt_ms / 86,400,000 = PH-days) separately over the last N minutes, then divide. That's the true time-weighted average rate — summing-before-dividing absorbs Braiins' update cadence naturally. Window = max(3, priceSmoothingMinutes) so the line is legible even with smoothing set to 1; bumping it to 5 or 10 smooths over longer trends. Outlier rejection against 1.5× current bid preserved as a last-chance guard.

### `[Feature]` Price chart: rolling-mean smoothing for our-bid and effective lines (#49 follow-up)

Operator requested a smoothing knob for the Price chart analogous to the one the Hashrate chart has had since #42. New `braiins_price_smoothing_minutes` config (migration 0042, default 1 = off) applies a rolling-mean window to both `our bid` and `effective`. Fillable / hashprice / max bid stay untouched — they're market-wide signals, not ours. Lives in the Config → Chart smoothing section next to the existing Braiins/Datum knobs. Same `integer_spinner` presentation (step 5, min 1).

### `[Fix]` Effective-rate chart line: outlier rejection + exclude from Y-scaling (#49 follow-up)

First live look at the effective-rate line had one bad sample pull the Y-axis up to 100k sat/PH/day, squashing the real 45-50k data into a thin band. Root cause: `amount_consumed_sat` snapshots update asynchronously from Braiins while our tick's `delivered_ph` is an instantaneous reading — at a boundary where delivered briefly dips but consumed has already accumulated a chunk, the per-tick rate divides by a small denominator and reports multiples above reality for one tick.

Two-part fix: (a) outlier rejection at point-construction — a rate above 1.5× the current bid price is physically implausible (bid is an upper bound by definition), so drop the sample; tightened the near-zero-delivery cutoff from 0.01 to 0.1 PH/s while there. (b) Excluded the effective series from Y-axis auto-scaling — same treatment as max bid and cap — so any residual noise doesn't distort the viewport.

### `[Feature]` Per-tick actual-spend snapshot + "effective rate" chart line (#49)

Empirical analysis of `owned_bids.amount_consumed_sat` vs `tick_metrics.spend_sat` (modeled at pay-your-bid) across the operator's active bid showed actual consumed sitting ~7.7% below modeled — suggestive but not conclusive of CLOB/pay-at-ask. Contributing noise on either side (Braiins' rolling `avg_speed_ph` lag per `observe.ts:283`, our 1-min-per-tick `spend_sat` approximation, and a tiny possible CLOB effect) all mix into a single bid-aggregate number we can't cleanly decompose.

Fix: migration 0041 adds `primary_bid_consumed_sat` to `tick_metrics` — a per-tick snapshot of the primary owned bid's cumulative `amount_consumed_sat` straight from Braiins' `/spot/bid`. Per-tick deltas give the authoritative actual spend at the same sampling rate as the rest of the chart data, no aggregation noise.

On the Price chart, a new emerald "effective" line shows the per-tick actual rate, computed client-side as `Δconsumed × 86_400_000 / (delivered_ph × Δt_ms)` in sat/PH/day. Drawn on top of the amber "our bid" line so any systematic gap between "what we bid" and "what Braiins actually charged" reads at a glance. Gap-safe (same 5-min bridge threshold as the other null-gap helpers), filtered against counter resets and near-zero delivery. Populated going forward — existing historical ticks show nothing (null column).

Pull + restart the daemon to enable the snapshot; a few hours of data and a noticeable overpay make the two lines' relationship unambiguous — pay-your-bid has effective tracking the bid, CLOB has it tracking fillable, anything else gets characterised empirically from the new data.

### `[Docs]` README: preemptive escalation mode, per-bid budget = 0, updated Config screenshot

README was stale on three fronts: (1) the `above_market` (preemptive) escalation mode added in #38 was not
mentioned — the escalation-ladder bullet only described "raises in steps (or jumps)"; (2) the per-bid budget now
treats 0 as "use the full available wallet balance" (#40) and that sentinel wasn't called out; (3) the Configuration
section listed an "Alerts & timers" subsection that has been hidden from the UI. Refreshed the escalation bullet to
cover all three modes, added the budget=0 semantics, dropped the stale subsection reference, and replaced the Config
screenshot with a current one.

### `[UI]` NEXT ACTION: surface the *binding* lower-gate (cooldown vs patience vs override)

The panel would announce "Will lower in ~2 min" whenever the market-settle patience window was the first pending gate, even if the Braiins 10-min price-decrease cooldown was in fact longer and would hold the edit for another 6 minutes. Operator saw an ETA that couldn't be met.

Now all three lower-gates — override lock, market-settle patience, and the Braiins price-decrease cooldown — are evaluated, and whichever one ends *latest* is surfaced as the reason + ETA. Side effect: the progress bar label on the patience path used to read "Override lock clears in" because the event_kind was mislabeled; there is now a distinct `lower_after_patience` event_kind and the label reads "Patience clears in".

### `[Fix]` Price chart: bridge single-tick blips instead of rendering a visible gap (#47)

A single null tick (daemon restart boot, transient `/spot/bid` API hiccup) made the price line + fill drop out for ~60 seconds on the chart — reading as a mini-outage when the operator actually just saw a blink. Root cause: `pathWithNullGaps` (#44) closed the subpath on any null, which is correct for multi-minute market outages but too aggressive for one-tick observe noise.

Now the null-gap helpers bridge based on wall-clock duration instead of null-count. If the next valid sample arrives within ~3 tick intervals (180 s), draw a line across any intervening nulls; otherwise break as before. Applied symmetrically to the fill polygon so line and fill stay in sync. Long outages still surface loudly; the single-tick noise absorbs invisibly.

### `[Fix]` Price chart: fill no longer paints diagonal wedges across null gaps (#46)

Regression introduced by the #44 fix. That change made the price line break into multiple SVG subpaths on null (market-outage) ticks — correct for the line, but the fill wrapper still appended a single baseline closure at the very end (`${pricePath} L<lastX>,<bot> L<firstX>,<bot> Z`). SVG only closed the *last* subpath to the baseline; every interior subpath closed back to its own starting `M`, painting diagonal "sun ray" wedges across the gap.

Now a dedicated `areaPathWithNullGaps` helper emits one closed polygon per non-null sub-run, each anchored to the baseline at its own segment endpoints. The fill tracks right under the price line again, and genuine gaps render as gaps in both line and fill.

### `[UI]` P&L per-day: surface the avg inputs so the projection math is readable

The panel showed `projected income/day`, `projected spend/day`, `projected net/day` and `hashprice (break-even)` — four numbers with no visible shared multiplicand. Operators had to reverse-engineer `avg delivered` by dividing income by hashprice to see why the net wasn't just "target × hashprice". Worse: the hashprice row was the CURRENT spot rate, but the projection actually used the range-averaged hashprice — close but subtly different.

Now the card is laid out as inputs → derivations → reference, visually separated by thin dividers:

```
avg delivered (3h)      2.65 PH/s      ← inputs
avg hashprice (3h)    46,718 sat/PH/day
avg bid price (3h)    47,530 sat/PH/day
─────────────────────────────────────
projected income/day   124,071 sat    ← = avg hashprice × avg delivered
projected spend/day    125,953 sat    ← = avg bid × avg delivered
projected net/day       −1,882 sat    ← = income − spend
─────────────────────────────────────
ocean est. income/day  130,087 sat    ← alternate pool-side estimate
hashprice (now)        46,809 sat/PH/day  (was "hashprice (break-even)")
ocean lifetime        866,860 sat
```

Every derived number is now traceable to the rows directly above it. The spot hashprice sits in the reference group (renamed "hashprice (now)") so it isn't confused with the range-averaged figure the projection actually uses.

### `[UI]` Config: Budget section hint spans full panel width (#40 follow-up)

The sentinel hint wrapped narrowly in one grid column, stacking into 3–4 short lines next to a huge empty right column. Set `fullWidth: true` on the `bid_budget_sat` field so the label cell spans both columns; the `<NumberField>` itself is capped at 200 px so the input stays its normal size. Hint now renders as a single wide line.

### `[Fix]` Price chart: raise short-gap bridge threshold to 5 min (#47 follow-up)

The 3-minute bridge turned out to be too tight for a full deploy cycle on the operator box — pnpm install + rebuild + restart routinely takes 2–3 min cold, so a single deploy left a visible hole right at the restart boundary. Bumped to 5 minutes. Covers a full deploy window plus one follow-up observe-miss; real market outages run many minutes to hours so the 2-minute widening doesn't blur the #44 signal.

### `[UI]` Config: bid_budget=0 hint acknowledges the active bid (#40 follow-up)

The sentinel hint ("Full wallet balance per bid. Currently ≈ 83,704 sat") read as if the autopilot was about to spend that amount right now — but if an owned bid is already running, the next CREATE doesn't fire until it finishes. The figure was correct, the framing wasn't.

Now when an active owned bid is present, the hint surfaces it explicitly: "A bid is currently running (≈ 157,860 sat left). The next CREATE fires when it finishes — at that point the full available wallet balance (currently ≈ 83,704 sat) will be used." Same field, same amounts; just the order of operations the operator actually experiences.

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