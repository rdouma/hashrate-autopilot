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

      -- Uptime: fraction of time when the Braiins counter was actually
      -- incrementing at a non-trivial rate, NOT when the Braiins-side
      -- lagged \`delivered_ph\` reported > 0. The lagged avg stays
      -- elevated for minutes after shares stop flowing; only the
      -- counter tells the truth about real matching. Threshold: Δ >
      -- dur_ms / 1000, i.e. more than 1 sat per second of span. During
      -- the 2026-04-23 12:56-12:59 incident the counter dropped to
      -- ~4 sat/min while delivered_ph held at 3.67 PH/s — that now
      -- correctly registers as downtime. See #52.
      CASE WHEN SUM(CASE WHEN valid THEN dur ELSE 0 END) > 0 THEN
        SUM(CASE WHEN valid AND delta * 1000.0 > dur THEN dur ELSE 0 END) * 100.0
          / SUM(CASE WHEN valid THEN dur ELSE 0 END)
      ELSE NULL END AS uptime_pct,

      -- Avg Braiins delivered: computed from counter deltas, not the
      -- lagged avg_speed_ph field. Per-tick delivered_PH =
      -- delta × 86_400_000_000 / (our_bid × dur_ms). our_bid is in
      -- sat/EH/day, so the ×1000 (EH→PH) is folded into the constant:
      -- 86_400_000 × 1000 = 86_400_000_000. Time-weighted average
      -- simplifies to SUM(delta × 86.4e9 / our_bid) / SUM(dur). Same
      -- \`valid\` mask as the cost calculation below to keep numerator
      -- and denominator consistent. #52.
      CASE WHEN SUM(CASE WHEN valid AND our_bid > 0 THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN valid AND our_bid > 0
            THEN delta * 86400000000.0 / our_bid
            ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 THEN dur ELSE 0 END)
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

      -- Total PH-hours delivered: counter-derived, same rationale as
      -- avg_hashrate above. delta / our_bid gives PH-days per tick
      -- when multiplied by 86_400_000/dur; scaling to PH-hours =
      -- delta × 24000 / our_bid across the window.
      CASE WHEN SUM(CASE WHEN valid AND our_bid > 0 THEN 1 ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN valid AND our_bid > 0
            THEN delta * 24000.0 / our_bid
            ELSE 0 END) AS REAL)
      ELSE NULL END AS total_ph_hours,

      -- Average effective cost per PH/day, counter-derived (#73).
      --
      -- Earlier versions divided SUM(delta) by SUM(delivered_ph × dur)
      -- where delivered_ph was the lagged Braiins-reported avg_speed_ph
      -- field. During delivery dips, delta correctly drops to zero
      -- but delivered_ph stays elevated (5-min rolling lag on Braiins'
      -- side). Those mismatched ticks contributed 0 to the numerator
      -- and >0 to the denominator, dragging the apparent cost ~3-5%
      -- below the actual bid - confusing under pay-your-bid where the
      -- bid IS what was charged.
      --
      -- New formula: SUM(delta) / SUM(delta / our_bid). This is the
      -- delta-weighted harmonic mean of our_bid - mathematically
      -- equivalent to time-weighting by COUNTER-DERIVED hashrate
      -- (delta × 86.4e9 / (our_bid × dur), the same signal driving
      -- the chart's amber line). When our_bid is constant across the
      -- window the result equals our_bid exactly; when our_bid
      -- varies (mid-window EDIT_PRICE) it's the delta-weighted
      -- harmonic mean. Either way it cannot exceed max(our_bid)
      -- across the window, so the old MIN-clamp-to-bid is redundant
      -- and removed.
      --
      -- valid filter is unchanged. Zero-delta ticks contribute
      -- 0/our_bid = 0 to denominator AND numerator, so they don't
      -- skew anything either way; explicit our_bid > 0 guard avoids
      -- div-by-zero on null/zero-bid ticks.
      --
      -- result unit: sat/EH/day. Caller divides by EH_PER_PH = 1000
      -- → sat/PH/day.
      CASE WHEN SUM(CASE WHEN valid AND our_bid > 0 THEN CAST(delta AS REAL) / our_bid ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN valid AND our_bid > 0 THEN delta ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 THEN CAST(delta AS REAL) / our_bid ELSE 0 END)
      ELSE NULL END AS avg_cost,

      -- Same counter-PH weighting (#73) for hashprice spread:
      -- delta-weighted average of (effective_rate - hashprice), where
      -- effective_rate per tick is our_bid by construction under
      -- pay-your-bid. Result = avg_cost (above) - delta-weighted
      -- average hashprice during periods we were actually billed.
      CASE WHEN SUM(CASE WHEN valid AND our_bid > 0 AND hashprice IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN valid AND our_bid > 0 AND hashprice IS NOT NULL THEN delta ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 AND hashprice IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END)
        - (CAST(SUM(CASE WHEN valid AND our_bid > 0 AND hashprice IS NOT NULL THEN hashprice * CAST(delta AS REAL) / our_bid ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 AND hashprice IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END))
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
