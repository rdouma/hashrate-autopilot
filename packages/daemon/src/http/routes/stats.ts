/**
 * GET /api/stats?range=<preset>
 *
 * Duration-weighted tuning stats computed server-side from the raw
 * `tick_metrics` table. Each tick is weighted by its actual duration
 * (time until the next tick, via SQL LEAD window function) so a
 * 2-minute gap after a restart counts twice as much as a normal
 * 60-second tick. Avoids the client-side distortion that occurred
 * when pre-aggregated chart buckets (5 min / 1 h) collapsed the
 * raw duration information.
 *
 * Cached per range key for 60 s so repeated dashboard polls don't
 * re-run the window-function query.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  pickBucketForSpan,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { Database } from '../../state/types.js';

const EH_PER_PH = 1000;
const CACHE_TTL_MS = 60_000;

export interface StatsResponse {
  readonly uptime_pct: number | null;
  readonly avg_hashrate_ph: number | null;
  readonly total_ph_hours: number | null;
  readonly avg_overpay_sat_per_ph_day: number | null;
  readonly avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  readonly avg_cost_per_ph_sat_per_ph_day: number | null;
  readonly avg_time_to_fill_ms: number | null;
  readonly range: ChartRange;
  readonly tick_count: number;
}

interface CachedStats {
  data: StatsResponse;
  fetched_at: number;
}

export interface StatsDeps {
  readonly db: Kysely<Database>;
  readonly bidEventsDb: Kysely<Database>;
}

export async function registerStatsRoute(
  app: FastifyInstance,
  deps: StatsDeps,
): Promise<void> {
  const cache = new Map<string, CachedStats>();

  app.get<{ Querystring: { range?: string } }>(
    '/api/stats',
    async (req): Promise<StatsResponse> => {
      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const now = Date.now();

      const cached = cache.get(range);
      if (cached && now - cached.fetched_at < CACHE_TTL_MS) {
        return cached.data;
      }

      const spec = CHART_RANGE_SPECS[range];
      const sinceMs = spec.windowMs === null ? 0 : now - spec.windowMs;

      const metrics = await computeMetrics(deps.db, sinceMs);
      const avgFillMs = await computeAvgTimeToFill(deps.db, deps.bidEventsDb, sinceMs);

      const data: StatsResponse = {
        uptime_pct: metrics.uptime_pct,
        avg_hashrate_ph: metrics.avg_hashrate_ph,
        total_ph_hours: metrics.total_ph_hours,
        avg_overpay_sat_per_ph_day: metrics.avg_overpay_sat_per_ph_day,
        avg_overpay_vs_hashprice_sat_per_ph_day: metrics.avg_overpay_vs_hashprice_sat_per_ph_day,
        avg_cost_per_ph_sat_per_ph_day: metrics.avg_cost_per_ph_sat_per_ph_day,
        avg_time_to_fill_ms: avgFillMs,
        range,
        tick_count: metrics.tick_count,
      };
      cache.set(range, { data, fetched_at: now });
      return data;
    },
  );
}

async function computeMetrics(
  db: Kysely<Database>,
  sinceMs: number,
): Promise<{
  uptime_pct: number | null;
  avg_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_overpay_sat_per_ph_day: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  tick_count: number;
}> {
  // Use Kysely's raw SQL but inline the sinceMs literal so the CTE +
  // window function works reliably across different SQLite/driver
  // combos. Bound parameters inside CTEs can trip some prepared-
  // statement parsers.
  const queryText = `
    SELECT
      COUNT(*) AS tick_count,

      CASE WHEN SUM(dur) > 0 THEN
        SUM(CASE WHEN delivered_ph > 0 THEN dur ELSE 0 END) * 100.0 / SUM(dur)
      ELSE NULL END AS uptime_pct,

      CASE WHEN SUM(dur) > 0 THEN
        CAST(SUM(delivered_ph * dur) AS REAL) / SUM(dur)
      ELSE NULL END AS avg_hashrate,

      CAST(SUM(delivered_ph * dur) AS REAL) / 3600000.0 AS total_ph_hours,

      CASE WHEN SUM(CASE WHEN price IS NOT NULL AND fillable IS NOT NULL THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN price IS NOT NULL AND fillable IS NOT NULL
            THEN (price - fillable) * dur ELSE 0 END) AS REAL)
        / SUM(CASE WHEN price IS NOT NULL AND fillable IS NOT NULL THEN dur ELSE 0 END)
      ELSE NULL END AS avg_overpay,

      CASE WHEN SUM(CASE WHEN price IS NOT NULL AND hashprice IS NOT NULL THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN price IS NOT NULL AND hashprice IS NOT NULL
            THEN (price - hashprice) * dur ELSE 0 END) AS REAL)
        / SUM(CASE WHEN price IS NOT NULL AND hashprice IS NOT NULL THEN dur ELSE 0 END)
      ELSE NULL END AS avg_overpay_vs_hashprice,

      CASE WHEN SUM(CASE WHEN delivered_ph > 0 AND price IS NOT NULL THEN delivered_ph * dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN delivered_ph > 0 AND price IS NOT NULL
            THEN price * delivered_ph * dur ELSE 0 END) AS REAL)
        / SUM(CASE WHEN delivered_ph > 0 AND price IS NOT NULL
            THEN delivered_ph * dur ELSE 0 END)
      ELSE NULL END AS avg_cost
    FROM (
      SELECT
        tick_at,
        delivered_ph,
        our_primary_price_sat_per_eh_day AS price,
        fillable_ask_sat_per_eh_day AS fillable,
        hashprice_sat_per_eh_day AS hashprice,
        COALESCE(
          LEAD(tick_at) OVER (ORDER BY tick_at) - tick_at,
          60000
        ) AS dur
      FROM tick_metrics
      WHERE tick_at >= ${sinceMs}
    )
  `;
  const row = await sql.raw(queryText).execute(db);

  const r = (row as unknown as { rows: Array<Record<string, number | null>> }).rows?.[0];
  if (!r) {
    return { tick_count: 0, uptime_pct: null, avg_hashrate_ph: null, total_ph_hours: null, avg_overpay_sat_per_ph_day: null, avg_overpay_vs_hashprice_sat_per_ph_day: null, avg_cost_per_ph_sat_per_ph_day: null };
  }

  return {
    tick_count: Number(r['tick_count'] ?? 0),
    uptime_pct: r['uptime_pct'] !== null ? Number(r['uptime_pct']) : null,
    avg_hashrate_ph: r['avg_hashrate'] !== null ? Number(r['avg_hashrate']) : null,
    total_ph_hours: r['total_ph_hours'] !== null ? Number(r['total_ph_hours']) : null,
    // SQL returns sat/EH/day; convert to sat/PH/day for the dashboard.
    avg_overpay_sat_per_ph_day: r['avg_overpay'] !== null ? Number(r['avg_overpay']) / EH_PER_PH : null,
    avg_overpay_vs_hashprice_sat_per_ph_day: r['avg_overpay_vs_hashprice'] !== null ? Number(r['avg_overpay_vs_hashprice']) / EH_PER_PH : null,
    avg_cost_per_ph_sat_per_ph_day: r['avg_cost'] !== null ? Number(r['avg_cost']) / EH_PER_PH : null,
  };
}

/**
 * Avg time from a CREATE/EDIT event to the first tick with
 * delivered_ph > 0. Application-side since the correlated subquery
 * pattern is more readable here than in SQL.
 */
async function computeAvgTimeToFill(
  db: Kysely<Database>,
  _bidEventsDb: Kysely<Database>,
  sinceMs: number,
): Promise<number | null> {
  // Get CREATE/EDIT events in the range
  const events = await db
    .selectFrom('bid_events')
    .select(['occurred_at'])
    .where('occurred_at', '>=', sinceMs)
    .where('kind', 'in', ['CREATE_BID', 'EDIT_PRICE'])
    .orderBy('occurred_at', 'asc')
    .execute();

  if (events.length === 0) return null;

  // For each event, find the first tick after it with delivered > 0
  const fillTimes: number[] = [];
  for (const ev of events) {
    const firstFill = await db
      .selectFrom('tick_metrics')
      .select('tick_at')
      .where('tick_at', '>', ev.occurred_at)
      .where('delivered_ph', '>', 0)
      .orderBy('tick_at', 'asc')
      .limit(1)
      .executeTakeFirst();

    if (firstFill) {
      fillTimes.push(firstFill.tick_at - ev.occurred_at);
    }
  }

  return fillTimes.length > 0
    ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length
    : null;
}
