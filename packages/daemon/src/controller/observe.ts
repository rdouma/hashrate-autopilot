/**
 * observe() — read-only assembly of the inputs the controller needs for
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
import {
  PoolHealthTracker,
  parsePoolUrl,
  type PoolProbeResult,
} from '../services/pool-health.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { OwnedBidsRepo, ReconcilableBid } from '../state/repos/owned_bids.js';
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
   * Optional Datum Gateway poller. When present, invoked each tick
   * and the result goes into `state.datum`. When absent or its
   * `poll()` returns null, `state.datum` is null ("not configured").
   */
  readonly datumPoller?: DatumPoller;
  /**
   * Optional Ocean client. When present and `btc_payout_address` is
   * configured, each tick reads the operator's 5-min sliding-window
   * hashrate from Ocean's stats response (issue #36) — sourced from
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
   * One-shot operator override — forwarded into State.bypass_pacing for
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
  if (!config) throw new Error('config row missing — run setup CLI');
  if (!runtime) throw new Error('runtime_state row missing — daemon must initialize first');

  const lastPriceDecreaseByOrder = new Map(
    ledgerRows.map((r) => [r.braiins_order_id, r.last_price_decrease_at]),
  );

  // Braiins reads in parallel; individual failures downgrade to null.
  // Datum + Ocean polls run alongside — best-effort, never throw
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
  // #92 (follow-up): pool block counts per tick. Same windowing
  // logic the /api/ocean route uses to render `blocks_24h` /
  // `blocks_7d` - moved here so the value gets snapshotted into
  // tick_metrics and the chart can plot historical luck.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const recent = oceanStats?.recent_blocks ?? [];
  const pool_blocks_24h_count = oceanStats
    ? recent.filter((b) => b.timestamp_ms > 0 && tickAt - b.timestamp_ms < DAY_MS).length
    : null;
  const pool_blocks_7d_count = oceanStats
    ? recent.filter((b) => b.timestamp_ms > 0 && tickAt - b.timestamp_ms < 7 * DAY_MS).length
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
  const [pool_hashrate_ph_avg_24h, pool_hashrate_ph_avg_7d] = await Promise.all([
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
  ]);
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

  // Pool probe (always run — we want outage visibility even if API is down).
  const { host, port } = parsePoolUrl(config.destination_pool_url);
  const poolProbe = await deps.poolTracker.probe({ host, port });
  const pool: PoolHealth = {
    reachable: poolProbe.reachable,
    last_ok_at: deps.poolTracker.snapshot().last_ok_at,
    consecutive_failures: deps.poolTracker.snapshot().consecutive_failures,
  };

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

  // Cheap-mode sustained-window aggregates (#50). Only compute when the
  // operator has opted in — keeps the default tick cheap for users who
  // don't care about the feature. Requires at least 5 samples in each
  // relevant series, matching the `/api/finance/range` "insufficient
  // history" pattern; below that we return null so decide() falls back
  // to the spot check.
  const cheapWinMin = config.cheap_sustained_window_minutes;
  const cheapEnabled =
    config.cheap_threshold_pct > 0 &&
    config.cheap_target_hashrate_ph > config.target_hashrate_ph;
  const MIN_SAMPLES = 5;
  let cheap_mode_window: State['cheap_mode_window'] = null;
  if (cheapEnabled && cheapWinMin > 0) {
    const sinceMs = tickAt - cheapWinMin * 60_000;
    const agg = await deps.tickMetricsRepo
      .cheapModeWindowAggregates(sinceMs)
      .catch((err): Awaited<ReturnType<TickMetricsRepo['cheapModeWindowAggregates']>> => {
        logAndReturnNull('cheap_mode_window', err);
        return {
          avg_best_ask_sat_per_eh_day: null,
          avg_hashprice_sat_per_eh_day: null,
          best_ask_sample_count: 0,
          hashprice_sample_count: 0,
        };
      });
    if (
      agg.avg_best_ask_sat_per_eh_day !== null &&
      agg.avg_hashprice_sat_per_eh_day !== null &&
      agg.avg_hashprice_sat_per_eh_day > 0 &&
      agg.best_ask_sample_count >= MIN_SAMPLES &&
      agg.hashprice_sample_count >= MIN_SAMPLES
    ) {
      cheap_mode_window = {
        avg_best_ask_sat_per_eh_day: agg.avg_best_ask_sat_per_eh_day,
        avg_hashprice_sat_per_eh_day: agg.avg_hashprice_sat_per_eh_day,
        sample_count: Math.min(agg.best_ask_sample_count, agg.hashprice_sample_count),
      };
    }
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
    btc_usd_price,
    btc_usd_price_source,
    pool_blocks_24h_count,
    pool_blocks_7d_count,
    pool_hashrate_ph_avg_24h,
    pool_hashrate_ph_avg_7d,
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
    // Braiins's rolling `avg_speed_ph` lags — it stays non-zero for a
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
