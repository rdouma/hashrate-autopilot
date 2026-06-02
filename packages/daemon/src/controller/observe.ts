/**
 * observe() - read-only assembly of the inputs the controller needs for
 * this tick. Runs against Braiins + pool + SQLite; no mutating API calls.
 * The only DB write is a targeted **ledger reconciliation**
 * (`owned_bids.reconcileFromApi`), which aligns our local status/price
 * snapshot with what Braiins currently reports for bids we own.
 *
 * Failures:
 *   - Braiins API unreachable → `market` is null, `balance` is null,
 *     `owned_bids` defaults to [] (no active data). The tick still
 *     completes so pool-outage alerting and DB state still advance.
 *   - Pool unreachable → recorded on PoolHealth.
 *
 * Derived fields (actual_hashrate, below_floor_since) depend on the
 * previous tick; the controller passes them in via `previousBelowFloorSince`.
 */

import { cheapestAskForDepth } from './orderbook.js';
import type { BraiinsService } from '../services/braiins-service.js';
import type { DatumPoller } from '../services/datum.js';
import type { OceanClient } from '../services/ocean.js';
import { computePoolLuck } from '../services/pool-luck.js';
import {
  PoolHealthTracker,
  parsePoolUrl,
  type PoolProbeResult,
} from '../services/pool-health.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { OwnedBidsRepo, ReconcilableBid } from '../state/repos/owned_bids.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { RewardEventsRepo } from '../state/repos/reward_events.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import type {
  DatumSnapshot,
  MarketSnapshot,
  OwnedBidSnapshot,
  PoolHealth,
  State,
  UnknownBidSnapshot,
} from './types.js';

export interface ObserveDeps {
  readonly braiins: BraiinsService;
  readonly poolTracker: PoolHealthTracker;
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  /**
   * Used to compute the rolling-average inputs to the sustained
   * cheap-mode check (#50). Only hit when the operator has enabled
   * `config.cheap_sustained_window_minutes > 0`.
   */
  readonly tickMetricsRepo: TickMetricsRepo;
  /**
   * #108: persistent ledger of Ocean pool blocks. Per-tick observation
   * upserts the recent-blocks list returned by Ocean; the per-tick
   * 24h/7d counts feeding pool-luck come from this repo so a fresh
   * install with backfill plots historical luck correctly.
   */
  readonly poolBlocksRepo: PoolBlocksRepo;
  /**
   * #102: read-only access to `reward_events` for the paid_total_sat
   * cumulative metric. Optional - when payout-observer is not wired
   * (payout_source = 'none'), the column is left null and the chart
   * series degrades gracefully.
   */
  readonly rewardEventsRepo?: RewardEventsRepo;
  /**
   * Optional Datum Gateway poller. When present, invoked each tick
   * and the result goes into `state.datum`. When absent or its
   * `poll()` returns null, `state.datum` is null ("not configured").
   */
  readonly datumPoller?: DatumPoller;
  /**
   * Optional Ocean client. When present and `btc_payout_address` is
   * configured, each tick reads the operator's 5-min sliding-window
   * hashrate from Ocean's stats response (issue #36) - sourced from
   * the same cached `fetchStats` call the `/api/ocean` route uses,
   * so we don't fire two HTTP calls per tick against the same
   * endpoint.
   */
  readonly oceanClient?: OceanClient;
  /**
   * #89: BTC/USD oracle. When present, the latest snapshot is
   * captured on every tick and persisted to `tick_metrics.btc_usd_price`.
   * Optional - tick proceeds with btc_usd_price = null when the
   * oracle is off ('none' source) or hasn't published a value yet.
   */
  readonly btcPriceService?: {
    getLatest(): { usd_per_btc: number; source: string } | null;
  };
  readonly now: () => number;
}

