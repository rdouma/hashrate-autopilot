/**
 * GET /api/overpay-tuning  (#118)
 *
 * Recommends a value for `overpay_sat_per_eh_day` based on the
 * empirical gap distribution over the trailing 7 days. Powers the
 * "Recommended" helper card next to the Overpay above fillable
 * input on Config -> Strategy -> Pricing.
 *
 * Methodology (locked in the issue body):
 *
 * 1. Pull rows from `tick_metrics` covering the last 7 days where the
 *    bid + fillable + hashprice are all non-null.
 * 2. Classify each row by regime:
 *    - 'capped': our bid was effectively pinned to the cap, so the
 *      gap doesn't reflect what we'd have chosen on a free market;
 *      excluded from the percentile calc.
 *    - 'under':  bid was below fillable (negative gap), e.g. mid-edit
 *      tick before the new price landed. Excluded.
 *    - 'tracking': free-market normal case; included.
 * 3. Take p95 of the gap (= bid - fillable) over the 'tracking'
 *    regime. Reads as "you would have filled 95% of the time at this
 *    much overpay; anything above is paid premium that did not
 *    measurably buy fill rate."
 * 4. Round up to the next 1_000 sat/EH/day (= 1 sat/PH/day). Floor
 *    at the tick size so the deadband doesn't collapse.
 * 5. When the eligible-tick count is below 500 (~8 h of normal
 *    ticking) the route returns `status: 'insufficient_history'`
 *    with no recommendation - the helper renders an empty state.
 *
 * The 30-day savings estimate is a counterfactual: assume the bid
 * had been fillable + recommended (clamped at the cap) on every
 * tracking row, and compute the spend delta vs. what the operator
 * actually paid. Multiplied by 30 / sample_days for a monthly figure.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../state/types.js';
import type { ConfigRepo } from '../../state/repos/config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_DAYS = 7;
/** Floor for the recommendation: never recommend below this. Mirrors
 *  the controller's edit-deadband sizing - if overpay drops below
 *  ~tick_size the Paused/Active oscillation hazard increases. */
const TICK_SIZE_SAT_PER_EH_DAY = 1_000;
/** Below this many tracking-regime ticks, the percentile is too noisy
 *  to recommend on. ~8 hours of 1-minute ticks. */
const MIN_TRACKING_TICKS = 500;
/** Default percentile when the request omits the param. p95 reads as
 *  "you would have filled 95% of the time at this overpay." */
const DEFAULT_PERCENTILE = 0.95;
/** Clamp the requested percentile to a sensible range. */
const MIN_PERCENTILE = 0.5;
const MAX_PERCENTILE = 0.99;
/** ~5 sat/PH/day fudge so a tick rounding artifact (bid 1-2 sat
 *  under the cap) isn't classified 'capped' and excluded. */
const CAP_DETECTION_TOLERANCE_SAT_PER_EH_DAY = 5_000;

export interface OverpayTuningResponse {
  /** Mirror of the live config value - dashboard uses this for the diff display. */
  readonly current_sat_per_eh_day: number;
  /** Recommended value. Null when status === 'insufficient_history'. */
  readonly recommended_sat_per_eh_day: number | null;
  readonly status: 'ready' | 'insufficient_history';
  readonly window_days: number;
  /** Percentile actually used (request value clamped to [0.5, 0.99]). */
  readonly percentile: number;
  readonly eligible_ticks: number;
  readonly capped_ticks: number;
  readonly under_fillable_ticks: number;
  /** Total tick_metrics rows in the window (any regime). */
  readonly total_ticks: number;
  /** Counterfactual 30-day savings if we had bid fillable + recommended. Null when status !== 'ready'. */
  readonly estimated_30d_savings_sat: number | null;
  /** Cap on the recommendation: never go below this. */
  readonly floor_sat_per_eh_day: number;
}

export interface OverpayTuningDeps {
  readonly db: Kysely<Database>;
  readonly configRepo: ConfigRepo;
}

interface TickRow {
  bid: number;
  fillable: number;
  hashprice: number;
  max_bid: number;
  delivered_ph: number | null;
}

