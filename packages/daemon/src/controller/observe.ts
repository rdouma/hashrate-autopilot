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

import type { BraiinsService } from '../services/braiins-service.js';
import {
  PoolHealthTracker,
  parsePoolUrl,
  type PoolProbeResult,
} from '../services/pool-health.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { OwnedBidsRepo, ReconcilableBid } from '../state/repos/owned_bids.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type {
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
  const [marketSnapshot, balance, bidsResponse] = await Promise.all([
    collectMarket(deps.braiins).catch((err) => logAndReturnNull('market', err)),
    deps.braiins.getBalance().catch((err) => logAndReturnNull('balance', err)),
    deps.braiins.getCurrentBids().catch((err) => logAndReturnNull('bids', err)),
  ]);

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
        status: b.status,
        last_price_decrease_at: lastPriceDecreaseByOrder.get(b.braiins_order_id) ?? null,
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
    action_mode: runtime.action_mode,
    operator_available: runtime.operator_available,
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
    last_api_ok_at: deps.braiins.getLastApiOkAt(),
    hashprice_sat_per_ph_day: inputs.hashpriceSatPerPhDay,
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