export interface ObserveInputs {
  /** below_floor_since carried forward from the previous tick (or null). */
  readonly previousBelowFloorSince: number | null;
  /** Consecutive above-floor ticks carried forward from the previous tick. */
  readonly previousAboveFloorTicks: number;
  /** Manual-override-until timestamp from the controller, carried through. */
  readonly manualOverrideUntilMs: number | null;
  /** Break-even hashprice in sat/PH/day from Ocean stats (null if unknown). */
  readonly hashpriceSatPerPhDay: number | null;
  /**
   * One-shot operator override - forwarded into State.bypass_pacing for
   * decide() to skip its self-imposed patience / escalation timers.
   */
  readonly bypassPacing: boolean;
}

/**
 * Number of consecutive above-floor ticks required to clear the
 * `below_floor_since` timer. Debounces against transient `avg_speed_ph`
 * spikes caused by Braiins' lagged rolling average during bid-state
 * flickers (ACTIVE → non-ACTIVE → ACTIVE). At the default 60 s tick
 * cadence this is a 3-minute above-floor confirmation.
 */
export const FLOOR_DEBOUNCE_TICKS = 3;

interface ApiBid {
  braiins_order_id: string;
  price_sat: number;
  amount_sat: number;
  speed_limit_ph: number | null;
  avg_speed_ph: number;
  progress_pct: number;
  amount_remaining_sat: number;
  status: string;
  /** #89: persisted per tick on the primary owned bid only. */
  last_pause_reason: string | null;
  fee_rate_pct: number | null;
}