export async function registerOverpayTuningRoute(
  app: FastifyInstance,
  deps: OverpayTuningDeps,
): Promise<void> {
  app.get<{ Querystring: { percentile?: string } }>(
    '/api/overpay-tuning',
    async (req): Promise<OverpayTuningResponse> => {
    const cfg = await deps.configRepo.get();
    const current = cfg?.overpay_sat_per_eh_day ?? 0;
    const maxOverpay = cfg?.max_overpay_vs_hashprice_sat_per_eh_day ?? null;

    // #118 follow-up: operator picks the percentile via a slider on
    // the helper card. p95 = "fill 95% of the time"; p50 = "fill
    // half the time but pay way less premium". Clamped to a sane
    // range so a typo can't return a one-tick outlier.
    const requestedPct = Number.parseFloat(req.query.percentile ?? '');
    const percentile = Number.isFinite(requestedPct)
      ? Math.max(MIN_PERCENTILE, Math.min(MAX_PERCENTILE, requestedPct))
      : DEFAULT_PERCENTILE;

    const sinceMs = Date.now() - SAMPLE_DAYS * DAY_MS;
    const rowsRes = await sql<TickRow>`
      SELECT
        our_primary_price_sat_per_eh_day AS bid,
        fillable_ask_sat_per_eh_day AS fillable,
        hashprice_sat_per_eh_day AS hashprice,
        max_bid_sat_per_eh_day AS max_bid,
        delivered_ph
      FROM tick_metrics
      WHERE tick_at >= ${sinceMs}
        AND our_primary_price_sat_per_eh_day IS NOT NULL
        AND fillable_ask_sat_per_eh_day IS NOT NULL
        AND hashprice_sat_per_eh_day IS NOT NULL
        AND max_bid_sat_per_eh_day IS NOT NULL
    `.execute(deps.db);
    const rows = rowsRes.rows;

    const tracking: TickRow[] = [];
    let cappedTicks = 0;
    let underTicks = 0;
    for (const r of rows) {
      const gap = r.bid - r.fillable;
      if (gap < 0) {
        underTicks++;
        continue;
      }
      // Effective cap = MIN(max_bid, hashprice + max_overpay_vs_hashprice).
      // If the bid is at or near the cap, treat the row as 'capped'
      // and exclude from the percentile (the gap doesn't reflect the
      // operator's free-market preference).
      const dynCap =
        maxOverpay !== null ? r.hashprice + maxOverpay : Number.POSITIVE_INFINITY;
      const effCap = Math.min(r.max_bid, dynCap);
      if (r.bid >= effCap - CAP_DETECTION_TOLERANCE_SAT_PER_EH_DAY) {
        cappedTicks++;
        continue;
      }
      tracking.push(r);
    }

    if (tracking.length < MIN_TRACKING_TICKS) {
      return {
        current_sat_per_eh_day: current,
        recommended_sat_per_eh_day: null,
        status: 'insufficient_history',
        window_days: SAMPLE_DAYS,
        percentile,
        eligible_ticks: tracking.length,
        capped_ticks: cappedTicks,
        under_fillable_ticks: underTicks,
        total_ticks: rows.length,
        estimated_30d_savings_sat: null,
        floor_sat_per_eh_day: TICK_SIZE_SAT_PER_EH_DAY,
      };
    }

    // Pick the percentile element from the sorted gap distribution.
    // Cheap and portable; SQLite doesn't ship PERCENTILE_CONT
    // reliably across builds.
    const gaps = tracking.map((r) => r.bid - r.fillable).sort((a, b) => a - b);
    const pIndex = Math.min(
      gaps.length - 1,
      Math.max(0, Math.ceil(percentile * gaps.length) - 1),
    );
    const pValue = gaps[pIndex] ?? 0;
    // Round up to the next 1_000 sat/EH/day so the value is presentable.
    const roundedUp = Math.ceil(pValue / 1_000) * 1_000;
    const recommended = Math.max(roundedUp, TICK_SIZE_SAT_PER_EH_DAY);

    // Counterfactual savings: for each tracking row, compute the
    // delta-spend at (fillable + recommended) clamped at effCap vs.
    // the actual bid. Sum and scale to 30 days.
    let savings_sat_per_window = 0;
    for (const r of tracking) {
      const dynCap =
        maxOverpay !== null ? r.hashprice + maxOverpay : Number.POSITIVE_INFINITY;
      const effCap = Math.min(r.max_bid, dynCap);
      const cfBid = Math.min(r.fillable + recommended, effCap);
      const delivered = r.delivered_ph ?? 0;
      // sat/EH/day -> sat per tick: bid * delivered_ph / 1000 / minutes_per_day.
      // tick is 60s, so per-tick spend = bid_sat/EH/day * delivered_ph/EH/PH * (60/86400)
      // = bid * delivered / 1000 * (1/1440).
      const perTickFactor = delivered / 1000 / 1440;
      const actualSpend = r.bid * perTickFactor;
      const cfSpend = cfBid * perTickFactor;
      savings_sat_per_window += Math.max(0, actualSpend - cfSpend);
    }
    const estimated_30d_savings_sat = Math.round(
      (savings_sat_per_window * 30) / SAMPLE_DAYS,
    );

    return {
      current_sat_per_eh_day: current,
      recommended_sat_per_eh_day: recommended,
      status: 'ready',
      window_days: SAMPLE_DAYS,
      percentile,
      eligible_ticks: tracking.length,
      capped_ticks: cappedTicks,
      under_fillable_ticks: underTicks,
      total_ticks: rows.length,
      estimated_30d_savings_sat,
      floor_sat_per_eh_day: TICK_SIZE_SAT_PER_EH_DAY,
    };
    },
  );
}
