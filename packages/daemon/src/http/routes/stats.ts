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
   * below. Computed from `primary_bid_consumed_sat` deltas (the
   * authoritative settlement counter from Braiins) rather than from
   * our bid price, because the counter is independent of our model
   * and resilient to mid-window bid changes. Under pay-your-bid (#53)
   * the bid IS the per-EH-day price and the two should agree closely,
   * but the counter is the source of truth.
   * Null for ranges without usable tick coverage.
   */
  readonly avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  /**
   * Average effective rate we paid per PH per day, weighted by
   * delivery. Derived from `primary_bid_consumed_sat` deltas (what
   * Braiins actually charged us) rather than our bid price.
   */
  readonly avg_cost_per_ph_sat_per_ph_day: number | null;
  /**
   * #90 — 1h-rolling acceptance ratio: shares accepted by the pool ÷
   * shares purchased (Braiins-validated), computed from per-tick
   * forward deltas of the cumulative counters. Resets (counter
   * decreased mid-window, e.g. a bid replacement) are skipped so a
   * fresh bid does not torpedo the ratio. Null when no usable counter
   * pairs are present in the window. Healthy baseline ~99.95%; alert
   * threshold proposed at <98%.
   */
  readonly acceptance_pct_1h: number | null;
  readonly acceptance_purchased_delta_1h: number | null;
  readonly acceptance_accepted_delta_1h: number | null;
  /**
   * #91 — 1h-rolling forward delta of the cumulative DATUM gateway
   * reject counter. Pairs with `braiins_rejects_count_1h` on the
   * Datum panel so the operator can compare "shares Datum thinks
   * were rejected upstream of the pool" vs "shares Braiins reports
   * the pool rejected" — the asymmetry tells which leg of the
   * Knots → Datum → Ocean pipeline is dropping shares (research.md
   * §4.5). Null when DATUM does not expose the reject tile (the
   * common case as of May 2026) or there are no usable counter
   * pairs in the trailing hour.
   */
  readonly datum_rejects_1h: number | null;
  /**
   * Braiins-side rejected-shares delta over the same trailing hour,
   * converted from millions to raw count so it can be compared 1:1
   * with `datum_rejects_1h`. Null when the bid did not exist for
   * the full window or the call failed at every tick.
   */
  readonly braiins_rejects_count_1h: number | null;
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
      // Acceptance window is fixed at 1h regardless of `range`; the
      // operator-facing question is "is my pool currently rejecting
      // more than usual right now", not "over the last week". Always
      // computed from the trailing 60 minutes of tick_metrics.
      const acceptance = await computeAcceptanceLastHour(deps.db, now);
      // #91 — same window for the Datum-vs-Braiins reject comparison.
      const rejects = await computeRejectsLastHour(deps.db, now);

      const data: StatsResponse = {
        uptime_pct: metrics.uptime_pct,
        avg_hashrate_ph: metrics.avg_hashrate_ph,
        avg_datum_hashrate_ph: metrics.avg_datum_hashrate_ph,
        avg_ocean_hashrate_ph: metrics.avg_ocean_hashrate_ph,
        total_ph_hours: metrics.total_ph_hours,
        avg_overpay_vs_hashprice_sat_per_ph_day: metrics.avg_overpay_vs_hashprice_sat_per_ph_day,
        avg_cost_per_ph_sat_per_ph_day: metrics.avg_cost_per_ph_sat_per_ph_day,
        acceptance_pct_1h: acceptance.pct,
        acceptance_purchased_delta_1h: acceptance.purchased_delta,
        acceptance_accepted_delta_1h: acceptance.accepted_delta,
        datum_rejects_1h: rejects.datum,
        braiins_rejects_count_1h: rejects.braiins,
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

      -- Uptime: duration-weighted fraction of clock time when the
      -- counter-derived delivered hashrate was meaningful (>= 0.05
      -- PH/s). Matches the operator-facing tooltip "% of time with
      -- delivered hashrate > 0".
      --
      -- DENOMINATOR is total clock time over the window (every tick
      -- with reasonable \`dur\`). Zero-delivery time MUST count toward
      -- the denominator or "uptime" reads as a tautology - earlier
      -- versions filtered both sides on \`delivered_ph > 0.05\`, which
      -- excluded zero-delivery ticks entirely and let the metric
      -- read 87.5% on a window with ~50% true delivery. (#86)
      --
      -- NUMERATOR uses the COUNTER (\`primary_bid_consumed_sat\`
      -- delta), not the Braiins-reported \`delivered_ph\` field.
      -- delivered_ph is a 5-min lagged rolling average that stays
      -- elevated for minutes after real delivery drops, so basing
      -- uptime on it would say "uptime" during the very freezes
      -- operators care about. (#52)
      --
      -- Counter-derived PH per tick = delta * 86_400_000_000 /
      -- (our_bid * dur). The threshold check >= 0.05 PH/s, multiplied
      -- through to keep all integer arithmetic, is:
      --   delta * 86_400_000_000 >= 0.05 * our_bid * dur
      -- Ticks with no owned bid (our_bid IS NULL or 0) cannot deliver
      -- and count as downtime - 0 in numerator, full \`dur\` in
      -- denominator. Same applies to ticks where the counter went
      -- backwards (delta < 0, e.g. a bid replaced with a fresh one
      -- whose counter starts at 0).
      --
      -- Earlier #84 fix made the threshold relative ("delta >= 50%
      -- of expected accrual"), which fixed the target-change
      -- regression but left the denominator-excludes-downtime bug
      -- intact. The relative-threshold framing is gone here: the
      -- absolute "PH/s above noise floor" check naturally handles
      -- both the target-change case (low target -> low expected ->
      -- low actual, all consistent above 0.05) and the
      -- zero-delivery case (delta -> 0 -> below 0.05 -> downtime).
      CASE WHEN SUM(CASE WHEN dur BETWEEN 1 AND 300000 THEN dur ELSE 0 END) > 0 THEN
        SUM(CASE WHEN dur BETWEEN 1 AND 300000
                  AND our_bid > 0
                  AND delta IS NOT NULL AND delta >= 0
                  AND delta * 86400000000.0 >= 0.05 * our_bid * dur
             THEN dur ELSE 0 END) * 100.0
          / SUM(CASE WHEN dur BETWEEN 1 AND 300000 THEN dur ELSE 0 END)
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
 * #90 — 1h-rolling acceptance ratio.
 *
 * Sums forward deltas of `primary_bid_shares_purchased_m` and
 * `_accepted_m` across the last hour of tick_metrics rows. Skips
 * pairs where the counter went backwards (bid replacement resets the
 * counter to zero) so a fresh bid does not torpedo the ratio. Skips
 * pairs where either side is null. Returns null pct when no usable
 * deltas are present in the window — same semantics as uptime_pct
 * during pre-migration ranges.
 *
 * Per-tick fold in TS rather than SQL because the LAG + reset-skip +
 * null-handling combination is messier in CTEs than in a tiny TS
 * loop, and the window is tiny (60 rows max).
 */
async function computeAcceptanceLastHour(
  db: Kysely<Database>,
  nowMs: number,
): Promise<{
  pct: number | null;
  purchased_delta: number | null;
  accepted_delta: number | null;
}> {
  const sinceMs = nowMs - 60 * 60 * 1000;
  const rows = await db
    .selectFrom('tick_metrics')
    .select([
      'tick_at',
      'primary_bid_shares_purchased_m',
      'primary_bid_shares_accepted_m',
    ])
    .where('tick_at', '>=', sinceMs)
    .orderBy('tick_at', 'asc')
    .execute();

  let purchasedDelta = 0;
  let acceptedDelta = 0;
  let prev: { p: number; a: number } | null = null;
  for (const r of rows) {
    const p = r.primary_bid_shares_purchased_m;
    const a = r.primary_bid_shares_accepted_m;
    if (p === null || a === null) {
      prev = null;
      continue;
    }
    if (prev !== null && p >= prev.p && a >= prev.a) {
      purchasedDelta += p - prev.p;
      acceptedDelta += a - prev.a;
    }
    prev = { p, a };
  }
  if (purchasedDelta <= 0) {
    return { pct: null, purchased_delta: null, accepted_delta: null };
  }
  return {
    pct: (acceptedDelta / purchasedDelta) * 100,
    purchased_delta: purchasedDelta,
    accepted_delta: acceptedDelta,
  };
}

/**
 * #91 — 1h-rolling forward deltas of two reject counters:
 *
 * - `datum`: `datum_rejected_shares_total` (raw count). Cumulative
 *   on DATUM's side, so we sum forward pair-wise deltas across the
 *   window; pairs where the value went backwards (DATUM restart) or
 *   either side is null get skipped. Null when DATUM does not expose
 *   the reject tile.
 * - `braiins`: `primary_bid_shares_rejected_m × 1_000_000` (raw count
 *   semantics, converted from millions). Same pair-wise fold over
 *   the window. Null when the bid did not exist or every tick failed.
 *
 * Both numbers are over the SAME tick window so the operator can
 * directly subtract them on the Datum panel — Datum > Braiins means
 * the gateway filtered work that never made it to the pool (that's
 * good — Datum saved you from paying for stale shares); Braiins >
 * Datum means the pool rejected work Datum thought was fine
 * (research.md §4.5: stale-work signature).
 */
async function computeRejectsLastHour(
  db: Kysely<Database>,
  nowMs: number,
): Promise<{ datum: number | null; braiins: number | null }> {
  const sinceMs = nowMs - 60 * 60 * 1000;
  const rows = await db
    .selectFrom('tick_metrics')
    .select([
      'tick_at',
      'datum_rejected_shares_total',
      'primary_bid_shares_rejected_m',
    ])
    .where('tick_at', '>=', sinceMs)
    .orderBy('tick_at', 'asc')
    .execute();

  let datumDelta = 0;
  let datumPairs = 0;
  let braiinsDeltaM = 0;
  let braiinsPairs = 0;
  let prevDatum: number | null = null;
  let prevBraiins: number | null = null;
  for (const r of rows) {
    const d = r.datum_rejected_shares_total;
    if (d !== null) {
      if (prevDatum !== null && d >= prevDatum) {
        datumDelta += d - prevDatum;
        datumPairs += 1;
      }
      prevDatum = d;
    } else {
      prevDatum = null;
    }
    const b = r.primary_bid_shares_rejected_m;
    if (b !== null) {
      if (prevBraiins !== null && b >= prevBraiins) {
        braiinsDeltaM += b - prevBraiins;
        braiinsPairs += 1;
      }
      prevBraiins = b;
    } else {
      prevBraiins = null;
    }
  }
  return {
    datum: datumPairs > 0 ? datumDelta : null,
    braiins: braiinsPairs > 0 ? Math.round(braiinsDeltaM * 1_000_000) : null,
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