export async function observe(deps: ObserveDeps, inputs: ObserveInputs): Promise<State> {
  const tickAt = deps.now();

  const [runtime, config, ownedIds, ledgerRows] = await Promise.all([
    deps.runtimeRepo.get(),
    deps.configRepo.get(),
    deps.ownedBidsRepo.getIds(),
    deps.ownedBidsRepo.list(),
  ]);
  if (!config) throw new Error('config row missing - run setup CLI');
  if (!runtime) throw new Error('runtime_state row missing - daemon must initialize first');

  const lastPriceDecreaseByOrder = new Map(
    ledgerRows.map((r) => [r.braiins_order_id, r.last_price_decrease_at]),
  );

  // Braiins reads in parallel; individual failures downgrade to null.
  // Datum + Ocean polls run alongside - best-effort, never throw
  // out. Ocean is chart-only (never gates a decision); we read it
  // from the shared cached client so the `/api/ocean` HTTP handler
  // and this observe call share one underlying HTTP request per
  // cache TTL.
  const [marketSnapshot, balance, bidsResponse, datum, oceanStats] = await Promise.all([
    collectMarket(deps.braiins).catch((err) => logAndReturnNull('market', err)),
    deps.braiins.getBalance().catch((err) => logAndReturnNull('balance', err)),
    deps.braiins.getCurrentBids().catch((err) => logAndReturnNull('bids', err)),
    deps.datumPoller
      ? deps.datumPoller.poll().catch((err): DatumSnapshot | null => {
          logAndReturnNull('datum', err);
          return null;
        })
      : Promise.resolve<DatumSnapshot | null>(null),
    deps.oceanClient && config.btc_payout_address
      ? deps.oceanClient.fetchStats(config.btc_payout_address).catch((err) => {
          logAndReturnNull('ocean', err);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const ocean_hashrate_ph = oceanStats?.user_hashrate_5m_ph ?? null;
  const share_log_pct = oceanStats?.share_log_pct ?? null;
  // #89: extended capture from data sources we already poll. All
  // nullable - each source independently degrades to null on a
  // failed poll without aborting the tick.
  const network_difficulty = oceanStats?.pool.network_difficulty ?? null;
  const estimated_block_reward_sat = oceanStats?.pool.estimated_block_reward_sat ?? null;
  const pool_hashrate_ph = oceanStats?.pool.pool_hashrate_ph ?? null;
  const pool_active_workers = oceanStats?.pool.active_workers ?? null;
  const ocean_unpaid_sat = oceanStats?.unpaid_sat ?? null;
  // #102: cumulative on-chain payout total at this tick. Sum of every
  // non-reorged reward_events row up to tick_at. Null when the
  // payout-observer isn't wired (payout_source = 'none') so the
  // chart series degrades to "no on-chain data" rather than showing
  // a misleading flat zero line.
  const paid_total_sat = deps.rewardEventsRepo
    ? await deps.rewardEventsRepo
        .sumPaidUpTo(tickAt)
        .catch((err) => {
          logAndReturnNull('paid_total_sat', err);
          return null as number | null;
        })
    : null;
  // #92 (follow-up): pool block counts per tick. Same windowing
  // logic the /api/ocean route uses to render `blocks_24h` /
  // `blocks_7d` - moved here so the value gets snapshotted into
  // tick_metrics and the chart can plot historical luck.
  //
  // #108: counts come from the persistent `pool_blocks` table, not
  // from Ocean's per-tick recent_blocks slice. The slice is just the
  // upsert input; the table is the ground truth that survives daemon
  // restarts and covers the historical pre-install window via the
  // boot-time backfill.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const recent = oceanStats?.recent_blocks ?? [];
  if (recent.length > 0) {
    const valid = recent.filter((b) => b.timestamp_ms > 0 && b.height > 0);
    if (valid.length > 0) {
      await deps.poolBlocksRepo
        .upsertMany(
          valid.map((b) => ({
            height: b.height,
            block_hash: b.block_hash,
            timestamp_ms: b.timestamp_ms,
            total_reward_sat: b.total_reward_sat,
            subsidy_sat: b.subsidy_sat,
            fees_sat: b.fees_sat,
            worker: b.worker || null,
            username: b.username || null,
          })),
          tickAt,
        )
        .catch((err) => {
          logAndReturnNull('pool_blocks.upsert', err);
        });
    }
  }
  const pool_blocks_24h_count = oceanStats
    ? await deps.poolBlocksRepo.countSince(tickAt - DAY_MS).catch((err) => {
        logAndReturnNull('pool_blocks_24h_count', err);
        return null;
      })
    : null;
  const pool_blocks_7d_count = oceanStats
    ? await deps.poolBlocksRepo.countSince(tickAt - 7 * DAY_MS).catch((err) => {
        logAndReturnNull('pool_blocks_7d_count', err);
        return null;
      })
    : null;
  const pool_blocks_30d_count = oceanStats
    ? await deps.poolBlocksRepo.countSince(tickAt - 30 * DAY_MS).catch((err) => {
        logAndReturnNull('pool_blocks_30d_count', err);
        return null;
      })
    : null;
  // Trailing pool-hashrate averages over the same windows as the
  // block counts above. Stored on the tick row so the chart's luck
  // calc has a denominator with matching window semantics; without
  // this the denominator was a single-tick snapshot of a value that
  // routinely drifts 10-15% over the day, contaminating the luck
  // line with noise that has nothing to do with actual luck. The
  // queries hit the same `tick_metrics` rows being written to, so
  // they're cheap (indexed on tick_at) and degrade to null on a
  // brand-new install before any history exists.
  const [pool_hashrate_ph_avg_24h, pool_hashrate_ph_avg_7d, pool_hashrate_ph_avg_30d] = await Promise.all([
    deps.tickMetricsRepo
      .avgPoolHashratePhSince(tickAt - DAY_MS)
      .catch((err) => {
        logAndReturnNull('pool_hashrate_ph_avg_24h', err);
        return null;
      }),
    deps.tickMetricsRepo
      .avgPoolHashratePhSince(tickAt - 7 * DAY_MS)
      .catch((err) => {
        logAndReturnNull('pool_hashrate_ph_avg_7d', err);
        return null;
      }),
    deps.tickMetricsRepo
      .avgPoolHashratePhSince(tickAt - 30 * DAY_MS)
      .catch((err) => {
        logAndReturnNull('pool_hashrate_ph_avg_30d', err);
        return null;
      }),
  ]);
  // Pool luck (24h / 7d). Reads count_in_window / expected, but the
  // expected denominator extends with elapsed-since-last-block so
  // the line decays continuously between finds and matches the
  // OCEAN panel's count-vs-expected reading at the moment of each
  // find. See `services/pool-luck.ts` for the full derivation.
  // Block timestamps for pool-luck's elapsed-since-last-block math.
  // Pull from the persistent table over the 30d window (the broadest
  // of the three pool-luck windows), so the per-window slicing inside
  // computePoolLuck has the same data all three luck variants can rely
  // on. Falls back to the per-tick recent list if the repo query
  // fails for any reason.
  const blockTimestamps = oceanStats
    ? await deps.poolBlocksRepo
        .timestampsSince(tickAt - 30 * DAY_MS)
        .catch(() => recent.map((b) => b.timestamp_ms))
    : recent.map((b) => b.timestamp_ms);
  const pool_luck_24h = oceanStats
    ? computePoolLuck({
        tickAt,
        countInWindow: pool_blocks_24h_count,
        poolHashrateAvgPh: pool_hashrate_ph_avg_24h,
        networkDifficulty: network_difficulty,
        windowMs: DAY_MS,
        recentBlockTimestampsMs: blockTimestamps,
      })
    : null;
  const pool_luck_7d = oceanStats
    ? computePoolLuck({
        tickAt,
        countInWindow: pool_blocks_7d_count,
        poolHashrateAvgPh: pool_hashrate_ph_avg_7d,
        networkDifficulty: network_difficulty,
        windowMs: 7 * DAY_MS,
        recentBlockTimestampsMs: blockTimestamps,
      })
    : null;
  const pool_luck_30d = oceanStats
    ? computePoolLuck({
        tickAt,
        countInWindow: pool_blocks_30d_count,
        poolHashrateAvgPh: pool_hashrate_ph_avg_30d,
        networkDifficulty: network_difficulty,
        windowMs: 30 * DAY_MS,
        recentBlockTimestampsMs: blockTimestamps,
      })
    : null;
  const balanceAccount = balance?.accounts?.[0];
  const braiins_total_deposited_sat =
    typeof balanceAccount?.total_deposited_sat === 'number'
      ? balanceAccount.total_deposited_sat
      : null;
  const braiins_total_spent_sat =
    typeof balanceAccount?.total_spot_spent_sat === 'number'
      ? balanceAccount.total_spot_spent_sat
      : null;
  const btcSnapshot = deps.btcPriceService?.getLatest() ?? null;
  const btc_usd_price = btcSnapshot?.usd_per_btc ?? null;
  const btc_usd_price_source = btcSnapshot?.source ?? null;

  const apiBids = extractBids(bidsResponse);
  const owned_bids: OwnedBidSnapshot[] = [];
  const unknown_bids: UnknownBidSnapshot[] = [];
  const reconcilable: ReconcilableBid[] = [];

  for (const b of apiBids) {
    if (ownedIds.has(b.braiins_order_id)) {
      owned_bids.push({
        braiins_order_id: b.braiins_order_id,
        cl_order_id: null, // filled after M4.2 if needed on every tick
        price_sat: b.price_sat,
        amount_sat: b.amount_sat,
        speed_limit_ph: b.speed_limit_ph,
        avg_speed_ph: b.avg_speed_ph,
        progress_pct: b.progress_pct,
        amount_remaining_sat: b.amount_remaining_sat,
        amount_consumed_sat: Math.max(0, b.amount_sat - b.amount_remaining_sat),
        status: b.status,
        last_price_decrease_at: lastPriceDecreaseByOrder.get(b.braiins_order_id) ?? null,
        last_pause_reason: b.last_pause_reason,
        fee_rate_pct: b.fee_rate_pct,
      });
      reconcilable.push({
        braiins_order_id: b.braiins_order_id,
        status: b.status,
        price_sat: b.price_sat,
        amount_sat: b.amount_sat,
        speed_limit_ph: b.speed_limit_ph,
        amount_consumed_sat: Math.max(0, b.amount_sat - b.amount_remaining_sat),
      });
    } else {
      unknown_bids.push({
        braiins_order_id: b.braiins_order_id,
        price_sat: b.price_sat,
        amount_sat: b.amount_sat,
        speed_limit_ph: b.speed_limit_ph,
        avg_speed_ph: b.avg_speed_ph,
        status: b.status,
      });
    }
  }

  // Ledger reconciliation (targeted UPDATEs only; never inserts).
  if (reconcilable.length > 0) {
    try {
      await deps.ownedBidsRepo.reconcileFromApi(tickAt, reconcilable);
    } catch (err) {
      console.warn(`[observe] ledger reconciliation failed: ${(err as Error).message}`);
    }
  }

  // #243: primary-bid share counters snapshot. The bids LIST response
  // (`/spot/bid`) doesn't include `counters_committed` - the share
  // counters live on `/spot/bid/detail/{order_id}`. We make one extra
  // GET per tick for the primary bid only (lowest order_id from the
  // owned ledger, matching tick.ts's primary selection). Graceful
  // degradation on failure: null fields, tick proceeds.
  let primary_bid_shares_purchased_m: number | null = null;
  let primary_bid_shares_accepted_m: number | null = null;
  let primary_bid_shares_rejected_m: number | null = null;
  if (owned_bids.length > 0) {
    const primaryId = [...owned_bids]
      .sort((a, b) => a.braiins_order_id.localeCompare(b.braiins_order_id))[0]!.braiins_order_id;
    try {
      const detail = await deps.braiins.getBidDetail(primaryId);
      const counters = detail.counters_committed;
      if (counters) {
        primary_bid_shares_purchased_m =
          typeof counters.shares_purchased_m === 'number' ? counters.shares_purchased_m : null;
        primary_bid_shares_accepted_m =
          typeof counters.shares_accepted_m === 'number' ? counters.shares_accepted_m : null;
        primary_bid_shares_rejected_m =
          typeof counters.shares_rejected_m === 'number' ? counters.shares_rejected_m : null;
      }
    } catch (err) {
      console.warn(
        `[observe] getBidDetail(${primaryId}) failed: ${(err as Error).message}`,
      );
    }
  }

  // Pool probe (always run - we want outage visibility even if API is down).
  // Skip when no pool URL is configured (wizard completed without one).
  const poolProbe = config.destination_pool_url
    ? await deps.poolTracker.probe(parsePoolUrl(config.destination_pool_url))
    : { reachable: false, checked_at: Date.now(), latency_ms: null, error: 'no pool URL configured' } satisfies PoolProbeResult;
  if (!poolProbe.reachable && config.destination_pool_url) {
    const snap = deps.poolTracker.snapshot();
    console.warn(`[observe] pool probe failed (${snap.consecutive_failures} consecutive): ${poolProbe.error}`);
  }
  const pool: PoolHealth = config.destination_pool_url
    ? {
        reachable: poolProbe.reachable,
        last_ok_at: deps.poolTracker.snapshot().last_ok_at,
        consecutive_failures: deps.poolTracker.snapshot().consecutive_failures,
        error: poolProbe.error,
        latency_ms: poolProbe.latency_ms,
      }
    : { reachable: false, last_ok_at: null, consecutive_failures: 0, error: null, latency_ms: null };

  // ACTUAL delivered hashrate = sum of Braiins's `state_estimate.avg_speed_ph`
  // (already zeroed for non-ACTIVE bids during extraction). NOT
  // speed_limit_ph, which is just the cap and says nothing about fills.
  const actual_owned_ph = sumDeliveredPh(owned_bids);
  const actual_unknown_ph = sumDeliveredPh(unknown_bids);
  const actual_hashrate = {
    owned_ph: actual_owned_ph,
    unknown_ph: actual_unknown_ph,
    total_ph: actual_owned_ph + actual_unknown_ph,
  };

  // Cheap-mode sustained-window check (#50 / #160).
  //
  // Engagement semantics: every tick in the last `cheap_sustained_window_minutes`
  // minutes must have `(fillable_ask + overpay) < (threshold_pct / 100) × hashprice`.
  // I.e. the price we'd actually pay must be sustainedly below the threshold,
  // not the order book's cheapest level (best_ask is one tick's noise) and
  // not the windowed average (one outlier could pull the average below).
  //
  // The window also requires at least `cheap_sustained_window_minutes` ticks
  // of complete data - one tick per minute at the 60 s cadence. A 120 s gap
  // drops the count below that and engagement stays off; we'd rather miss
  // a genuine cheap-mode opportunity than fire on an incomplete window.
  const cheapWinMin = config.cheap_sustained_window_minutes;
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph;
  let cheap_mode_window: State['cheap_mode_window'] = null;
  if (cheapEnabled && cheapWinMin > 0) {
    const sinceMs = tickAt - cheapWinMin * 60_000;
    const agg = await deps.tickMetricsRepo
      .cheapModeWindowAggregates(
        sinceMs,
        config.overpay_sat_per_eh_day,
        config.cheap_threshold_pct,
      )
      .catch((err): Awaited<ReturnType<TickMetricsRepo['cheapModeWindowAggregates']>> => {
        logAndReturnNull('cheap_mode_window', err);
        return { ticks_total: 0, ticks_below: 0 };
      });
    const required = cheapWinMin;
    const engage = agg.ticks_total >= required && agg.ticks_below === agg.ticks_total;
    cheap_mode_window = {
      engage,
      ticks_below: agg.ticks_below,
      ticks_total: agg.ticks_total,
      ticks_required: required,
      threshold_pct: config.cheap_threshold_pct,
    };
  }

  // Depth-aware fillable anchor for decide() (#53). Cheapest price at
  // which the orderbook's unmatched supply covers target_hashrate_ph.
  // null propagates when the orderbook is missing/empty, and decide()
  // skips the tick rather than guessing.
  const fillable_ask_sat_per_eh_day =
    marketSnapshot !== null
      ? cheapestAskForDepth(
          marketSnapshot.orderbook.asks ?? [],
          config.target_hashrate_ph,
        ).price_sat
      : null;

  const floorCheck = computeBelowFloorSince(
    actual_hashrate.total_ph,
    config.minimum_floor_hashrate_ph,
    inputs.previousBelowFloorSince,
    inputs.previousAboveFloorTicks,
    tickAt,
    poolProbe,
    marketSnapshot !== null,
  );

  return {
    tick_at: tickAt,
    run_mode: runtime.run_mode,
    manual_override_until_ms: inputs.manualOverrideUntilMs,
    config,
    market: marketSnapshot,
    balance,
    owned_bids,
    unknown_bids,
    actual_hashrate,
    below_floor_since: floorCheck.below_floor_since,
    above_floor_ticks: floorCheck.above_floor_ticks,
    pool,
    datum,
    ocean_hashrate_ph,
    share_log_pct,
    network_difficulty,
    estimated_block_reward_sat,
    pool_hashrate_ph,
    pool_active_workers,
    braiins_total_deposited_sat,
    braiins_total_spent_sat,
    ocean_unpaid_sat,
    paid_total_sat,
    btc_usd_price,
    btc_usd_price_source,
    pool_blocks_24h_count,
    pool_blocks_7d_count,
    pool_blocks_30d_count,
    pool_hashrate_ph_avg_24h,
    pool_hashrate_ph_avg_7d,
    pool_hashrate_ph_avg_30d,
    pool_luck_24h,
    pool_luck_7d,
    pool_luck_30d,
    primary_bid_shares_purchased_m,
    primary_bid_shares_accepted_m,
    primary_bid_shares_rejected_m,
    last_api_ok_at: deps.braiins.getLastApiOkAt(),
    hashprice_sat_per_ph_day: inputs.hashpriceSatPerPhDay,
    fillable_ask_sat_per_eh_day,
    cheap_mode_window,
    bypass_pacing: inputs.bypassPacing,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectMarket(braiins: BraiinsService): Promise<MarketSnapshot> {
  const [stats, orderbook, settings, fee] = await Promise.all([
    braiins.getStats(),
    braiins.getOrderbook(),
    braiins.getSettings(),
    braiins.getFee(),
  ]);
  const best_bid_sat = orderbook.bids?.[0]?.price_sat ?? null;
  const best_ask_sat = orderbook.asks?.[0]?.price_sat ?? null;
  return { stats, orderbook, settings, fee, best_bid_sat, best_ask_sat };
}

function extractBids(bidsResponse: { items?: unknown[] } | null): ApiBid[] {
  if (!bidsResponse?.items) return [];
  const out: ApiBid[] = [];
  for (const raw of bidsResponse.items) {
    const item = raw as {
      bid?: {
        id?: string;
        price_sat?: number;
        amount_sat?: number;
        speed_limit_ph?: number | null;
        status?: string;
        last_pause_reason?: string;
        fee_rate_pct?: number;
      };
      state_estimate?: {
        avg_speed_ph?: number;
        progress_pct?: number;
        amount_remaining_sat?: number;
      };
    };
    const bid = item.bid;
    if (!bid?.id) continue;
    const status = bid.status ?? 'UNKNOWN';
    // Braiins's rolling `avg_speed_ph` lags - it stays non-zero for a
    // while even when instantaneous delivery is 0. For non-ACTIVE bids
    // (pending 2FA, paused, finished, etc.) the lag is misleading, so
    // we floor to 0. For ACTIVE bids we trust the value.
    const rawAvg = item.state_estimate?.avg_speed_ph ?? 0;
    const avg_speed_ph = status === 'BID_STATUS_ACTIVE' ? rawAvg : 0;
    out.push({
      braiins_order_id: bid.id,
      price_sat: bid.price_sat ?? 0,
      amount_sat: bid.amount_sat ?? 0,
      speed_limit_ph: bid.speed_limit_ph ?? null,
      avg_speed_ph,
      progress_pct: item.state_estimate?.progress_pct ?? 0,
      amount_remaining_sat: item.state_estimate?.amount_remaining_sat ?? bid.amount_sat ?? 0,
      status,
      last_pause_reason:
        bid.last_pause_reason && bid.last_pause_reason.length > 0
          ? bid.last_pause_reason
          : null,
      fee_rate_pct: typeof bid.fee_rate_pct === 'number' ? bid.fee_rate_pct : null,
    });
  }
  return out;
}

function sumDeliveredPh(bids: ReadonlyArray<{ avg_speed_ph: number }>): number {
  return bids.reduce((total, b) => total + (b.avg_speed_ph ?? 0), 0);
}

export interface FloorCheckResult {
  readonly below_floor_since: number | null;
  readonly above_floor_ticks: number;
}

/**
 * Maintain the below-floor timer with hysteresis.
 *
 * - If we can't tell (API unreachable, pool down), keep the previous
 *   values so a blip doesn't reset the clock or the counter.
 * - Below floor → start/continue the timer; reset the above-floor
 *   counter to 0.
 * - At-or-above floor → increment the above-floor counter (capped at
 *   `FLOOR_DEBOUNCE_TICKS`). Only clear `below_floor_since` once we've
 *   seen `FLOOR_DEBOUNCE_TICKS` consecutive above-floor ticks.
 *
 * Rationale: Braiins' `state_estimate.avg_speed_ph` is a rolling
 * average that lags real delivery. When a bid flickers through
 * non-ACTIVE → ACTIVE, the re-ACTIVE tick can inherit a stale lagged
 * value above floor even though instantaneous delivery is 0. Without
 * hysteresis, one such tick clears the timer and the escalation clock
 * effectively never fires. See issue #10.
 */
export function computeBelowFloorSince(
  actualHashratePh: number,
  floorPh: number,
  previous: number | null,
  previousAboveFloorTicks: number,
  now: number,
  poolProbe: PoolProbeResult,
  apiOk: boolean,
): FloorCheckResult {
  if (!apiOk || !poolProbe.reachable) {
    return {
      below_floor_since: previous,
      above_floor_ticks: previousAboveFloorTicks,
    };
  }
  if (actualHashratePh < floorPh) {
    return {
      below_floor_since: previous ?? now,
      above_floor_ticks: 0,
    };
  }
  const newCount = Math.min(previousAboveFloorTicks + 1, FLOOR_DEBOUNCE_TICKS);
  if (newCount >= FLOOR_DEBOUNCE_TICKS) {
    return { below_floor_since: null, above_floor_ticks: newCount };
  }
  return { below_floor_since: previous, above_floor_ticks: newCount };
}

function logAndReturnNull(label: string, err: unknown): null {
  console.warn(`[observe] ${label} read failed: ${(err as Error)?.message ?? err}`);
  return null;
}
