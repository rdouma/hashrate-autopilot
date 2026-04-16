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
  readonly available_balance_sat: number | null;
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

      // `all` is unique: it means "show everything regardless of how much
      // we have". Its fixed 1-day bucket collapses a young DB (e.g. 24 h
      // of history) into a single point. Resize the bucket to the actual
      // data span so "All" still reads usefully on day-one deployments.
      let bucketMs = spec.bucketMs;
      if (range === 'all') {
        const firstTick = await deps.tickMetricsRepo.firstTickAt();
        if (firstTick !== null) {
          bucketMs = pickBucketForSpan(nowMs - firstTick);
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
  available_balance_sat: number | null;
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
    available_balance_sat: r.available_balance_sat,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
