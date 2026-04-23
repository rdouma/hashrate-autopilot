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
  /**
   * Duration-weighted average of `datum_hashrate_ph` over ticks that
   * had a Datum reading. Null when the Datum integration was off (or
   * no ticks in range had a non-null reading). Compared side-by-side
   * with `avg_hashrate_ph` on the stat card — a sustained gap is the
   * signal that Braiins's billing diverged from what Datum measured.
   */
  readonly avg_datum_hashrate_ph: number | null;
  /**
   * Duration-weighted average of `ocean_hashrate_ph` — what Ocean's
   * `user_hashrate` endpoint credited the operator with over the
   * selected range. Null when no tick in the range had an Ocean
   * reading (pre-migration history, Ocean not configured, or every
   * per-tick poll failed).
   */
  readonly avg_ocean_hashrate_ph: number | null;
  readonly total_ph_hours: number | null;
  /**
   * Average effective rate MINUS average hashprice, weighted by
   * delivery. Positive = paying above break-even, negative = paying
   * below. Computed from `primary_bid_consumed_sat` deltas (actual
   * spend from Braiins), not our bid price — CLOB matching means the
   * bid is a ceiling and the realised price is what we actually pay.
   * Null for ranges without usable tick coverage.
   */
  readonly avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  /**
   * Average effective rate we paid per PH per day, weighted by
   * delivery. Derived from `primary_bid_consumed_sat` deltas (what
   * Braiins actually charged us) rather than our bid price.
   */
  readonly avg_cost_per_ph_sat_per_ph_day: number | null;
  readonly avg_time_to_fill_ms: number | null;
  /**
   * Count of bid_events (CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL)
   * that actually executed in the range. bid_events is append-only
   * and only written on success, so this is a count of "what the
   * controller actually did" — not proposals, not DRY_RUN attempts.
   */
  readonly mutation_count: number;
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
      const mutationCount = await computeMutationCount(deps.bidEventsDb, sinceMs);

      const data: StatsResponse = {
        uptime_pct: metrics.uptime_pct,
        avg_hashrate_ph: metrics.avg_hashrate_ph,
        avg_datum_hashrate_ph: metrics.avg_datum_hashrate_ph,
        avg_ocean_hashrate_ph: metrics.avg_ocean_hashrate_ph,
        total_ph_hours: metrics.total_ph_hours,
        avg_overpay_vs_hashprice_sat_per_ph_day: metrics.avg_overpay_vs_hashprice_sat_per_ph_day,
        avg_cost_per_ph_sat_per_ph_day: metrics.avg_cost_per_ph_sat_per_ph_day,
        avg_time_to_fill_ms: avgFillMs,
        mutation_count: mutationCount,
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
  avg_datum_hashrate_ph: number | null;
  avg_ocean_hashrate_ph: number | null;
  total_ph_hours: number | null;
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

      CASE WHEN SUM(CASE WHEN datum_hashrate_ph IS NOT NULL THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN datum_hashrate_ph IS NOT NULL
            THEN datum_hashrate_ph * dur ELSE 0 END) AS REAL)
        / SUM(CASE WHEN datum_hashrate_ph IS NOT NULL THEN dur ELSE 0 END)
      ELSE NULL END AS avg_datum_hashrate,

      CASE WHEN SUM(CASE WHEN ocean_hashrate_ph IS NOT NULL THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN ocean_hashrate_ph IS NOT NULL
            THEN ocean_hashrate_ph * dur ELSE 0 END) AS REAL)
        / SUM(CASE WHEN ocean_hashrate_ph IS NOT NULL THEN dur ELSE 0 END)
      ELSE NULL END AS avg_ocean_hashrate,

      CAST(SUM(delivered_ph * dur) AS REAL) / 3600000.0 AS total_ph_hours,

      -- Average effective cost per PH/day, from per-tick
      -- primary_bid_consumed_sat deltas (what Braiins actually
      -- charged us). The "valid" condition below is shared by
      -- numerator and denominator to avoid filter-mismatch inflation.
      --
      -- Both endpoints of each delta must be > 0 — a zero mid-sequence
      -- is a transient "no primary bid" snapshot (brief window during
      -- a CREATE/EDIT where Braiins reports amount_sat=0), not a real
      -- counter. If we didn't filter these out, LAG across a zero-dip
      -- treats the full counter value on the recovery side as "new
      -- spend", inflating the aggregate by orders of magnitude
      -- (empirically: one such tick at 01:17 turned a 41k rate into
      -- 800k). Also caps dur at 5 min to ignore restart gaps and
      -- requires positive delivery (0.05 PH/s floor).
      --
      -- Rate returned clamped to our own bid — under CLOB the bid is
      -- a hard ceiling, so any delta/phDays ratio above that is a
      -- computation artifact.
      --
      -- result unit: sat/EH/day (sat × 1000 / PH / day). Caller
      -- divides by EH_PER_PH = 1000 → sat/PH/day.
      CASE WHEN SUM(CASE WHEN valid THEN delivered_ph * dur ELSE 0 END) > 0 THEN
        MIN(
          CAST(SUM(CASE WHEN valid THEN delta ELSE 0 END) AS REAL)
            * 86400000000.0
            / SUM(CASE WHEN valid THEN delivered_ph * dur ELSE 0 END),
          COALESCE(
            CAST(SUM(CASE WHEN valid THEN our_bid * delivered_ph * dur ELSE 0 END) AS REAL)
              / SUM(CASE WHEN valid THEN delivered_ph * dur ELSE 0 END),
            1e18
          )
        )
      ELSE NULL END AS avg_cost,

      CASE WHEN SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN delivered_ph * dur ELSE 0 END) > 0 THEN
        MIN(
          CAST(SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN delta ELSE 0 END) AS REAL)
            * 86400000000.0
            / SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN delivered_ph * dur ELSE 0 END),
          COALESCE(
            CAST(SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN our_bid * delivered_ph * dur ELSE 0 END) AS REAL)
              / SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN delivered_ph * dur ELSE 0 END),
            1e18
          )
        )
        - (CAST(SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN hashprice * delivered_ph * dur ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND hashprice IS NOT NULL THEN delivered_ph * dur ELSE 0 END))
      ELSE NULL END AS avg_overpay_vs_hashprice
    FROM (
      SELECT
        tick_at,
        delivered_ph,
        datum_hashrate_ph,
        ocean_hashrate_ph,
        hashprice,
        our_bid,
        delta,
        dur,
        (delta IS NOT NULL
          AND delta >= 0
          AND delivered_ph > 0.05
          AND dur BETWEEN 1 AND 300000) AS valid
      FROM (
        SELECT
          tick_at,
          delivered_ph,
          datum_hashrate_ph,
          ocean_hashrate_ph,
          hashprice_sat_per_eh_day AS hashprice,
          our_primary_price_sat_per_eh_day AS our_bid,
          CASE
            WHEN primary_bid_consumed_sat IS NOT NULL
              AND primary_bid_consumed_sat > 0
              AND LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at) IS NOT NULL
              AND LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at) > 0
              AND primary_bid_consumed_sat >= LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at)
            THEN primary_bid_consumed_sat - LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at)
            ELSE NULL
          END AS delta,
          COALESCE(
            LEAD(tick_at) OVER (ORDER BY tick_at) - tick_at,
            60000
          ) AS dur
        FROM tick_metrics
        WHERE tick_at >= ${sinceMs}
      )
    )
  `;
  const row = await sql.raw(queryText).execute(db);

  const r = (row as unknown as { rows: Array<Record<string, number | null>> }).rows?.[0];
  if (!r) {
    return { tick_count: 0, uptime_pct: null, avg_hashrate_ph: null, avg_datum_hashrate_ph: null, avg_ocean_hashrate_ph: null, total_ph_hours: null, avg_overpay_vs_hashprice_sat_per_ph_day: null, avg_cost_per_ph_sat_per_ph_day: null };
  }

  return {
    tick_count: Number(r['tick_count'] ?? 0),
    uptime_pct: r['uptime_pct'] !== null ? Number(r['uptime_pct']) : null,
    avg_hashrate_ph: r['avg_hashrate'] !== null ? Number(r['avg_hashrate']) : null,
    avg_datum_hashrate_ph:
      r['avg_datum_hashrate'] !== null ? Number(r['avg_datum_hashrate']) : null,
    avg_ocean_hashrate_ph:
      r['avg_ocean_hashrate'] !== null ? Number(r['avg_ocean_hashrate']) : null,
    total_ph_hours: r['total_ph_hours'] !== null ? Number(r['total_ph_hours']) : null,
    // SQL returns sat/EH/day; convert to sat/PH/day for the dashboard.
    avg_overpay_vs_hashprice_sat_per_ph_day: r['avg_overpay_vs_hashprice'] !== null ? Number(r['avg_overpay_vs_hashprice']) / EH_PER_PH : null,
    avg_cost_per_ph_sat_per_ph_day: r['avg_cost'] !== null ? Number(r['avg_cost']) / EH_PER_PH : null,
  };
}

/**
 * Count every successful bid mutation (CREATE / EDIT_PRICE /
 * EDIT_SPEED / CANCEL) recorded in `bid_events` during the range.
 * bid_events is append-only and only populated on successful wire
 * execution, so this is a clean count of "what the controller
 * actually did" — DRY_RUN / BLOCKED proposals never get here.
 */
async function computeMutationCount(
  db: Kysely<Database>,
  sinceMs: number,
): Promise<number> {
  const row = await db
    .selectFrom('bid_events')
    .select(sql<number>`COUNT(*)`.as('count'))
    .where('occurred_at', '>=', sinceMs)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
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
