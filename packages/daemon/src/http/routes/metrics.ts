/**
 * GET /api/metrics?range=<preset>
 *
 * Returns the time series of tick metrics for the hashrate chart. The
 * `range` query param is one of the presets exported from
 * `@braiins-hashrate/shared`:
 *
 *   6h | 12h | 24h | 1w | 1m | 1y | all
 *
 * The server picks the aggregation bucket per preset (0 for raw,
 * otherwise a fixed ms window) and returns pre-aggregated averages so
 * the client never renders hundreds of thousands of raw points at long
 * ranges. Default is `24h`.
 *
 * Legacy: `since=<ms>` is still accepted for backwards-compat with any
 * ad-hoc callers, and forces raw (no aggregation) output.
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  pickBucketForSpan,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { HttpServerDeps } from '../server.js';

const EH_PER_PH = 1000;

export interface MetricPoint {
  readonly tick_at: number;
  readonly delivered_ph: number;
  readonly target_ph: number;
  readonly floor_ph: number;
  readonly our_primary_price_sat_per_ph_day: number | null;
  readonly best_bid_sat_per_ph_day: number | null;
  readonly best_ask_sat_per_ph_day: number | null;
  readonly fillable_ask_sat_per_ph_day: number | null;
  readonly hashprice_sat_per_ph_day: number | null;
  readonly max_bid_sat_per_ph_day: number | null;
  readonly available_balance_sat: number | null;
  /**
   * Hashrate Datum reports for its own connected workers, PH/s.
   * Null when the Datum integration is disabled, the poll failed
   * for that tick, or the tick predates migration 0029.
   */
  readonly datum_hashrate_ph: number | null;
  /**
   * Hashrate Ocean credits to the operator's payout address — the
   * `hashrate_300s` field from `/v1/user_hashrate` (5-min sliding
   * window), in PH/s. Null when Ocean isn't configured, the poll
   * failed, or the tick predates migration 0035.
   */
  readonly ocean_hashrate_ph: number | null;
  /**
   * Ocean `share_log` percentage at this tick (e.g. 0.0182 for
   * 0.0182%) — our slice of the pool's TIDES window, sampled from
   * the same `/statsnap` + `/pool_stat` fetch that supplies
   * `hashprice_sat_per_ph_day`. Drives the optional violet `% of
   * Ocean` overlay on the Hashrate chart's right Y-axis. Null when
   * Ocean isn't configured, the poll failed, or the tick predates
   * migration 0048.
   */
  readonly share_log_pct: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick
   * (sat). Per-tick deltas give the authoritative actual-spend rate
   * (independent of our pay-your-bid `spend_sat` model). Null on pre-
   * migration rows and on ticks without a primary owned bid. See
   * migration 0041.
   */
  readonly primary_bid_consumed_sat: number | null;
  // #93: secondary-axis series exposed via /api/metrics so the chart
  // dropdown has data to plot. Each is nullable - aggregation buckets
  // average over rows where the field is present.
  readonly network_difficulty: number | null;
  readonly pool_hashrate_ph: number | null;
  readonly estimated_block_reward_sat: number | null;
  readonly btc_usd_price: number | null;
  readonly ocean_unpaid_sat: number | null;
  // #92: pool block counts - input to the chart's pool-luck plot.
  readonly pool_blocks_24h_count: number | null;
  readonly pool_blocks_7d_count: number | null;
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string; since?: string; limit?: string } }>(
    '/api/metrics',
    async (req): Promise<{ points: MetricPoint[]; range: ChartRange | null }> => {
      const nowMs = Date.now();

      // Legacy path: since=<ms> → raw rows from that timestamp.
      const legacySince = Number.parseInt(req.query.since ?? '', 10);
      if (!req.query.range && Number.isFinite(legacySince) && legacySince > 0) {
        const limit = clamp(
          Number.parseInt(req.query.limit ?? '', 10) || 2000,
          10,
          10_000,
        );
        const rows = await deps.tickMetricsRepo.listSince(legacySince, limit);
        return { points: rows.map(toMetricPoint), range: null };
      }

      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];
      const sinceMs = spec.windowMs === null ? 0 : nowMs - spec.windowMs;
      const limit = clamp(Number.parseInt(req.query.limit ?? '', 10) || 5000, 10, 10_000);

      // Bucket sizing applies to every bounded preset, not just `all`
      // (#82). The preset spec.bucketMs is calibrated for a *full* window
      // worth of data; picking 1m or 1y on a database with only a few
      // days of history would otherwise over-collapse the chart (1y on
      // 6 days = ~6 daily points; 1m on 6 days = ~144 hourly points).
      // Resize to whichever is shorter: the preset window or the actual
      // recorded span.
      let bucketMs = spec.bucketMs;
      const firstTick = await deps.tickMetricsRepo.firstTickAt();
      if (firstTick !== null) {
        const actualSpan = nowMs - firstTick;
        const effectiveSpan =
          spec.windowMs === null ? actualSpan : Math.min(spec.windowMs, actualSpan);
        if (effectiveSpan > 0) {
          bucketMs = pickBucketForSpan(effectiveSpan);
        }
      }

      const rows = await deps.tickMetricsRepo.listAggregated(sinceMs, bucketMs, limit);
      return { points: rows.map(toMetricPoint), range };
    },
  );
}

