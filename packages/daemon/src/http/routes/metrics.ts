/**
 * GET /api/metrics?since=<ms>&limit=<n>
 *
 * Returns the time series of tick metrics for the Hashrate chart.
 * Defaults to the last 6 hours if `since` is omitted.
 */

import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const EH_PER_PH = 1000;

export interface MetricPoint {
  readonly tick_at: number;
  readonly delivered_ph: number;
  readonly target_ph: number;
  readonly floor_ph: number;
  readonly our_primary_price_sat_per_ph_day: number | null;
  readonly best_bid_sat_per_ph_day: number | null;
  readonly best_ask_sat_per_ph_day: number | null;
  readonly available_balance_sat: number | null;
  readonly run_mode: string;
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { since?: string; limit?: string } }>(
    '/api/metrics',
    async (req): Promise<{ points: MetricPoint[] }> => {
      const nowMs = Date.now();
      const since = Number.parseInt(req.query.since ?? '', 10);
      const sinceMs =
        Number.isFinite(since) && since > 0 ? since : nowMs - SIX_HOURS_MS;
      const limit = clamp(Number.parseInt(req.query.limit ?? '', 10) || 2000, 10, 10_000);
      const rows = await deps.tickMetricsRepo.listSince(sinceMs, limit);
      const points: MetricPoint[] = rows.map((r) => ({
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
        available_balance_sat: r.available_balance_sat,
        run_mode: r.run_mode,
      }));
      return { points };
    },
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
