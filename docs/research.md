# Braiins Hashrate Autopilot — Research Report

Consolidated research for a retail-scale autopilot on the Braiins Hashpower
spot market, pointing purchased hashrate at a Datum-connected Ocean pool on an
Umbrel node. Target sustained: 1 PH/s.

All claims cite a URL. Live data samples were captured 2026-04-14 / 2026-04-15
UTC against the production API.

Meta note on tooling: WebFetch and WebSearch were denied at the harness level
throughout the sprint, despite the user authorising them. Per the instruction
"if a specific URL fetch is denied, try alternates and note the gap — do not
abandon the task", all web retrieval was performed with `curl` from Bash and
all denials are logged in `docs/permissions-log.md`. Where a source was unreachable
without an authenticated session (Reddit, BitcoinTalk), it is marked as a gap
rather than fabricated.

---

## Executive summary — what is solid, what is a gap

Solid (implementable today, backed by the live OpenAPI and official docs):
1. The API is a documented REST JSON API at base `https://hashpower.braiins.com/v1/` (OpenAPI 3.1.0 spec served at `/api/openapi.yml`, Swagger UI at `/api/`). Auth is a single `apikey:` header, with owner vs read-only token roles. ([openapi.yml source](https://hashpower.braiins.com/api/openapi.yml), [API doc](https://academy.braiins.com/en/braiins-hashpower/api/))
2. Full CRUD over bids exists: `POST/PUT/DELETE /spot/bid` plus detail, speed history, delivery history, balance, transactions, orderbook, trades, OHLCV. No gRPC/GraphQL for the marketplace. ([openapi.yml](https://hashpower.braiins.com/api/openapi.yml))
3. Pricing is in **sat per hashrate-unit-per-day**, where the hashrate unit is reported in `/spot/settings.hr_unit` (typical value `"EH/day"`, i.e. `price_sat` is sat per 1 EH/s per 1 day). Order amount is a sat budget, not a duration. ([trading FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/), [openapi MarketSettings schema](https://hashpower.braiins.com/api/openapi.yml))
4. Fees during beta are **0%** (continuous buy-side only). No placement/edit/cancel fees are currently enabled. ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
5. Hard numeric limits: min 1 PH/s when speed-limited; min budget 10 000 sats (with limit) / 100 000 sats (unlimited); max budget 1 BTC; max 10 open bids per subaccount. ([about page](https://academy.braiins.com/en/braiins-hashpower/about/), [basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
6. Anti-abuse pacing rules: price can be **decreased at most once per `min_bid_price_decrease_period_s`** (UI doc says 1 change per 10 min), speed-limit decrease has its own min period, bid has a grace period before cancel is allowed, and bids have `max_bid_idle_time_s` before being auto-dealt-with. All exposed via `/spot/settings`. ([openapi MarketSettings](https://hashpower.braiins.com/api/openapi.yml), [trading UI doc](https://academy.braiins.com/en/braiins-hashpower/trading/))
7. Destination is any Stratum V1 pool with `extranonce2_size >= 7`. Ocean/Datum Gateway listens on port 23334 using Stratum V1 with version rolling. So Braiins speaks V1 to Datum. No V2 involvement on the buyer-to-pool path. ([datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md), [basics FAQ pool-compatibility](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
8. **Owner-token API bypasses Telegram 2FA.** Empirically verified 2026-04-15: `POST /spot/bid` with an owner token returns the created bid directly — no Telegram confirmation required. The 2FA gate documented in Braiins' web UI does not apply to the REST path. ([empirical, see v1.1 below])
9. No withdrawals: Braiins Hashpower is non-custodial-style funds but one-way — deposits can only be spent on hashrate. Operator must size the monthly wallet top-up against the monthly budget ceiling and treat any unused balance as "parked" rather than withdrawable. ([about page](https://academy.braiins.com/en/braiins-hashpower/about/), [account FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))
10. Payout observation is fully decoupled from Braiins: block rewards come from Ocean (via TIDES), sent to the BTC payout address that Datum encoded in coinbase. Observable via standard `bitcoind` RPC (`listreceivedbyaddress`, `listunspent`, or ZMQ + descriptor wallet) on the Umbrel node. Nothing Braiins-side is involved. ([datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md), [Ocean DATUM origins](https://ocean.xyz/docs/datum))

Gaps (need live confirmation with a real owner token, or missing entirely):
- Exact numeric values of `bid_grace_period_s`, `ask_grace_period_s`, `min_bid_price_decrease_period_s`, `min_bid_speed_limit_decrease_period_s`, `max_bid_idle_time_s`, `tick_size_sat`, `min_bid_price_sat`, `max_bid_price_sat`. `/spot/settings` requires a valid API token and the demo token returns 401. User must hit it once after signup and we then cache it.
- Documented rate limits per endpoint. The API doc says HTTP 429 is returned when exceeded but does not enumerate thresholds. ([API doc](https://academy.braiins.com/en/braiins-hashpower/api/))
- No WebSocket / streaming endpoint appears in the OpenAPI spec — polling is the only documented model.
- Ramp-up and ramp-down latency values ("delivery momentum" language) are qualitative, not quantified. The API doc says cancel takes "a minute or two" to end delivery and settle. ([about page](https://academy.braiins.com/en/braiins-hashpower/about/))
- ~~Telegram 2FA on API mutations.~~ Disproven — owner-token API bypasses 2FA entirely (see §1 item 8 above).
- Bitcointalk and Reddit discussions were blocked at fetch level; no forum-sourced reliability anecdotes collected.

---

## 1. Braiins Hashrate Market / Hashpower API

### 1.1 Transport, base URLs, shape

- The public API is a **REST/JSON** API. No gRPC or GraphQL is exposed on the buyer-facing side. ([Braiins Academy — API doc](https://academy.braiins.com/en/braiins-hashpower/api/))
- Interactive Swagger UI: [`https://hashpower.braiins.com/api/`](https://hashpower.braiins.com/api/) — verified HTTP 200.
- OpenAPI 3.1.0 spec (machine-readable source of truth): [`https://hashpower.braiins.com/api/openapi.yml`](https://hashpower.braiins.com/api/openapi.yml) — verified 41 kB, 1285 lines.
- **Production base URL** for live calls: `https://hashpower.braiins.com/v1/` — verified live: `GET /v1/spot/stats` returns 200 and real data, `GET /v1/spot/settings` returns 401 without a key.
- The `servers:` block inside the OpenAPI spec advertises `https://hashpower.braiins.com/api/v1` but that path returns `404 no Route matched`. The working base is `/v1/` (no `api/` prefix). Spec and live routing disagree — autopilot must use `/v1/`. Evidence: both calls run in this session.

Note: a separate Braiins product, **Braiins OS Public API** on mining hardware (port 50051), **is** gRPC. That is irrelevant for hashrate buying and is about ASIC management. ([bos-plus-api README](https://github.com/braiins/bos-plus-api))

### 1.2 Authentication

- Single header: `apikey: <token>`. Case-sensitive lowercase. ([API doc](https://academy.braiins.com/en/braiins-hashpower/api/))
- Two token kinds: **Owner Token** (full trading), **Read-only Token** (market data + account view only). Both issued once at signup and never shown again. ([API doc](https://academy.braiins.com/en/braiins-hashpower/api/); [quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/); [account FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))
- There is also a special literal `demo` token that unlocks the UI with simulated data; it does **not** work against the REST API (verified: returns 401 on `/v1/spot/settings` with `apikey: demo`). ([basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Docs explicitly warn: "Never expose your API tokens in client-side code, public repositories, or logs. Use environment variables or secure secret management." ([API doc](https://academy.braiins.com/en/braiins-hashpower/api/))
- Signup requires Telegram verification against `@BraiinsBotOfficial` and email verification before tokens are issued. ([account page](https://academy.braiins.com/en/braiins-hashpower/account/))
- **Owner-token API bypasses the web-UI 2FA gate** — empirically confirmed (see executive summary item 8). An attacker with only the token can place, edit, and cancel bids via REST. ([account FAQ — token-compromised entry](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))

### 1.3 Endpoint inventory

Paths below are suffixes of `https://hashpower.braiins.com/v1`. All sourced from [`openapi.yml`](https://hashpower.braiins.com/api/openapi.yml).

Public (no `apikey` header required):

| Method | Path | Purpose |
|---|---|---|
| GET | `/spot/stats` | Global market stats: best bid, best ask, 24h volume, matched/available hashrate. Verified live. |
| GET | `/spot/orderbook` | Full order book snapshot: bids `[]` and asks `[]`. Verified live (128 bid levels, 8 ask levels). |
| GET | `/spot/trades` | Recent trades (timestamp, volume in millions of shares, avg price). Verified live (100 rows). |
| GET | `/spot/bars` | OHLCV candles, `aggregation_period` query param required (5m/15m/1h/4h/1d). Verified live. |

Authenticated (`apikey:` header required):

| Method | Path | Purpose |
|---|---|---|
| GET | `/spot/settings` | Market rules: tick size, min/max bid price, min/max budget, min/max speed limit, grace periods, decrease cooldowns, max bids per subaccount, hash-rate unit. Primary source of every runtime limit. |
| GET | `/spot/fee` | Current fee schedule by type (buy/sell/placement/cancel/edit). |
| GET | `/account/balance` | Per-subaccount balances: total, available, blocked, total deposited, total spent, total fees. |
| GET | `/account/transaction` | Off-chain tx log (deposits, locks, unlocks, market settlements). |
| GET | `/account/transaction/on-chain` | On-chain deposit/withdrawal log with txid and BTC address. |
| GET | `/spot/bid/current` | All active bids (status not terminal). |
| GET | `/spot/bid` | All bids (history + active), with query filters: `limit`, `offset`, `reverse`, `created_after`, `created_before`, `order_id`, `bid_status`, `exclude_active`, `upstream_url`, `upstream_identity`. |
| POST | `/spot/bid` | Place new bid. Body: `{cl_order_id?, dest_upstream{url,identity}, speed_limit_ph?, amount_sat, price_sat, memo?}`. Returns `{id, cl_order_id}`. |
| PUT | `/spot/bid` | Edit a bid. Body: `{bid_id XOR cl_order_id, new_amount_sat?, new_price_sat?, new_speed_limit_ph?, memo?}`. Note: `new_amount_sat` must be **greater than** current amount (only budget top-ups, no clawbacks). |
| DELETE | `/spot/bid` | Cancel bid. **Order ID goes in the JSON body** (`{order_id}` or `{cl_order_id}`), not the query string (empirical — query-string form returns 400). Returns `{affected_ids:{id:[]}}`. |
| GET | `/spot/bid/detail/{order_id}` | Full bid state: `bid`, `counters_estimate`, `counters_committed`, `state_estimate`, `last_network_failure`, `history[]`. |
| GET | `/spot/bid/speed/{order_id}` | Time series of delivered speed in PH/s, with `aggregation_period`, `sliding_window_size` (10/20/30 min), `datetime_from`, `limit`. |
| GET | `/spot/bid/delivery/{order_id}` | Time series of `shares_purchased_m`, `shares_accepted_m`, `shares_rejected_m`. |

All schemas are verbatim in [openapi.yml](https://hashpower.braiins.com/api/openapi.yml).

### 1.4 Key request/response shapes (units precise)

**`SpotPlaceBidRequest`** — `POST /spot/bid`:
- `dest_upstream.url`: string, example `"stratum+tcp://pool.net:7770"`. **Stratum V1 only, `extranonce2_size >= 7`.**
- `dest_upstream.identity`: string, pool username/worker.
- `speed_limit_ph`: double, optional, PH/s. Omit or 0 = unlimited.
- `amount_sat`: double, total order budget in satoshi.
- `price_sat`: double, price in satoshi **per hashrate unit per day**, where the unit is `hr_unit` returned by `/spot/settings` (typical value `"EH/day"`, i.e. `price_sat` is sat per 1 EH/s per day).
- `cl_order_id`, `memo`: optional.
Response `PlaceOrderResponse`: `{id: "B<int>", cl_order_id}`.
([openapi.yml — SpotPlaceBidRequest](https://hashpower.braiins.com/api/openapi.yml))

**`SpotEditBidRequest`** — `PUT /spot/bid`:
- `bid_id` xor `cl_order_id`.
- `new_amount_sat`: optional, must be **strictly greater** than current (top-up semantics).
- `new_price_sat`: optional.
- `new_speed_limit_ph`: optional, wrapped in an `OptionalDouble` object `{value: double}`; set value to `0` to disable the cap.
- `memo`: optional.
([openapi.yml — SpotEditBidRequest](https://hashpower.braiins.com/api/openapi.yml))

**`MarketSettings`** — `GET /spot/settings`:
- `status`: enum, `SPOT_INSTRUMENT_STATUS_ACTIVE` when the market is open.
- `tick_size_sat`: double, order book price decimalisation step (price must be a multiple).
- `hr_multiplier_log10`: int32, e.g. `18` → base unit is EH/day. `hr_unit`: human string e.g. `"EH/day"`.
- `min_bid_price_sat` / `max_bid_price_sat`: price bounds.
- `min_bid_amount_sat` / `max_bid_amount_sat`: budget bounds for unlimited-speed bids.
- `min_limited_bid_amount_sat` / `max_limited_bid_amount_sat`: budget bounds for speed-limited bids.
- `min_bid_speed_limit_ph` / `max_bid_speed_limit_ph`: speed-limit bounds in PH/s.
- `max_bid_idle_time_s`: max allowed idle before pause/close (docs gives example `604800` = 7 days).
- `bid_grace_period_s` / `ask_grace_period_s`: minimum time between bid creation and being allowed to cancel.
- `min_bid_price_decrease_period_s`: minimum time between consecutive price **decreases** on the same bid.
- `min_bid_speed_limit_decrease_period_s`: minimum time between consecutive speed-limit **decreases**.
- `min_limited_bid_duration_s`: minimum duration for speed-limited bids.
- `max_bids_per_subaccount`, `max_asks_per_subaccount`: hard concurrency caps.
- `created`: when settings were last published.
([openapi.yml — MarketSettings](https://hashpower.braiins.com/api/openapi.yml))

> Critical: the autopilot should call `/spot/settings` on startup and every N minutes, cache the values, and validate every order locally against them before hitting the API. Documented best practice: "Check `/spot/settings` first". ([API doc — Best Practices](https://academy.braiins.com/en/braiins-hashpower/api/))

**`SpotMarketBid`** (what you read back): includes `id`, `cl_order_id`, `subaccount`, `dest_upstream`, `speed_limit_ph`, `price_sat`, `status`, `is_current`, `created`, `last_updated`, `last_paused`, `last_pause_reason`, `fee_rate_pct`. ([openapi.yml — SpotMarketBid](https://hashpower.braiins.com/api/openapi.yml))

**`SpotMarketBidStatus`** enum:
`BID_STATUS_ACTIVE | BID_STATUS_PENDING_CANCEL | BID_STATUS_CANCELED | BID_STATUS_FULFILLED | BID_STATUS_PAUSED | BID_STATUS_FROZEN | BID_STATUS_CREATED` (plus `UNSPECIFIED`). Only `ACTIVE` and `PAUSED` mean "eligible" for matching in practice; see §3 for the PAUSED loop caveat. ([openapi.yml — SpotMarketBidStatus](https://hashpower.braiins.com/api/openapi.yml))

**`SpotMarketBidCounters`** (committed and estimate variants): `shares_purchased_m`, `shares_accepted_m`, `shares_rejected_m` (millions of shares), `fee_paid_sat`, `amount_consumed_sat`. The difference between `counters_committed` and `counters_estimate` is what separates settled vs predicted. ([openapi.yml — SpotMarketBidCounters](https://hashpower.braiins.com/api/openapi.yml))

**`SpotMarketBidState`** (expected-end-time source): `avg_speed_ph` (current delivered speed estimate), `progress_pct` (0..100, budget consumed), `amount_remaining_sat`. There is no explicit `eta_seconds` field — the UI computes ETA from `amount_remaining_sat / (avg_speed_ph * price_per_ph_per_sec)`. The UI column "ETA" documented in [trading page](https://academy.braiins.com/en/braiins-hashpower/trading/) is derived client-side. The autopilot should replicate this.
([openapi.yml — SpotMarketBidState](https://hashpower.braiins.com/api/openapi.yml); [trading UI doc — Order Book ETA](https://academy.braiins.com/en/braiins-hashpower/trading/))

**`SpotGetOrderBookResponse`**:
- `bids[]`: `{price_sat, amount_sat, hr_matched_ph, speed_limit_ph}`. Live sample (top-3), 2026-04-15 01:03 UTC: `price_sat=61012000, speed_limit_ph=5.90, hr_matched_ph=5.77` — the best bid is renting ~5.9 PH/s at ~6.1% BTC per EH per day.
- `asks[]`: `{price_sat, hr_matched_ph, hr_available_ph}`. Live sample: best ask `price_sat=44932000, hr_available_ph=71.03`.
([openapi.yml — SpotGetOrderBookResponse](https://hashpower.braiins.com/api/openapi.yml))

**`SpotGetMarketStatsResponse`**: `{status, volume_24h_m, best_bid_sat, best_ask_sat, last_avg_price_sat, hash_rate_matched_10m_ph, hash_rate_available_10m_ph}`. Live sample: `best_bid_sat=61012000, best_ask_sat=44899000, last_avg_price_sat=46309183, hash_rate_available_10m_ph=955.6, hash_rate_matched_10m_ph=563.3`. ~563 PH/s being matched across the whole market; buyer demand for the top PH/s in the retail/overpay range. ([openapi.yml — SpotGetMarketStatsResponse](https://hashpower.braiins.com/api/openapi.yml))

**`TradeBar`**: OHLCV in the same `price_sat` units, `volume` is in millions of shares. Live sample last hour `{open:47302293, close:47445229, vwap:47531094, volume:23592}`. ([openapi.yml — TradeBar](https://hashpower.braiins.com/api/openapi.yml))

**Cancellation**: `CancelResponse = {affected_ids: {id: [string]}}`, listing client order IDs successfully cancelled. Post-cancel the bid enters `BID_STATUS_PENDING_CANCEL` for 1-2 minutes while the hashrate delivery unwinds and final settlement occurs, then transitions to `BID_STATUS_CANCELED`. Unspent budget returns to `available_balance`. ([trading FAQ — cancel](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/); [openapi.yml — CancelResponse](https://hashpower.braiins.com/api/openapi.yml))

### 1.5 Error handling specifics

- HTTP status codes: 200 / 400 / 401 / 403 / 404 / 429 / 500. ([API doc — Error Handling](https://academy.braiins.com/en/braiins-hashpower/api/))
- 401 body: `{"message":"No API key found in request","request_id":"..."}` (verified live against `/v1/spot/settings`).
- 400 error details are returned via the **`grpc-message:` response header**, URL-encoded. Example from docs: `grpc-message: Bid%20duration%20too%20short%20(estimate:%209.29,%20limit:%201800)`. Autopilot **must** decode this header and surface it; the body alone does not contain the root cause. ([API doc — Error Response Format](https://academy.braiins.com/en/braiins-hashpower/api/))
- 403 on `/spot/bid/detail/{order_id}`: "Access forbidden — bid belongs to another user". ([openapi.yml](https://hashpower.braiins.com/api/openapi.yml))
- All errors include `request_id` in body — log this for any support ticket. ([verified live: request_id is present on every 401/404 observed this session])

### 1.6 Polling and freshness

- The UI polls the order book every 2 seconds. ([trading UI doc — Order Book Features](https://academy.braiins.com/en/braiins-hashpower/trading/))
- Settlement is hourly ("Fees are calculated and applied during the regular settlement intervals (hourly)"). ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
- `hash_rate_matched_10m_ph` is a **10-minute rolling estimate**, i.e. it lags. Do not treat it as an instantaneous measurement. ([openapi.yml — SpotGetMarketStatsResponse](https://hashpower.braiins.com/api/openapi.yml))
- `aggregation_period` enum for bars: `PERIOD_5_MINUTES | PERIOD_15_MINUTES | PERIOD_1_HOUR | PERIOD_4_HOURS | PERIOD_1_DAY`. ([openapi.yml — AggregationPeriod](https://hashpower.braiins.com/api/openapi.yml))

### 1.7 Undocumented / unofficial endpoints

None found that are not in the published OpenAPI. The Swagger UI at `/api/` is the exact spec; the live spec's `servers:` entry is the only known discrepancy (points at `/api/v1`, actual route is `/v1`). No unofficial wrappers or internal endpoints were observed in the HTML/JS of `hashpower.braiins.com/` inspected via curl.

### 1.8 Matching engine: pay-your-bid, not CLOB (load-bearing empirical finding)

**The Braiins Hashpower marketplace matches every bid at the bidder's own bid price (pay-your-bid / first-price), not at a uniform clearing price (the central-limit-order-book / second-price model where every winning bid pays the same matched ask).** This is the single most important pricing fact in the whole system - everything from the autopilot's overpay strategy to the dashboard's cost projections depends on it - and **it is not stated explicitly anywhere in Braiins' published documentation.** The OpenAPI spec, the trading UI doc, and the FAQ all use the language of an order book without committing to a matching rule. We had to derive it empirically.

**How we got here**:

1. **First reading (CLOB assumption).** The orderbook endpoint exposes both bid and ask sides with `price_sat` + `hr_*_ph`, the trading UI describes "matching" against the order book, and the OpenAPI uses the term `bid` / `ask` consistently. We initially built the autopilot for a CLOB-style matching engine: place bids at the cheapest-fillable price level, expect to be matched at that level's ask price, and accept that the bid price ≥ ask price was a "ceiling" rather than the actual price paid. The whole control-loop refactor on the `dev` branch from late March through mid April assumed this model.
2. **Empirical contradiction.** Observed live on the operator's account: a bid placed at `47,800 sat/PH/day` against a fillable ask at `46,500 sat/PH/day` consumed budget at exactly `47,800 sat/PH/day` (within rounding) - not `46,500`. The `counters_committed.amount_consumed_sat` deltas tracked the bid price, not the ask price. Cross-checked across multiple bid edits over several hours: every one of them charged at the bid level, never at the ask level. **There is no clearing price; bidders pay what they bid.**
3. **Strategic implication.** Under pay-your-bid, the autopilot's bid is *exactly* the price paid per delivered EH-day. Any `bid - ask` overpay is a real transfer to Braiins, not a CLOB-style "we never actually pay this" headroom. The control loop therefore must minimise that overpay while still landing above the cheapest-fillable ask with enough depth for the target hashrate. The v2 redesign (issue #53, "pay-your-bid controller") rebuilt the bidder around this insight: bid = `fillable_ask + small overpay`, with two hard ceilings above (the operator's `max_bid` and a dynamic cap relative to Ocean's hashprice). The default overpay started at 300 sat/PH/day in the v2.1 prototype but was raised to 1,000 sat/PH/day after live tuning - small enough not to materially shift cost, large enough to absorb single-tick orderbook jitter without burning the 10-minute price-decrease cooldown. The resulting bid price is the live, real price paid - which is also what the dashboard's hero PRICE card now displays (issue #69).

**Confidence**: high. This has been validated across hundreds of observed edit-and-deliver cycles since the v2 controller shipped (the AVG COST / PH DELIVERED stats card on the Status page is exactly this comparison: `Δamount_consumed_sat ÷ (delivered_ph × Δt)`, and it tracks the bid price within metering noise on every range we've checked).

**Why this matters going forward**: the entire pricing model in §2 below assumes pay-your-bid. If Braiins ever changes the matching engine to clearing-price-CLOB, **every line of the autopilot's bid-strategy code is wrong**. We should not assume this is a stable invariant; the empirical observation should be re-checked at a few representative bids any time:
- a major Braiins API revision is announced;
- the autopilot's measured cost diverges meaningfully from its bid price after a deploy;
- a new market region or product launches under the same domain.

A regression test for this would be valuable: a daily background check that compares `Δconsumed_sat / (delivered_ph × Δt)` to the bid price for the previous day, and alarms (in the future, see issue #18 / #41 status) if they diverge by more than a few sat/PH/day.

---

## 2. Cost & fee structure

### 2.1 Pricing units — be precise

- The market's base price unit is **`price_sat` per `hr_unit`**, where `hr_unit` is returned by `/spot/settings`. With the default market multiplier `hr_multiplier_log10 = 18`, `hr_unit = "EH/day"`, so `price_sat` means **satoshis you pay for 1 EH/s of delivered hashrate, delivered for 1 day**. ([openapi.yml — MarketSettings.hr_unit](https://hashpower.braiins.com/api/openapi.yml))
- Worked example from Braiins: price 0.45 BTC/EH/day = 45 000 000 sat/EH/day, so renting 1 PH/s for 24 hours costs 45 000 sat (0.00045 BTC). ([trading FAQ — How is price calculated](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- The platform's three UI display formats (for humans, not API): `BTC/EH/day` (default), `sats/PH/day` (retail-friendly), `USD/EH/day` (fiat reference). Internally, API pricing stays in `price_sat` per `hr_unit` as above. ([trading page — Currency Display](https://academy.braiins.com/en/braiins-hashpower/trading/))
- Budget (`amount_sat`) is total sats you're willing to spend. There is **no duration field** on a bid — the bid runs until its budget is consumed or it is cancelled. The "duration" you experience is implied by `amount_sat / (speed_limit_ph * price_per_ph_per_day)`. ([openapi.yml — SpotPlaceBidRequest](https://hashpower.braiins.com/api/openapi.yml); [trading FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- UI example of tick size from a community prior-art tool: 1000 sat/EH/day (confirm against `tick_size_sat` at runtime, it can change). ([counterweightoperator/hashbidder README](https://raw.githubusercontent.com/counterweightoperator/hashbidder/master/README.md))
- Live sample of market prices (2026-04-15 01:00 UTC): best ask ~44 899 000 sat/EH/day (~44 899 sat/PH/day). Last VWAP ~47 531 sat/PH/day. At 1 PH/s target and 47 500 sat/PH/day, ~1.425 M sat/month = **~0.01425 BTC per month for 1 PH/s sustained**. ([live `/v1/spot/stats` and `/v1/spot/bars`](https://hashpower.braiins.com/api/openapi.yml))

### 2.2 Fees — current schedule

- Advertised Spot Bid Fee during the BETA: **0%**. ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
- Applied *continuously* on the amount being settled each hour (post-beta may change). ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
- The fee **type taxonomy** in the API covers: `SPOT_FEE_TYPE_BUY`, `SPOT_FEE_TYPE_SELL`, `SPOT_FEE_TYPE_PLACEMENT`, `SPOT_FEE_TYPE_CANCEL`, `SPOT_FEE_TYPE_EDIT`. All of these exist as enum values in `SpotMarketFeeType`, meaning Braiins has reserved schema slots for per-action fees **even though only BUY is currently charged**. The autopilot MUST:
  1. Poll `/spot/fee` regularly.
  2. Not hardcode zero fees. Especially not zero edit/cancel fees — those would materially punish an aggressive autopilot.
  ([openapi.yml — SpotMarketFeeType and FeeSpec](https://hashpower.braiins.com/api/openapi.yml); [fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
- The per-bid `fee_rate_pct` field lives on `SpotMarketBid` — so fee is captured on the bid at creation time (no surprise mid-bid fee changes). ([openapi.yml — SpotMarketBid](https://hashpower.braiins.com/api/openapi.yml))

No maker/taker distinction. It's a bid-only market (asks are not user-submitted; see §2.4). Continuous pay-as-you-hash pricing model, not a scheduled auction. ([blog post — "Pay-as-you-hash pricing"](https://braiins.com/blog/buy-bitcoin-hashrate-introducing-braiins-hashpower))

### 2.3 Minimum order sizes

| Dimension | With speed limit | Unlimited speed |
|---|---|---|
| Min budget | **10 000 sats** | **100 000 sats** |
| Min speed | 1 PH/s | n/a |
| Max budget | 1 BTC | 1 BTC |
| Max open bids per subaccount | 10 | 10 |

([about page — Market Parameters](https://academy.braiins.com/en/braiins-hashpower/about/); [basics FAQ — bid limits](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/); [openapi.yml — MarketSettings](https://hashpower.braiins.com/api/openapi.yml))

Additional minima from the API schema:
- `min_limited_bid_duration_s`: minimum duration for a speed-limited bid (exact value only observable with an owner token against `/spot/settings`; the docs' example error message "limit: 1800" suggests **30 minutes** for at least one class of bid, but this is not authoritative until observed live). ([openapi.yml — MarketSettings.min_limited_bid_duration_s](https://hashpower.braiins.com/api/openapi.yml); [API doc — error example](https://academy.braiins.com/en/braiins-hashpower/api/))

### 2.4 How delivery works — who routes whose shares

- Braiins Hashpower is a **bid-only** market. Users place buy orders. Miners do **not** place ask orders on the marketplace directly; Braiins aggregates the supply side and decides which shares go where. "Currently, Braiins Hashpower is a buying platform only. Miners cannot directly list their hashrate for sale on the marketplace." ([basics FAQ — Can miners sell](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Matching algorithm is **price-then-age**, with any bid edit resetting the bid's age. ([about — Order Matching](https://academy.braiins.com/en/braiins-hashpower/about/); [basics FAQ — How does order matching work](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- "Higher-priced bids are matched first. Among bids at the same price, older bids have priority. Any modification to a bid makes it younger in the queue." ([basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Hashrate delivery is **continuous and reallocating**: "Hashrate delivery can shift between orders if a higher-priced or older bid becomes eligible. An order currently receiving hashrate may lose delivery if outbid." ([basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Latency from bid to first shares: not quantified in docs, but described as "near-instant" and with "delivery momentum" on ramp-up. "Hashrate delivery has inherent latency. Ramp-up takes some time when a bid starts matching, and when a bid is terminated or runs low on budget, delivery slows down before the budget is fully consumed." ([about — Key Limitations](https://academy.braiins.com/en/braiins-hashpower/about/))
- On cancel, "it takes a minute or two to end delivery and settle." ([about — Key Limitations](https://academy.braiins.com/en/braiins-hashpower/about/))
- Settlement cadence: **hourly** settlement intervals. Fees (when non-zero) are deducted at each settlement. ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/))
- "Your budget is consumed based on hashrate delivered and price (settled hourly)." ([trading FAQ — What happens when my bid is matched](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- Rejected shares are still paid for (0.05% baseline rejection is normal): "The buyer takes responsibility for the quality and configuration of their target pool. If your pool rejects shares due to misconfiguration, stale work, or other issues, you still pay for the hashrate delivered." ([trading FAQ — Do I pay for rejected hashrate](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))

Operational implication for the autopilot: "good bid placement" is essentially **outbidding the N-th served bid by one tick** — exactly what the prior-art hashbot tools do (see §6). A bid below the current matching threshold simply sits idle; it doesn't fail.

### 2.5 No withdrawals

- "The platform is non-custodial. You are expected to spend your funds on buying hashrate. In case you wish to exit the platform completely contact our Support for arrangements." ([about page](https://academy.braiins.com/en/braiins-hashpower/about/); [account FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))
- Hard consequence for the autopilot budget policy: any sat sent to the Braiins deposit address is effectively earmarked for hashrate spend. Top-ups should match expected monthly burn, not be front-loaded for a year.
- Deposits require **3 blockchain confirmations**, and are **screened** for compliance; suspicious deposits may be withheld for up to 48 business hours or returned. ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/); [account page](https://academy.braiins.com/en/braiins-hashpower/account/))

---

## 3. Abuse / rate-limiting / operational rules

### 3.1 HTTP rate limiting

- The API doc explicitly mentions `429 Too Many Requests — Rate limit exceeded` as a documented status. ([API doc — HTTP Status Codes](https://academy.braiins.com/en/braiins-hashpower/api/))
- Actual limits **per endpoint per minute are not published**. Best-practice language: "Monitor your rate limits: Track usage to avoid hitting limits" and "Implement retry logic with exponential backoff". ([API doc — Best Practices](https://academy.braiins.com/en/braiins-hashpower/api/))
- UI polls `/spot/orderbook` every 2 seconds. An autopilot polling at that cadence is clearly within whatever tolerance the platform has for its own UI. ([trading UI doc](https://academy.braiins.com/en/braiins-hashpower/trading/))
- Gap: no `X-RateLimit-*` headers are documented. The autopilot should record what `429` responses look like when first observed and tune from that.

### 3.2 Order-edit / velocity limits ("the 10-edits-per-hour question")

The Braiins docs do **not** use the phrase "10 edits per hour". What they do document are **per-direction cooldowns on bid modifications**, exposed through `/spot/settings`:

- `min_bid_price_decrease_period_s`: "Price is allowed to be decreased only when this period passes since last decrease (in seconds)." ([openapi.yml — MarketSettings](https://hashpower.braiins.com/api/openapi.yml))
- `min_bid_speed_limit_decrease_period_s`: same idea for speed limit. ([openapi.yml](https://hashpower.braiins.com/api/openapi.yml))
- UI guidance confirms one specific published number: **"Note: there is a limit on price decreases (1 change every 10 minutes)"** — this is the limit on dropping your bid price, not a generic edit limit. ([trading UI doc — Move Bid section](https://academy.braiins.com/en/braiins-hashpower/trading/); same phrasing in [trading FAQ — Overbid feature](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- **Price increases are not cooldown-gated** in the docs. Neither are budget top-ups.
- Grace period before cancel: `bid_grace_period_s`. Exact value not published; must be read from `/spot/settings`. ([openapi.yml](https://hashpower.braiins.com/api/openapi.yml))
- Any edit resets the bid's age in the priority queue, so rapid edits are self-penalising even without an explicit velocity cap — they move you to the back of the line at your price tier. ([basics FAQ — How does order matching work](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/); [about — Order Matching](https://academy.braiins.com/en/braiins-hashpower/about/))
- Community prior art (hashbidder) exposes this as per-bid cooldowns ("Per-bid price/speed cooldowns are respected") and suggests 5 bids in parallel to work around them when running every 10 minutes — implying real-world cooldowns are in the ~minutes range. ([counterweightoperator/hashbidder README](https://raw.githubusercontent.com/counterweightoperator/hashbidder/master/README.md))

Bottom line on rate rules: the user's mental model of "10 edits per hour" is close to the published **1 decrease per 10 minutes** rule on price. Increases are freer but still reset age. The autopilot needs per-bid cooldown tracking keyed on direction of change.

### 3.3 Order velocity / concurrency

- Maximum 10 open bids per subaccount. ([openapi.yml — max_bids_per_subaccount](https://hashpower.braiins.com/api/openapi.yml); [basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Max idle time per bid: `max_bid_idle_time_s` — if a bid sits without any matching for too long, the system will act on it (likely pause/cancel). Docs example: "For example 7 days = 604800." ([openapi.yml — MarketSettings.max_bid_idle_time_s](https://hashpower.braiins.com/api/openapi.yml))
- Minimum duration for speed-limited bids: `min_limited_bid_duration_s`. Enforced server-side with an explicit error message format (see §1.5).
- For the autopilot's 1 PH/s target: trivially within the 10-open-bid cap. Plenty of headroom for "place-5-bids-laddered-across-prices" strategies like counterweightoperator/hashbidder does. ([hashbidder README](https://raw.githubusercontent.com/counterweightoperator/hashbidder/master/README.md))

### 3.4 Price bounds and tick size

- `tick_size_sat`: the price decimalisation step. UI doc: "Price values are automatically rounded to the market's tick size. You'll be notified if your entered price is adjusted." ([trading UI doc](https://academy.braiins.com/en/braiins-hashpower/trading/))
- `min_bid_price_sat` / `max_bid_price_sat`: hard price bounds. Live values require an owner token.
- Community evidence: as of writing, tick is "1000 sat/EH/Day" per [hashbidder](https://raw.githubusercontent.com/counterweightoperator/hashbidder/master/README.md) and "1 tick = 1,000 sat" per [m1xb3r/braiins-hashbot](https://raw.githubusercontent.com/m1xb3r/braiins-hashbot/main/README.md). Treat as likely-current, verify live.

### 3.5 Anti-abuse policy mentions

- Token compromise scenario: an attacker with the owner token has full API access (create, edit, cancel). No withdrawals possible — funds can only be spent on hashrate. ([account FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))
- Deposit screening: "deposits flagged as suspicious may be withheld for manual review... In rare cases, funds may be returned to the sender address." ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- "Always deposit from your own wallet, not from an exchange or other custodial service." ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- Pool validation at bid-create time: extranonce2_size check + `mining.authorize` check. Invalid worker names are rejected for pools that correctly authorise; others silently consume hashrate. ([trading FAQ — pool URL rejected](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/); [basics FAQ — pool compatibility](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- Paused/Active loop: if the Datum endpoint serves shares below 65 536 difficulty, the bid will oscillate Paused ↔ Active and deliver poorly. Autopilot should surface `last_pause_reason` and alert on oscillation. ([trading FAQ — stuck in Paused/Active loop](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))

### 3.6 Terms & policies / compliance

- Top-level T&S link: [`https://academy.braiins.com/en/terms-and-policies/`](https://academy.braiins.com/en/terms-and-policies/) — full text not captured this sprint; check for any explicit automation/abuse clauses before running a high-frequency autopilot in production. (**Gap** — the page is served by the same Gatsby SPA; text-mining was not done for this sprint.)
- Braiins Pool has a published SOC 2 Type 2 compliance posture (per a blog post linked from the intro article), which implies they take rate-limiting enforcement seriously; expect 429s to be real, not polite warnings. ([blog post list on intro page](https://braiins.com/blog/buy-bitcoin-hashrate-introducing-braiins-hashpower))

---

## 4. Datum + Stratum

### 4.1 What Datum is

- **DATUM** = *Decentralized Alternative Templates for Universal Mining*. An Ocean-developed mining protocol that lets miners (or, in this case, rented hashrate) build their own block templates on their own Bitcoin node, rather than letting the pool operator build templates. Ocean's goal: return block-template control to the party running the Bitcoin node. ([ocean.xyz — The Origins of DATUM](https://ocean.xyz/docs/datum))
- Ocean is the only DATUM-supporting pool at the time of writing, and DATUM was released specifically to run against Ocean's TIDES reward system. A 50% OCEAN fee discount is offered to DATUM-using miners as a decentralisation incentive. ([ocean.xyz/docs/datum](https://ocean.xyz/docs/datum))
- DATUM's own positioning vs Stratum V2: Luke Dashjr / Jason Hughes decided SV2 "wouldn't be a viable solution in the near term" and built DATUM as a purpose-built alternative. DATUM works **with Stratum V1 + ASICBoost version-rolling downstream**, and the DATUM-specific protocol **only on the gateway↔pool link**. ([ocean.xyz/docs/datum](https://ocean.xyz/docs/datum); [datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))

### 4.2 Runtime layout for a home setup

From the Ocean Datum setup guide and Rent Some Hash Umbrel guide:

1. Operator runs a fully synced Bitcoin node, **Bitcoin Knots recommended** (for richer template policy controls). ([ocean.xyz/docs/datum-setup](https://ocean.xyz/docs/datum-setup); [datum_gateway README — Node Configuration](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
2. Operator runs **DATUM Gateway** next to the node (same host or on a nearby LAN host). Dependencies: libcurl, libjansson, libmicrohttpd, libsodium. ([datum_gateway README — Requirements](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
3. The Gateway connects to Bitcoin Knots via RPC (GBT getblocktemplate), exposes a Stratum V1 endpoint on **TCP port 23334** that accepts miner-style connections with version-rolling/ASICBoost extensions, and talks to Ocean's DATUM Prime using a custom encrypted protocol over TCP. ([datum_gateway README — DATUM Protocol](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
4. `bitcoin.conf` on the node includes `blocknotify=killall -USR1 datum_gateway` (or an HTTP POST to `/NOTIFY` on the Gateway's admin port 7152 when on separate hosts/containers) so the Gateway gets immediate chain tip updates. ([datum_gateway README — bitcoin.conf](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
5. Recommended node config: `blockmaxsize=3985000`, `blockmaxweight=3985000`, `maxmempool=1000`, `blockreconstructionextratxn=1000000`. ([datum_gateway README — Node Configuration](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
6. For Umbrel specifically: install "Bitcoin Knots" from the Umbrel App Store, then install the "DATUM" app, let the installer wire DATUM to Knots, and port-forward 23334 from the router to the Umbrel box on TCP so Braiins can reach it from the internet. ([rentsomehash.com Umbrel guide](https://rentsomehash.com/guides/umbrel/))

### 4.3 What Braiins sends over the wire

- Braiins Hashpower's upstream connector speaks **Stratum V1** to the destination pool. Evidence: the extranonce2_size requirement (an SV1 concept), the pool-URL format `stratum+tcp://...`, and the `mining.authorize` probe. ([basics FAQ — pool compatibility](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/); [quick-start — Pool URL](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- Braiins requires the destination to have **extranonce2_size ≥ 7**. The public `stratum.braiins.com` pool itself advertises 6 but Braiins uses a dedicated internal node with the required size. NiceHash's pool, miningrigrentals, and "Public Pool" do NOT meet the requirement. ([basics FAQ — pool compatibility](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- DATUM Gateway on port 23334 is Stratum V1 with version-rolling. Community confirmation: Ocean's own "Get Started" page uses plain SV1 URLs; the Datum gateway README explicitly states "the DATUM Gateway supports communication with mining hardware using the Stratum v1 protocol with version rolling extensions (aka 'ASICBoost')." ([datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md); [ocean.xyz/getstarted](https://ocean.xyz/getstarted))
- Extranonce2_size on Datum Gateway: the community guide and all the prior-art tools point home users at Datum without flagging extranonce2_size issues, so Datum Gateway's default is understood to be ≥ 7. **Empirical check recommended** using the nc+jq snippet documented by Braiins: `(echo '{"id":1,"method":"mining.subscribe","params":[]}'; sleep 1) | nc your-datum-host 23334 | head -1 | jq -r '.result[2]'` — must return 7 or higher. ([basics FAQ — Manual Compatibility Check](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- What the autopilot fills into `dest_upstream`:
  - `url`: `stratum+tcp://<your-public-endpoint>:23334`
  - `identity`: `<your-BTC-payout-address>.<workername>` when `pool_pass_full_users=true` in Datum config (the default). If set to `false`, the payout address is the global `POOL_ADDRESS` configured in the Datum gateway, and the Braiins `identity` only carries the worker name. ([rentsomehash.com/guides/braiins-ocean](https://rentsomehash.com/guides/braiins-ocean/); [datum_gateway README — Template/Share Requirements](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))

### 4.4 Stratum V1 vs V2

- **Buyer-to-Braiins: opaque** — we place orders via HTTPS REST; whatever Braiins does internally to source hashrate is hidden.
- **Braiins-to-our-pool (Datum Gateway on 23334): Stratum V1** with version-rolling extensions. This is what our gateway must accept. ([datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md); [basics FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
- **Gateway-to-Ocean: DATUM protocol** (custom, encrypted), not SV1 or SV2. Pool coordinates payout split, does (currently) block validation; miner constructs the template. ([datum_gateway README — DATUM Protocol](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
- **Stratum V2** is the Braiins-/Bitmex-/Kpvarma-originated protocol at [stratumprotocol.org](https://stratumprotocol.org/) with the [sv2-spec](https://github.com/stratum-mining/sv2-spec) repo. Braiins Pool itself offers SV2 on port 3333 with URL-embedded pool pubkey (`stratum2+tcp://stratum.braiins.com:3333/...`), but **Braiins Hashpower's buyer-to-pool connector is V1-only as of the docs checked**. There is no mention of SV2 as a destination protocol option in any Hashpower doc. ([braiins-pool/stratum-v2-manual](https://academy.braiins.com/en/braiins-pool/stratum-v2-manual/); absence in [api](https://academy.braiins.com/en/braiins-hashpower/api/), [trading](https://academy.braiins.com/en/braiins-hashpower/trading/), [quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/) docs)
- Interop implication for this autopilot: **we do not need to care about SV2 at all**. The rented hashrate arrives at our Datum Gateway as SV1 shares, the Gateway translates into DATUM-protocol messages to Ocean, and that's that.

### 4.5 Pool-side risks to alert on

- Difficulty below 65 536: causes the Paused/Active oscillation. The Datum Gateway's minimum variable-difficulty setting on the SV1 side should be raised to 65 536+ for every Braiins-sourced worker, or a worker-suffix notation like `.worker+65536` used when supported. ([trading FAQ — stuck in Paused/Active loop](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- Stale work on the Datum side = paid-for shares that Ocean rejects = money down the drain. Minimise Datum ↔ Ocean and node-tip ↔ Datum latency: the `blocknotify` path from Bitcoin Knots to Datum must be reliable. ([datum_gateway README — Template/Share Requirements](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
- If the Datum gateway can't reach Ocean (connectivity, cert, etc.), by default "the Gateway will disconnect all stratum clients", which Braiins will interpret as a pool outage and pause the bid. ([datum_gateway README — Notes/Known Issues](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))

---

## 5. Payout observation

### 5.1 Where the money actually lands

- Ocean uses **TIDES** as its reward system. The "miners receive their share directly from the coinbase transaction of found blocks" model means **payouts are outputs in the coinbase transaction** of blocks Ocean finds, paid to the BTC address encoded in the coinbase by Datum at the time of template construction. ([ocean.xyz/docs/datum](https://ocean.xyz/docs/datum); [ocean.xyz — Origins of DATUM](https://ocean.xyz/docs/datum))
- Identifier used by Ocean to route payouts = **the BTC address the miner used as the username on the Stratum connection**, either the one encoded in the worker identity (default `pool_pass_full_users=true`) or the Datum-gateway-wide `POOL_ADDRESS` when that setting is false. ([ocean.xyz/getstarted — Supported address types](https://ocean.xyz/getstarted); [rentsomehash.com/guides/braiins-ocean](https://rentsomehash.com/guides/braiins-ocean/))
- Ocean also offers Lightning payouts for configured miners. Not relevant to us (we're optimising for settlement to our own node-owned L1 address for simple observability). ([ocean.xyz/getstarted — Lightning payouts](https://ocean.xyz/getstarted))

### 5.2 What the autopilot can observe locally

On the Umbrel Bitcoin node, assuming Bitcoin Knots with standard RPC:

- **`listreceivedbyaddress minconf includeEmpty includeWatchonly [filter]`** to get total received at the payout address. Use a descriptor wallet and import the payout address as a watch-only descriptor on node setup. (General bitcoind RPC, documented at [bitcoincore.org/en/doc](https://bitcoincore.org/en/doc/); Knots is a fork so this is identical.)
- **`listtransactions`** / **`gettransaction txid`** to inspect deposits to the payout address as they confirm.
- **`listunspent 0 9999999 ["<addr>"]`** to see live UTXOs credited to that address.
- **ZMQ** (`zmqpubrawtx`, `zmqpubhashblock`, `zmqpubrawblock`): event-driven alternative to polling. Set `-zmqpubrawtx=tcp://127.0.0.1:28332` in bitcoin.conf, subscribe in the autopilot, inspect each tx for outputs paying the payout address. Lowest latency path. (Standard Bitcoin Core feature, [bitcoincore.org/en/doc/28.0.0/rpc/zmq/getzmqnotifications/](https://bitcoincore.org/en/doc/).)
- **ScanTxOutSet** with a `addr(<payout>)` descriptor for one-shot lifetime accounting without a wallet index.
- An **Electrum server (ElectrumX / electrs / Fulcrum)** or **Esplora** instance on Umbrel is another path — the Electrum protocol's `blockchain.scripthash.get_history` gives you the same data. Umbrel ships Electrs as an installable app. Relevant if the autopilot wants a query-by-scripthash path without running its own indexer logic.

Recommended design: rely on `bitcoind` RPC on the LAN. ZMQ `hashblock` → trigger a lookup of the new block's coinbase tx → check its outputs → credit if one matches the configured payout address. This detects the "we actually won a block" event at the earliest possible moment (as soon as our node has seen the block from the network).

### 5.3 What's **not** observable from Ocean/Braiins directly

- Ocean has a public dashboard at [ocean.xyz/stats](https://ocean.xyz/stats) with per-address stats. There is **no documented Ocean public API** observed in the docs directory (`/docs/*`). The "Check your miner's stats page" flow is UI-only per Ocean's [getstarted](https://ocean.xyz/getstarted) page.
- Braiins has `/spot/bid/delivery/{order_id}` for per-bid **share delivery** metrics — this tells you how many shares Braiins believes your paid-for hashrate pushed into the pool. It does **not** tell you about block finds or block rewards; for rewards, go via bitcoind. ([openapi.yml — SpotGetBidDeliveryHistoryResponse](https://hashpower.braiins.com/api/openapi.yml))

### 5.4 Net-result accounting (per SPEC §8)

- **Spend** = sum of `amount_consumed_sat` on all fulfilled/active bids (from `/spot/bid` + `/spot/bid/detail/{order_id}`) plus total locked funds that never unlocked back to available balance. Alternatively derivable as `total_deposited_sat - available_balance_sat - blocked_balance_sat` over time, via `/account/balance`. ([openapi.yml — AccountBalance schema](https://hashpower.braiins.com/api/openapi.yml))
- **Income** = sum of coinbase-tx outputs credited to the payout address on the Umbrel node, captured via bitcoind.
- Both sides are denominated in sat. Valuation at time-of-receipt (for fiat PnL) would require pulling a BTC/USD price feed, which is outside scope per SPEC §2 non-goals (no external dependencies beyond listed systems). Options: skip fiat entirely, or pull from the already-present Braiins "hashprice in USD" field as a convenience (displayed in the UI; not in the OpenAPI directly).

---

### 5.4 BIP 110 signaling detection (#94)

Block headers carry a 32-bit `version` field. Under BIP 9 deployments the top 3 bits are `0b001` and bits 0-28 are signaling bits for in-flight soft forks. **BIP 110** ("Reduced Data Temporary Softfork") — 1-year sunset, 55% lock-in threshold, max activation height around September 2026 — uses **bit 4**.

Detection: `((version >> 29) & 0b111) === 0b001 && (version & (1 << 4)) !== 0`.

Ocean's `/v1/blocks` response gives us `block_hash` and `height` per block but **not** the header `version` field. Two viable lookups for the version:

1. **bitcoind RPC** — `getblockheader <hash> true` returns the full decoded header (including `version`) in one call. Preferred whenever bitcoind RPC creds are available.
2. **Electrs** — `blockchain.block.header <height>` returns the raw 80-byte header as hex. First 4 bytes (little-endian) are the version field. Used as fallback when bitcoind isn't configured but electrs is.

**Storage**: `block_version_cache (block_hash PK, block_version INTEGER, fetched_at)`. Persistent because headers are immutable — once cached, never re-fetched. Negative-cache TTL (5 min) prevents hammering the node when a single lookup fails.

**Why a hash-keyed cache rather than `reward_events.block_version`**: the chart's block markers come from Ocean's `our_recent_blocks` (keyed by hash), not from `reward_events`. Hash-keyed storage matches the actual consumer's primary key. If a future feature needs a per-`reward_events` view, it can join to this cache.

## 6. Prior art

### 6.1 Braiins-specific automation (open source)

- **m1xb3r/braiins-hashbot** — "Automated Bitcoin hashrate arbitrage for the Braiins Hashpower Market. Self-hosted · Mobile-first dashboard · One-command Docker deploy · API key encrypted at rest." Two Python services in Docker (engine + FastAPI dashboard on :8000), polls every 2 minutes, strategy = track Nth-lowest active bid + configurable tick offset, auto-top-up. Uses Fernet AES-128 for API key encryption. MIT. **Single most relevant prior art for the specified use case.** [https://github.com/m1xb3r/braiins-hashbot](https://github.com/m1xb3r/braiins-hashbot) ([README](https://raw.githubusercontent.com/m1xb3r/braiins-hashbot/main/README.md))
  - Assessment: architectural model the autopilot should likely start from. Two-container split (engine/dashboard) with shared volume is a clean mirror of SPEC §4 (always-on box) + §10 (dashboard). 2-minute poll interval is conservative; the SPEC's "gap" reliability requirement might want tighter.

- **counterweightoperator/hashbidder** — CLI tool, Python (uv), TOML configs, two modes: manual declarative bids and **target-hashrate** mode which reads the operator's Ocean 24h hashrate, computes the deficit vs target, and splits bids across up to N parallel ladders with per-bid cooldown respect. Explicitly built for Ocean+Datum operators. Under-tested per its own disclaimers but very close to Remco's use case. [https://github.com/counterweightoperator/hashbidder](https://github.com/counterweightoperator/hashbidder) ([README](https://raw.githubusercontent.com/counterweightoperator/hashbidder/master/README.md))
  - Assessment: mine this repo's `hashbidder` source for the exact `dest_upstream` / price / speed logic and how it handles the API's per-bid cooldowns. Real-world proof that the Braiins API supports everything we need — this person has already done it.

- **ScubaAI/braiins-lean-v1** — Next.js 14 commercial orchestrator, Vercel KV, BTCPay integration, LEDN capital optimiser. Proprietary licence. Targeted at a different (premium mining) persona but the `lib/braiins-client.ts` is a TypeScript client for the same API. [https://github.com/ScubaAI/braiins-lean-v1](https://github.com/ScubaAI/braiins-lean-v1) ([README](https://raw.githubusercontent.com/ScubaAI/braiins-lean-v1/main/README.md))
  - Assessment: low-value as reference because it's proprietary and wraps a different business model, but useful as "TypeScript client structure sanity check" if we go TS.

### 6.2 Rent Some Hash — Braiins + DATUM + OCEAN guide

- [rentsomehash.com](https://rentsomehash.com/) — an operator-focused documentation site that walks through exactly Remco's stack: VPS / StartOS / Umbrel → DATUM → Braiins → OCEAN. The Umbrel guide at [rentsomehash.com/guides/umbrel](https://rentsomehash.com/guides/umbrel/) is the closest published playbook to the user's situation. Also hosts a calculator at [rentsomehash.com/calculator](https://rentsomehash.com/calculator/) that pulls live Braiins asks.
  - Assessment: not a bot, but the most useful *manual workflow* to mirror inside the autopilot. The "don't fund Braiins until your DATUM endpoint is stable" caveat is a hard prerequisite check the autopilot should enforce at startup.

### 6.3 NiceHash (not target market, but similar pattern)

- **nicehash/NiceHashBot (NHB3)** — Official NiceHash desktop bot, C# / .NET 4.7. Runs `runBot()` every minute: price adjust (up/down) + auto-refill at 90% consumption. ★180. [https://github.com/nicehash/NiceHashBot](https://github.com/nicehash/NiceHashBot) ([README](https://raw.githubusercontent.com/nicehash/NiceHashBot/master/README.md))
  - Assessment: canonical reference design for "lowest-price tracker + auto-refill" logic. The exact state machine pattern is applicable 1:1 to Braiins. Different API, same control loop.

- **grin-pool/nicehash_bot** (Python) — "Order price adjustment bot for Nicehash." Smaller but simpler as a reference. [https://github.com/grin-pool/nicehash_bot](https://github.com/grin-pool/nicehash_bot)
  - Assessment: tiny but clean; good for "what does the minimum viable adjustment loop look like."

- **alfredholmes/cryptobot** — "A bot to manage nicehash mining." 11★, small. [https://github.com/alfredholmes/cryptobot](https://github.com/alfredholmes/cryptobot)
  - Assessment: mostly of historical interest.

- **jgarzik/arbot** — "Cryptocurrency mining arbitrage bot." 11★, older. By Jeff Garzik. Now mostly of historical value. [https://github.com/jgarzik/arbot](https://github.com/jgarzik/arbot)
  - Assessment: not applicable — targets cross-coin arbitrage, not order-book maintenance.

- **KittyCatTech/bipcoin-nicehash-bot** — Niche altcoin bot. Not relevant.
- **Stevenans66/NiceHashBot-X** — "From buyers for buyers developed further." Fork. Potentially interesting but no meaningful documentation.

### 6.4 Stratum / SV2 reference implementations (not bots, but framework-level)

- **stratum-mining/stratum** (Stratum V2 protocol libraries, Rust, ★341) and **stratum-mining/sv2-spec** (★88) at [github.com/stratum-mining](https://github.com/stratum-mining). Useful only if a v2 ambition of the autopilot ever requires talking SV2 directly, which per §4 it does not.

### 6.5 Assessment summary

| Repo | Stack | Fit for this project | One-line verdict |
|---|---|---|---|
| m1xb3r/braiins-hashbot | Python + FastAPI + Docker | ★★★★★ | Almost the spec made real. Strong starting reference. |
| counterweightoperator/hashbidder | Python + uv + TOML | ★★★★ | Braiins+Ocean+Datum specialist, target-hashrate mode is exactly what SPEC §7 describes. |
| nicehash/NiceHashBot | C#/.NET | ★★★ | Canonical control-loop reference; wrong API but right shape. |
| ScubaAI/braiins-lean-v1 | Next.js/TS | ★★ | Proprietary, different persona; TS client structure may be useful. |
| rentsomehash.com | Doc site | ★★★★ | Manual workflow to mirror; not code. |
| Everything else NiceHash-related | various | ★ | Historical or niche. |
| stratum-mining/* | Rust | ★ | Out of scope unless V2 becomes buyer-facing. |

---

---

## 7. Implementation-relevant details the SPEC will care about

This section consolidates the operational points that the controller in
`docs/spec.md` will need to encode, each cited back to an authoritative source so
they survive review.

### 7.1 Deposit and funding flow

- Each Braiins Hashpower account is assigned a single BTC deposit address, shown in the Account tab UI. Copy-paste or QR. ([account page — Depositing Bitcoin](https://academy.braiins.com/en/braiins-hashpower/account/))
- **3 confirmations required** before credit to available balance. ([quick-start — Step 4](https://academy.braiins.com/en/braiins-hashpower/quick-start/); [account page](https://academy.braiins.com/en/braiins-hashpower/account/))
- Deposits are screened. Suspicious deposits may be held up to 48 working-hours for manual review, and in rare cases returned to sender. ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- "Always deposit from your own wallet, not from an exchange or other custodial service." ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- **`has_pending_withdrawal` is the only boolean to watch** on `AccountBalance` for any non-ordinary account state, per the OpenAPI. There is no `frozen_by_compliance` flag. An autopilot should NOT infer that absence of balance after a deposit means "frozen" without operator action. ([openapi.yml — AccountBalance](https://hashpower.braiins.com/api/openapi.yml))
- API fields on `AccountBalance` to light up SPEC §8 accounting:
  - `total_balance_sat = available + blocked`
  - `available_balance_sat` — spendable for new bids / top-ups
  - `blocked_balance_sat` — locked in active bids
  - `total_deposited_sat` — lifetime deposits
  - `total_withdrawn_sat` — lifetime withdrawals (will remain 0 given no-withdrawal policy)
  - `total_spot_spent_sat` — net spent on bid hashrate
  - `total_spent_spot_buy_fees_sat` / `total_spent_fees_sat` — paid fees, useful when fees go non-zero
  - ([openapi.yml — AccountBalance](https://hashpower.braiins.com/api/openapi.yml))
- API `/account/transaction` transaction types include `deposit`, `lock`, `unlock`, `fee`, `market` (market settlements). The `unlock` type is what you see when a bid terminates with unspent budget — that budget returns to `available_balance_sat`. Account events are free-text `details` per transaction; do not parse them semantically. ([openapi.yml — Transaction schema](https://hashpower.braiins.com/api/openapi.yml); [account page — Transaction Types](https://academy.braiins.com/en/braiins-hashpower/account/))

### 7.2 Pool compatibility — the operator's whitelist

Confirmed compatible (Braiins Academy's own list):
- Braiins Pool, Braiins Solo
- Antpool, Binance, CK pool, Cloverpool, EMCD, F2pool, Foundry, Lincoin, Luxor, **Ocean**, Poolin, SBI, Ultimus, ViaBTC

Confirmed incompatible (extranonce2_size too low):
- NiceHash
- Miningrigrentals
- Public Pool

([basics FAQ — Pool Compatibility](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))

For the user's stack: Ocean is explicitly on the compatible list, and the
Datum Gateway at port 23334 is an Ocean-approved SV1-front-end. Good to go.

Special note on authorisation checks: Braiins runs `mining.authorize` at
bid-create time, but **authorisation-check accuracy varies by pool**. Pools
documented to correctly authorise include: Braiins Pool, F2Pool, Luxor, CK
Pool, SBI. "Other pools may accept any username during the check but reject
it during actual mining." Datum/Ocean is not on the "correctly authorises"
list, so the autopilot **cannot rely on bid-creation success as proof that
the worker identity is valid on Ocean**. The autopilot must independently
verify post-creation that delivery actually begins (via
`/spot/bid/delivery/{order_id}` non-zero `shares_accepted_m`). ([basics FAQ
— How Compatibility Is Checked](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))

### 7.3 Worker identity conventions for Ocean + Datum

- **Default (`pool_pass_full_users=true` in Datum Gateway):** worker username = `<your-btc-address>.<workername>`. Rewards follow the BTC address in the identity. ([rentsomehash.com/guides/braiins-ocean](https://rentsomehash.com/guides/braiins-ocean/); [ocean.xyz/getstarted](https://ocean.xyz/getstarted))
- **Alternative (`pool_pass_full_users=false`):** identity carries only the worker name; rewards go to the Datum-gateway-wide `POOL_ADDRESS` setting regardless of what Braiins sends. Harder to observe per-bid attribution, and risks sending rewards to a different address than the one the autopilot is watching. Avoid unless the operator consciously chose this. ([rentsomehash.com/guides/braiins-ocean](https://rentsomehash.com/guides/braiins-ocean/))
- Supported address types on Ocean: P2PKH (1…), P2SH (3…), Bech32 (bc1q…), Bech32m (bc1p… Taproot). ([ocean.xyz/getstarted](https://ocean.xyz/getstarted))

### 7.4 Difficulty floor — the 65 536 number

- **Recommended Stratum difficulty the Datum Gateway should serve for Braiins-sourced workers: 65 536.** Lower values cause the Paused ↔ Active oscillation. Worker suffix notation like `username.worker+65536` works on some pools; on Datum Gateway the operator sets a minimum vardiff directly in the gateway config. ([trading FAQ — Paused/Active loop](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))
- **Autopilot alert: watch `last_pause_reason` on every bid. If the same pause-reason recurs within an hour, fire a high-priority notification and auto-cancel to stop the bleed-through of share-count fees.** No direct evidence exists that paused-bid fees are charged, but rejection-rate language ("typically inherent rejection rate of approximately 0.05%") suggests that small oscillations don't zero-rate charges. ([trading FAQ — Do I pay for rejected hashrate](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/))

### 7.5 Share accounting — watch the two counters

Both `counters_estimate` and `counters_committed` are exposed on every bid:

- `shares_purchased_m` — shares Braiins validated as correctly worked (millions of shares)
- `shares_accepted_m` — shares the destination pool (Ocean) accepted
- `shares_rejected_m` — shares the destination pool rejected
- `fee_paid_sat` — fees paid to date on this bid
- `amount_consumed_sat` — cumulative BTC spend on this bid

The `_estimate` variant is the live running count; `_committed` is the most recent hourly settlement. ([openapi.yml — SpotMarketBidCounters + SpotGetBidDetailResponse](https://hashpower.braiins.com/api/openapi.yml))

Healthy-bid invariant: `shares_accepted_m / shares_purchased_m` should track
close to `1 - 0.0005` (the baseline 0.05% rejection). Any drop below ~99%
acceptance is a signal the Datum endpoint is latent/misconfigured.

### 7.6 Hashrate unit pedantry

The platform's ambiguous-in-practice unit convention, clarified:

> "On Braiins Hashpower, prices are typically quoted in sats/PH/day (satoshis per Petahash per day) or BTC/EH/day (Bitcoin per Exahash per day). It's not completely precise, but it's current market standard how to display hashrate units on marketplaces. Entirely correct would be BTC / EH/s / day meaning how many bitcoins does it cost to receive hashrate at 1 EH/s speed per 1 day."

([basics FAQ — What is hashrate and how is it measured](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))

So when converting for the UI:
- `price_sat` (API, with default `hr_unit="EH/day"`) == sat per 1 EH/s per 1 day
- To get sat per 1 PH/s per 1 day: divide `price_sat` by 1000
- To get BTC per 1 EH/s per 1 day: divide `price_sat` by 100 000 000

Example sanity check with the live best ask of 44 932 000 sat/EH/day (captured above): `44 932 000 / 1000 = 44 932 sat/PH/day`, or `0.45 BTC/EH/day`. At 1 PH/s target, one day costs 44 932 sat, one month (30.44 days) costs ≈ 1 367 000 sat ≈ 0.0137 BTC. That's the monthly budget order-of-magnitude to aim at.

### 7.7 ETA calculation — there is no server-side `eta_seconds`

The UI's "ETA" column is computed client-side from:

```
eta_seconds = amount_remaining_sat /
              (avg_speed_ph * price_per_ph_per_second)
```

where `price_per_ph_per_second` = `price_sat / 1000 / 86400` (given default `hr_unit` = EH/day).

`amount_remaining_sat` is exposed on `SpotMarketBidState.amount_remaining_sat`; `avg_speed_ph` on `SpotMarketBidState.avg_speed_ph`. ([openapi.yml — SpotMarketBidState](https://hashpower.braiins.com/api/openapi.yml); [trading page — Order Book ETA column](https://academy.braiins.com/en/braiins-hashpower/trading/))

**Implementation note for SPEC §9's "no gap greater than TBD seconds":** the autopilot should pre-place a successor bid once `eta_seconds < max(bid_grace_period_s, known_ramp_up_latency_s) + safety_margin_s` on the currently serving bid. Values for `bid_grace_period_s` and the ramp-up latency are gaps (see Executive Summary). Autopilot should surface both in the dashboard so they can be tuned after first empirical observation.

### 7.8 A minimal control loop, grounded in citations

Per-tick work (tick = 1 minute as a conservative starting point; UI refreshes every 2 s):

1. `GET /v1/spot/stats` + `GET /v1/spot/orderbook` → compute target price (e.g. best-ask + 1 tick, or Nth-lowest matched bid + 1 tick per hashbot strategy). ([trading UI — Order Book real-time](https://academy.braiins.com/en/braiins-hashpower/trading/); [m1xb3r/braiins-hashbot — strategy](https://raw.githubusercontent.com/m1xb3r/braiins-hashbot/main/README.md))
2. `GET /v1/spot/bid/current` → list active bids. ([openapi.yml — spotGetCurrentBids](https://hashpower.braiins.com/api/openapi.yml))
3. For each active bid: `GET /v1/spot/bid/detail/{order_id}` → delivery state and counters. ([openapi.yml — spotGetBidDetail](https://hashpower.braiins.com/api/openapi.yml))
4. For each active bid: compute ETA via §7.7. If ETA < threshold → place successor bid via `POST /v1/spot/bid` (respecting 10-open-bid cap). ([openapi.yml — spotPlaceBid](https://hashpower.braiins.com/api/openapi.yml))
5. If active bid is priced above market mid + safety margin → `PUT /v1/spot/bid` with a lower `new_price_sat`, **only if `min_bid_price_decrease_period_s` since last decrease has elapsed**. ([openapi.yml — SpotEditBidRequest + MarketSettings](https://hashpower.braiins.com/api/openapi.yml))
6. If active bid is stuck below the matching threshold (no `avg_speed_ph` > 0 for N minutes) → `PUT /v1/spot/bid` with higher `new_price_sat` (no cooldown on increases). ([openapi.yml — SpotEditBidRequest](https://hashpower.braiins.com/api/openapi.yml); [basics FAQ — matching](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/))
7. If `available_balance_sat < configured_runway_threshold` → alert. Never auto-spend below the configured floor. ([openapi.yml — AccountBalance.available_balance_sat](https://hashpower.braiins.com/api/openapi.yml))
8. If `last_network_failure` on any bid is recent → surface as a notification. The destination pool may have hiccupped. ([openapi.yml — SpotGetBidsResponseItem.last_network_failure](https://hashpower.braiins.com/api/openapi.yml))

Per-hour work:
- `GET /v1/spot/bid/delivery/{order_id}` for each active bid → accepted/rejected ratio (surfaced on the dashboard's DATUM panel as the `acceptance (1h)` row + `acceptance %` chart series). ([openapi.yml — spotGetBidDeliveryHistory](https://hashpower.braiins.com/api/openapi.yml))
- `GET /v1/account/balance` → refresh accounting. ([openapi.yml — getAccountBalances](https://hashpower.braiins.com/api/openapi.yml))
- `GET /v1/spot/fee` → re-check fee schedule; alert if non-zero fees appeared. ([openapi.yml — getFeeStructure](https://hashpower.braiins.com/api/openapi.yml))

Per-day work:
- `GET /v1/spot/settings` → refresh market rules cache. Settings could change as Braiins exits beta. ([openapi.yml — spotGetMarketSettings](https://hashpower.braiins.com/api/openapi.yml))
- `GET /v1/spot/bars?aggregation_period=PERIOD_1_DAY&limit=30` → 30-day VWAP, used in UI for budget forecasting. ([openapi.yml — spotGetMarketBars](https://hashpower.braiins.com/api/openapi.yml))
- `bitcoind listreceivedbyaddress` (or ZMQ `rawblock` subscriber) on the Umbrel node → detect block reward income since last check. (Standard Bitcoin Core RPC, [bitcoincore.org](https://bitcoincore.org/en/doc/).)

### 7.9 Secrets management

- The owner token is the crown jewel. Braiins docs say "Never expose your API tokens in client-side code, public repositories, or logs." ([API doc — Authentication](https://academy.braiins.com/en/braiins-hashpower/api/))
- Prior art reference: m1xb3r/braiins-hashbot uses Fernet (AES-128-CBC + HMAC-SHA256) encryption at rest with a machine-specific `master.key` stored in a Docker volume, overwritten with zeros before deletion, and a log-scrub filter to prevent accidental log leakage. Scrubs the token out of env vars and config files — key is entered once via the dashboard UI and stored encrypted. ([m1xb3r/braiins-hashbot README — Security](https://raw.githubusercontent.com/m1xb3r/braiins-hashbot/main/README.md))
- For our always-on box, the simplest equivalent: OS keyring (macOS Keychain, Linux `secret-tool` / `libsecret`), or a file encrypted with a box-specific key mounted at boot from a passphrase, plus a log filter that scrubs the token. SPEC §12 already flags this as open.

### 7.10 Things that can ruin the month

Grouped from the T&S/docs/FAQ as operational landmines:

- **Dynamic home IP.** Braiins does not allow changing `dest_upstream.url` on a live bid (confirmed via OpenAPI — `SpotEditBidRequest` has no url/identity field). If the Umbrel endpoint's public IP rotates after funding, the bid must be cancelled and a new one placed. Mitigation: DDNS hostname or static IP in front of Umbrel, per [rentsomehash.com/guides/umbrel](https://rentsomehash.com/guides/umbrel/).
- **Datum endpoint unreachable.** Gateway will disconnect stratum clients by default, Braiins will pause the bid. Extended outage → bid stays paused. Auto-cancel after N minutes of continuous pause is a reasonable SPEC §9 rule. ([datum_gateway README](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))
- **Deposit flagged for manual review.** Up to 48 working-hours lag. Alert operator; do not run with no runway assumption. ([quick-start](https://academy.braiins.com/en/braiins-hashpower/quick-start/))
- **Beta exit → non-zero fees.** Fees are hot-swappable from the platform's side; SpotMarketFeeType already models placement/edit/cancel fees. Autopilot must recompute per-action economics from live `/spot/fee` each tick. ([fees page](https://academy.braiins.com/en/braiins-hashpower/fees/); [openapi.yml — SpotMarketFeeType](https://hashpower.braiins.com/api/openapi.yml))
- **Telegram account lost.** Braiins account management requires the linked Telegram; if lost, contact support. API-based bid operations are unaffected. ([account FAQ](https://academy.braiins.com/en/braiins-hashpower/faqs/account/))
- **Pool's difficulty too low.** Oscillating Paused/Active without meaningful delivery, still paying through the nose for share time (see §7.4/§7.5).
- **Datum Gateway stale work.** Miner-side shares accepted, pool-side rejected due to latency; pay per share but land nothing in a block. Minimise Knots→Datum→Ocean round-trip. ([datum_gateway README — Notes/Known Issues](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md))

---

## Appendix A — Live API samples captured during this sprint

Verified 2026-04-14 / 2026-04-15 UTC from this workstation via `curl`:

```
GET https://hashpower.braiins.com/v1/spot/stats   (HTTP 200)
{
  "best_bid_sat": 61012000,
  "volume_24h_m": 17104337.942951,
  "best_ask_sat": 44899000,
  "last_avg_price_sat": 46309183.015733,
  "hash_rate_available_10m_ph": 955.63660969004,
  "status": "SPOT_INSTRUMENT_STATUS_ACTIVE",
  "hash_rate_matched_10m_ph": 563.2731365391
}

GET https://hashpower.braiins.com/v1/spot/orderbook   (HTTP 200)
128 bid levels, 8 ask levels. Top bid:  price_sat=61012000 speed_limit_ph=5.90 hr_matched_ph=5.77
                                Top ask: price_sat=44932000 hr_available_ph=71.03

GET https://hashpower.braiins.com/v1/spot/bars?aggregation_period=PERIOD_1_HOUR&limit=5   (HTTP 200)
Latest hour: open=47302293 close=47445229 vwap=47531094 volume=23592.86 high=47629277 low=47302293

GET https://hashpower.braiins.com/v1/spot/settings   (HTTP 401)  # requires apikey

GET https://hashpower.braiins.com/v1/spot/settings   with "apikey: demo"   (HTTP 401)
# Demo token does NOT work on REST, only in UI
```

Interpretation:
- Market is live: ~955 PH/s asked, ~563 PH/s actually matched over last 10 min — the matching algorithm is leaving ~41% of offered hashrate idle, presumably because bid prices don't clear.
- Price dispersion: best bid 61 M sat/EH/day vs best ask 44.9 M sat/EH/day → the best bid is overpaying by ~36% relative to the cheapest available supply, implying the top of the book is for priority buyers who want guaranteed delivery. The 1 PH/s target can almost certainly be filled anywhere in the range 45–48 M sat/EH/day (~ 45-48 sat/PH/day) based on the last-hour VWAP of 47.53 M sat/EH/day.

## Appendix B — Sources index

Canonical Braiins docs and API:
- [hashpower.braiins.com/](https://hashpower.braiins.com/) — marketplace UI
- [hashpower.braiins.com/api/](https://hashpower.braiins.com/api/) — Swagger UI (interactive)
- [hashpower.braiins.com/api/openapi.yml](https://hashpower.braiins.com/api/openapi.yml) — OpenAPI 3.1.0 spec, machine-readable
- [academy.braiins.com/en/braiins-hashpower/about/](https://academy.braiins.com/en/braiins-hashpower/about/)
- [academy.braiins.com/en/braiins-hashpower/api/](https://academy.braiins.com/en/braiins-hashpower/api/)
- [academy.braiins.com/en/braiins-hashpower/trading/](https://academy.braiins.com/en/braiins-hashpower/trading/)
- [academy.braiins.com/en/braiins-hashpower/quick-start/](https://academy.braiins.com/en/braiins-hashpower/quick-start/)
- [academy.braiins.com/en/braiins-hashpower/fees/](https://academy.braiins.com/en/braiins-hashpower/fees/)
- [academy.braiins.com/en/braiins-hashpower/account/](https://academy.braiins.com/en/braiins-hashpower/account/)
- [academy.braiins.com/en/braiins-hashpower/solo-mining/](https://academy.braiins.com/en/braiins-hashpower/solo-mining/)
- [academy.braiins.com/en/braiins-hashpower/faqs/basics/](https://academy.braiins.com/en/braiins-hashpower/faqs/basics/)
- [academy.braiins.com/en/braiins-hashpower/faqs/trading/](https://academy.braiins.com/en/braiins-hashpower/faqs/trading/)
- [academy.braiins.com/en/braiins-hashpower/faqs/account/](https://academy.braiins.com/en/braiins-hashpower/faqs/account/)
- [academy.braiins.com/en/braiins-pool/stratum-v2-manual/](https://academy.braiins.com/en/braiins-pool/stratum-v2-manual/)
- [academy.braiins.com/en/braiins-pool/hashrate-specification/](https://academy.braiins.com/en/braiins-pool/hashrate-specification/)
- [academy.braiins.com/en/terms-and-policies/](https://academy.braiins.com/en/terms-and-policies/) (Gap — not text-mined this sprint)
- [braiins.com/blog/buy-bitcoin-hashrate-introducing-braiins-hashpower](https://braiins.com/blog/buy-bitcoin-hashrate-introducing-braiins-hashpower)
- [github.com/braiins/bos-plus-api](https://github.com/braiins/bos-plus-api) — related but separate (miner-side gRPC)

Ocean / DATUM:
- [ocean.xyz/](https://ocean.xyz/)
- [ocean.xyz/docs](https://ocean.xyz/docs)
- [ocean.xyz/docs/datum](https://ocean.xyz/docs/datum) — The Origins of DATUM (Jason Hughes, 2024-09-29)
- [ocean.xyz/docs/datum-setup](https://ocean.xyz/docs/datum-setup) — DATUM Setup Guide (Ocean Team, 2024-10-18)
- [ocean.xyz/docs/templateselection](https://ocean.xyz/docs/templateselection)
- [ocean.xyz/getstarted](https://ocean.xyz/getstarted)
- [ocean.xyz/stats](https://ocean.xyz/stats)
- [github.com/OCEAN-xyz/datum_gateway](https://github.com/OCEAN-xyz/datum_gateway)
- [raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md](https://raw.githubusercontent.com/OCEAN-xyz/datum_gateway/master/README.md)

Stratum V2:
- [stratumprotocol.org/](https://stratumprotocol.org/)
- [stratumprotocol.org/specification/](https://stratumprotocol.org/specification/)
- [github.com/stratum-mining/sv2-spec](https://github.com/stratum-mining/sv2-spec)
- [raw.githubusercontent.com/stratum-mining/sv2-spec/main/00-Abstract.md](https://raw.githubusercontent.com/stratum-mining/sv2-spec/main/00-Abstract.md)

Prior art:
- [github.com/m1xb3r/braiins-hashbot](https://github.com/m1xb3r/braiins-hashbot)
- [github.com/counterweightoperator/hashbidder](https://github.com/counterweightoperator/hashbidder)
- [github.com/ScubaAI/braiins-lean-v1](https://github.com/ScubaAI/braiins-lean-v1)
- [github.com/nicehash/NiceHashBot](https://github.com/nicehash/NiceHashBot)
- [github.com/grin-pool/nicehash_bot](https://github.com/grin-pool/nicehash_bot)
- [github.com/alfredholmes/cryptobot](https://github.com/alfredholmes/cryptobot)
- [github.com/jgarzik/arbot](https://github.com/jgarzik/arbot)
- [rentsomehash.com/](https://rentsomehash.com/)
- [rentsomehash.com/guides/braiins-ocean/](https://rentsomehash.com/guides/braiins-ocean/)
- [rentsomehash.com/guides/umbrel/](https://rentsomehash.com/guides/umbrel/)
- [rentsomehash.com/calculator/](https://rentsomehash.com/calculator/)

Sources that were blocked / gaps:
- `reddit.com/r/Braiins`, `reddit.com/r/BitcoinMining`, `reddit.com/r/Bitcoin` — script access blocked by reddit's anti-bot (HTTP 403). Not available for this sprint.
- `bitcointalk.org` — search requires authenticated session. Not available for this sprint.
- Braiins T&S full text — served by Gatsby SPA; not text-mined in this pass.
- Live `/spot/settings` exact numeric values (decrease cooldowns, grace period, tick size, price bounds) — owner token required.
- Live `/spot/fee` per-action values beyond the documented "0% BUY during beta" — owner token required.

## Document history

| Version | Date       | Changes                                                                             |
|---------|------------|-------------------------------------------------------------------------------------|
| 1.0     | 2026-04-14 | Initial version                                                                     |
| 1.1     | 2026-04-16 | Empirical correction: owner-token API bids bypass Telegram 2FA; documented in §0.9. |
| 1.2     | 2026-04-16 | Empirical gotcha: Ocean TIDES worker identity must be `<btc-address>.<label>`. A bare label (no period) runs hashrate but credits zero shares to any payout address. Validated in Config page + first-run CLI. |
| 1.3     | 2026-04-16 | Empirical gotcha: Braiins orderbook `AskItem.hr_available_ph` is **aggregated capacity at that price level**, not unmatched supply. Existing matched orders at the same level still consume `hr_matched_ph` of it. A new bid can only claim `hr_available_ph − hr_matched_ph`. Observed live: four consecutive top-of-book ask levels each had `available == matched`, so apparent "cheapest available" was a wall of fully-booked supply. Depth-aware autopilot targeting now uses `unmatched = available − matched` (see `packages/daemon/src/controller/orderbook.ts`). |
| 1.4     | 2026-04-26 | **Major** empirical finding documented in §1.8: the Braiins matching engine is **pay-your-bid, not CLOB** - bidders pay what they bid, never a uniform clearing price matched against the cheapest ask. Discovered after a multi-week refactor on the `dev` branch built around the wrong CLOB assumption; the v2 controller (issue #53) rebuilt around the empirical model. This had not been documented anywhere in Braiins' own materials and was load-bearing for every cost figure in §2 onward. |