function toMetricPoint(r: {
  tick_at: number;
  delivered_ph: number;
  target_ph: number;
  floor_ph: number;
  our_primary_price_sat_per_eh_day: number | null;
  best_bid_sat_per_eh_day: number | null;
  best_ask_sat_per_eh_day: number | null;
  fillable_ask_sat_per_eh_day: number | null;
  hashprice_sat_per_eh_day: number | null;
  max_bid_sat_per_eh_day: number | null;
  available_balance_sat: number | null;
  datum_hashrate_ph: number | null;
  ocean_hashrate_ph: number | null;
  share_log_pct: number | null;
  primary_bid_consumed_sat: number | null;
  network_difficulty: number | null;
  pool_hashrate_ph: number | null;
  estimated_block_reward_sat: number | null;
  btc_usd_price: number | null;
  ocean_unpaid_sat: number | null;
  pool_blocks_24h_count: number | null;
  pool_blocks_7d_count: number | null;
}): MetricPoint {
  return {
    tick_at: r.tick_at,
    delivered_ph: r.delivered_ph,
    target_ph: r.target_ph,
    floor_ph: r.floor_ph,
    our_primary_price_sat_per_ph_day:
      r.our_primary_price_sat_per_eh_day !== null
        ? r.our_primary_price_sat_per_eh_day / EH_PER_PH
        : null,
    best_bid_sat_per_ph_day:
      r.best_bid_sat_per_eh_day !== null ? r.best_bid_sat_per_eh_day / EH_PER_PH : null,
    best_ask_sat_per_ph_day:
      r.best_ask_sat_per_eh_day !== null ? r.best_ask_sat_per_eh_day / EH_PER_PH : null,
    fillable_ask_sat_per_ph_day:
      r.fillable_ask_sat_per_eh_day !== null
        ? r.fillable_ask_sat_per_eh_day / EH_PER_PH
        : null,
    hashprice_sat_per_ph_day:
      r.hashprice_sat_per_eh_day !== null
        ? r.hashprice_sat_per_eh_day / EH_PER_PH
        : null,
    max_bid_sat_per_ph_day:
      r.max_bid_sat_per_eh_day !== null
        ? r.max_bid_sat_per_eh_day / EH_PER_PH
        : null,
    available_balance_sat: r.available_balance_sat,
    datum_hashrate_ph: r.datum_hashrate_ph,
    ocean_hashrate_ph: r.ocean_hashrate_ph,
    share_log_pct: r.share_log_pct,
    primary_bid_consumed_sat: r.primary_bid_consumed_sat,
    network_difficulty: r.network_difficulty,
    pool_hashrate_ph: r.pool_hashrate_ph,
    estimated_block_reward_sat: r.estimated_block_reward_sat,
    btc_usd_price: r.btc_usd_price,
    ocean_unpaid_sat: r.ocean_unpaid_sat,
    pool_blocks_24h_count: r.pool_blocks_24h_count,
    pool_blocks_7d_count: r.pool_blocks_7d_count,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
