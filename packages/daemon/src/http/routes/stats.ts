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
} from '@hashrate-autopilot/shared';

import type { Database } from '../../state/types.js';

const EH_PER_PH = 1000;
const CACHE_TTL_MS = 60_000;

export interface StatsResponse {
  readonly uptime_pct: number | null;
  /**
   * #254: of the total clock time in the window, what % did the
   * controller have an active Braiins bid for? Independent of whether
   * that bid actually delivered hashrate. Low value = orderbook
   * unavailability ("nothing matched my criteria") - "expected"
   * downtime per the reporter's framing. Null when no qualifying
   * ticks.
   */
  readonly uptime_bid_coverage_pct: number | null;
  /**
   * #254: of the time we DID have an active bid, what % was actually
   * delivering hashrate? Isolates hardware / connection / Datum-side
   * failures from orderbook unavailability. Low value = "unexpected"
   * downtime per the reporter's framing. Null when no bid-active
   * ticks in the window.
   */
  readonly uptime_delivery_when_bid_active_pct: number | null;
  readonly avg_hashrate_ph: number | null;
  /**
   * Duration-weighted average of `datum_hashrate_ph` over ticks that
   * had a Datum reading. Null when the Datum integration was off (or
   * no ticks in range had a non-null reading). Compared side-by-side
   * with `avg_hashrate_ph` on the stat card - a sustained gap is the
   * signal that Braiins's billing diverged from what Datum measured.
   */
  readonly avg_datum_hashrate_ph: number | null;
  /**
   * Duration-weighted average of `ocean_hashrate_ph` - what Ocean's
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
   * Average controller-intent overpay above fillable_ask (#164).
   * Time-weighted mean of (our_bid - fillable_ask) across every tick
   * in the window where both values are present. Reflects what the
   * controller targeted, before billing reality. Weighted by tick
   * duration so idle stretches with the bid still posted count.
   */
  readonly avg_intent_overpay_sat_per_ph_day: number | null;
  /**
   * Average settled overpay above fillable_ask (#164). Delta-weighted
   * mean of (effective_rate - fillable_ask) - same delta/our_bid
   * weighting as avg_cost_per_ph_sat_per_ph_day. Reflects what we
   * actually paid above fillable, post-billing. Zero-delivery ticks
   * contribute nothing.
   */
  readonly avg_settled_overpay_sat_per_ph_day: number | null;
  readonly avg_time_to_fill_ms: number | null;
  /**
   * Count of bid_events (CREATE / EDIT_PRICE / EDIT_SPEED / CANCEL)
   * that actually executed in the range. bid_events is append-only
   * and only written on success, so this is a count of "what the
   * controller actually did" - not proposals, not DRY_RUN attempts.
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
  const CACHE_MAX = 50;

  app.get<{ Querystring: { range?: string; since?: string; until?: string } }>(
    '/api/stats',
    async (req): Promise<StatsResponse> => {
      const now = Date.now();
      if (cache.size > CACHE_MAX) {
        for (const [k, v] of cache) {
          if (now - v.fetched_at >= CACHE_TTL_MS || cache.size > CACHE_MAX) cache.delete(k);
        }
      }

      // #169: arbitrary viewport path
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);
      if (
        !req.query.range &&
        Number.isFinite(parsedSince) && parsedSince > 0 &&
        Number.isFinite(parsedUntil) && parsedUntil > parsedSince
      ) {
        const cacheKey = `${parsedSince}-${parsedUntil}`;
        const cached = cache.get(cacheKey);
        if (cached && now - cached.fetched_at < CACHE_TTL_MS) return cached.data;
        const metrics = await computeMetrics(deps.db, parsedSince, parsedUntil);
        const avgFillMs = await computeAvgTimeToFill(deps.db, deps.bidEventsDb, parsedSince, parsedUntil);
        const mutationCount = await computeMutationCount(deps.bidEventsDb, parsedSince, parsedUntil);
        const data: StatsResponse = {
          ...metrics,
          avg_overpay_vs_hashprice_sat_per_ph_day: metrics.avg_overpay_vs_hashprice_sat_per_ph_day,
          avg_cost_per_ph_sat_per_ph_day: metrics.avg_cost_per_ph_sat_per_ph_day,
          avg_intent_overpay_sat_per_ph_day: metrics.avg_intent_overpay_sat_per_ph_day,
          avg_settled_overpay_sat_per_ph_day: metrics.avg_settled_overpay_sat_per_ph_day,
          avg_time_to_fill_ms: avgFillMs,
          mutation_count: mutationCount,
          range: '24h',
          tick_count: metrics.tick_count,
        };
        cache.set(cacheKey, { data, fetched_at: now });
        return data;
      }

      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;

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
        uptime_bid_coverage_pct: metrics.uptime_bid_coverage_pct,
        uptime_delivery_when_bid_active_pct: metrics.uptime_delivery_when_bid_active_pct,
        avg_hashrate_ph: metrics.avg_hashrate_ph,
        avg_datum_hashrate_ph: metrics.avg_datum_hashrate_ph,
        avg_ocean_hashrate_ph: metrics.avg_ocean_hashrate_ph,
        total_ph_hours: metrics.total_ph_hours,
        avg_overpay_vs_hashprice_sat_per_ph_day: metrics.avg_overpay_vs_hashprice_sat_per_ph_day,
        avg_cost_per_ph_sat_per_ph_day: metrics.avg_cost_per_ph_sat_per_ph_day,
        avg_intent_overpay_sat_per_ph_day: metrics.avg_intent_overpay_sat_per_ph_day,
        avg_settled_overpay_sat_per_ph_day: metrics.avg_settled_overpay_sat_per_ph_day,
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
  untilMs?: number,
): Promise<{
  uptime_pct: number | null;
  uptime_bid_coverage_pct: number | null;
  uptime_delivery_when_bid_active_pct: number | null;
  avg_hashrate_ph: number | null;
  avg_datum_hashrate_ph: number | null;
  avg_ocean_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  avg_intent_overpay_sat_per_ph_day: number | null;
  avg_settled_overpay_sat_per_ph_day: number | null;
  tick_count: number;
}> {
  // Defensive: ensure the inlined values are safe integers.
  if (!Number.isFinite(sinceMs)) throw new Error('sinceMs must be finite');
  if (untilMs !== undefined && !Number.isFinite(untilMs)) throw new Error('untilMs must be finite');
  const queryText = `
    SELECT
      COUNT(*) AS tick_count,

      -- Uptime: duration-weighted fraction of clock time when the
      -- counter-derived delivered hashrate was meaningful (>= 0.05
      -- PH/s). Matches the operator-facing tooltip "% of time with
      -- delivered hashrate > 0".
      --
      -- DENOMINATOR (computed JS-side since #290) is the wall-clock
      -- length of the window, clamped to the first tick ever
      -- recorded. Zero-delivery time MUST count toward the
      -- denominator or "uptime" reads as a tautology - earlier
      -- versions filtered both sides on \`delivered_ph > 0.05\`, which
      -- excluded zero-delivery ticks entirely and let the metric
      -- read 87.5% on a window with ~50% true delivery (#86); later
      -- versions summed sane-dur ticks, which excluded daemon-offline
      -- gaps from the clock and read ~99% across a 9 h outage (#290).
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
      -- #290: numerator only - the percentage is computed in JS
      -- against the wall-clock window length, NOT against the sum of
      -- sane-dur ticks. The old denominator filtered dur <= 300000 on
      -- both sides, which threw daemon-offline gaps (one tick whose
      -- dur spans the whole gap) out of the clock entirely: a 9 h
      -- outage in a 24 h window still read ~99% uptime. Offline time
      -- counts as downtime; the 5-minute cap stays on the numerator
      -- so gap time can never count as "up".
      SUM(CASE WHEN dur BETWEEN 1 AND 300000
                AND our_bid > 0
                AND delta IS NOT NULL AND delta >= 0
                AND delta * 86400000000.0 >= 0.05 * our_bid * dur
           THEN dur ELSE 0 END) AS uptime_up_ms,

      -- #254 / #290: time with an active bid (numerator for bid
      -- coverage, same wall-clock denominator treatment as uptime).
      -- Independent of whether the bid was delivering - this measures
      -- orderbook availability ("expected" downtime when low:
      -- nothing matched our criteria). Daemon-offline gaps count as
      -- no-bid time (#290): no reconstruction of whether the bid
      -- survived the gap.
      SUM(CASE WHEN dur BETWEEN 1 AND 300000
                AND our_bid > 0
           THEN dur ELSE 0 END) AS bid_active_ms,

      -- #254: of the time we DID have an active bid, what % was
      -- actually delivering hashrate above the noise floor? Isolates
      -- hardware / connection / Datum-side failures from orderbook
      -- unavailability ("unexpected" downtime when low). Same
      -- threshold logic as uptime_pct's numerator; denominator is
      -- bid-active time instead of total time.
      CASE WHEN SUM(CASE WHEN dur BETWEEN 1 AND 300000 AND our_bid > 0 THEN dur ELSE 0 END) > 0 THEN
        SUM(CASE WHEN dur BETWEEN 1 AND 300000
                  AND our_bid > 0
                  AND delta IS NOT NULL AND delta >= 0
                  AND delta * 86400000000.0 >= 0.05 * our_bid * dur
             THEN dur ELSE 0 END) * 100.0
          / SUM(CASE WHEN dur BETWEEN 1 AND 300000 AND our_bid > 0 THEN dur ELSE 0 END)
      ELSE NULL END AS uptime_delivery_when_bid_active_pct,

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
      ELSE NULL END AS avg_overpay_vs_hashprice,

      -- INTENT overpay (#164): time-weighted mean of (our_bid - fillable_ask)
      -- across every tick where both values are present. Reflects what the
      -- controller targeted, before billing reality. Weighted by tick
      -- duration (not delivery) because the bid sits posted whether we're
      -- delivering or not - idle Braiins still pays the posted price when
      -- delivery picks back up, and the controller's intent in those
      -- ticks is part of the window's average target.
      -- result unit: sat/EH/day. Caller divides by EH_PER_PH → sat/PH/day.
      CASE WHEN SUM(CASE WHEN our_bid > 0 AND fillable_ask IS NOT NULL AND dur BETWEEN 1 AND 300000 THEN dur ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN our_bid > 0 AND fillable_ask IS NOT NULL AND dur BETWEEN 1 AND 300000
            THEN (our_bid - fillable_ask) * dur
            ELSE 0 END) AS REAL)
          / SUM(CASE WHEN our_bid > 0 AND fillable_ask IS NOT NULL AND dur BETWEEN 1 AND 300000 THEN dur ELSE 0 END)
      ELSE NULL END AS avg_intent_overpay,

      -- SETTLED overpay (#164): delta-weighted mean of (effective_rate -
      -- fillable_ask). Same delta/our_bid weighting as avg_cost above so
      -- the two stay consistent. Result equals avg_cost minus the
      -- delta-weighted average fillable_ask during periods we were
      -- actually billed. Zero-delivery ticks contribute zero to both
      -- sides (delta == 0) and don't skew the result.
      CASE WHEN SUM(CASE WHEN valid AND our_bid > 0 AND fillable_ask IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END) > 0 THEN
        CAST(SUM(CASE WHEN valid AND our_bid > 0 AND fillable_ask IS NOT NULL THEN delta ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 AND fillable_ask IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END)
        - (CAST(SUM(CASE WHEN valid AND our_bid > 0 AND fillable_ask IS NOT NULL THEN fillable_ask * CAST(delta AS REAL) / our_bid ELSE 0 END) AS REAL)
          / SUM(CASE WHEN valid AND our_bid > 0 AND fillable_ask IS NOT NULL THEN CAST(delta AS REAL) / our_bid ELSE 0 END))
      ELSE NULL END AS avg_settled_overpay
    FROM (
      SELECT
        tick_at,
        delivered_ph,
        datum_hashrate_ph,
        ocean_hashrate_ph,
        hashprice,
        our_bid,
        fillable_ask,
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
          fillable_ask_sat_per_eh_day AS fillable_ask,
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
        WHERE tick_at >= ${sinceMs}${untilMs !== undefined ? ` AND tick_at <= ${untilMs}` : ''}
      )
    )
  `;
  const row = await sql.raw(queryText).execute(db);

  // #290: wall-clock denominator for uptime + bid coverage. Clamped
  // to the first tick ever recorded so a fresh install (or the All
  // range with sinceMs=0) doesn't divide by pre-install time.
  const firstTickRow = await db
    .selectFrom('tick_metrics')
    .select(db.fn.min('tick_at').as('first_tick'))
    .executeTakeFirst();
  const firstTickMs = firstTickRow?.first_tick != null ? Number(firstTickRow.first_tick) : null;
  const nowMs = Date.now();
  const windowEnd = Math.min(untilMs ?? nowMs, nowMs);
  const windowStart = firstTickMs !== null ? Math.max(sinceMs, firstTickMs) : sinceMs;
  const wallClockMs = windowEnd - windowStart;
  const pctOfWallClock = (numeratorMs: number | null): number | null => {
    if (numeratorMs === null || !(wallClockMs > 0)) return null;
    return Math.min(100, (numeratorMs * 100) / wallClockMs);
  };

  const r = (row as unknown as { rows: Array<Record<string, number | null>> }).rows?.[0];
  if (!r) {
    return {
      tick_count: 0,
      uptime_pct: null,
      uptime_bid_coverage_pct: null,
      uptime_delivery_when_bid_active_pct: null,
      avg_hashrate_ph: null,
      avg_datum_hashrate_ph: null,
      avg_ocean_hashrate_ph: null,
      total_ph_hours: null,
      avg_overpay_vs_hashprice_sat_per_ph_day: null,
      avg_cost_per_ph_sat_per_ph_day: null,
      avg_intent_overpay_sat_per_ph_day: null,
      avg_settled_overpay_sat_per_ph_day: null,
    };
  }

  const tickCount = Number(r['tick_count'] ?? 0);
  return {
    tick_count: tickCount,
    // #290: percentages against wall clock; null when the window has
    // no ticks at all (matches the previous no-data behavior).
    uptime_pct: tickCount > 0 ? pctOfWallClock(r['uptime_up_ms'] !== null ? Number(r['uptime_up_ms']) : 0) : null,
    uptime_bid_coverage_pct: tickCount > 0 ? pctOfWallClock(r['bid_active_ms'] !== null ? Number(r['bid_active_ms']) : 0) : null,
    uptime_delivery_when_bid_active_pct:
      r['uptime_delivery_when_bid_active_pct'] !== null
        ? Number(r['uptime_delivery_when_bid_active_pct'])
        : null,
    avg_hashrate_ph: r['avg_hashrate'] !== null ? Number(r['avg_hashrate']) : null,
    avg_datum_hashrate_ph:
      r['avg_datum_hashrate'] !== null ? Number(r['avg_datum_hashrate']) : null,
    avg_ocean_hashrate_ph:
      r['avg_ocean_hashrate'] !== null ? Number(r['avg_ocean_hashrate']) : null,
    total_ph_hours: r['total_ph_hours'] !== null ? Number(r['total_ph_hours']) : null,
    // SQL returns sat/EH/day; convert to sat/PH/day for the dashboard.
    avg_overpay_vs_hashprice_sat_per_ph_day: r['avg_overpay_vs_hashprice'] !== null ? Number(r['avg_overpay_vs_hashprice']) / EH_PER_PH : null,
    avg_cost_per_ph_sat_per_ph_day: r['avg_cost'] !== null ? Number(r['avg_cost']) / EH_PER_PH : null,
    avg_intent_overpay_sat_per_ph_day: r['avg_intent_overpay'] !== null ? Number(r['avg_intent_overpay']) / EH_PER_PH : null,
    avg_settled_overpay_sat_per_ph_day: r['avg_settled_overpay'] !== null ? Number(r['avg_settled_overpay']) / EH_PER_PH : null,
  };
}

/**
 * Count every successful bid mutation (CREATE / EDIT_PRICE /
 * EDIT_SPEED / CANCEL) recorded in `bid_events` during the range.
 * bid_events is append-only and only populated on successful wire
 * execution, so this is a clean count of "what the controller
 * actually did" - DRY_RUN / BLOCKED proposals never get here.
 */
async function computeMutationCount(
  db: Kysely<Database>,
  sinceMs: number,
  untilMs?: number,
): Promise<number> {
  let q = db
    .selectFrom('bid_events')
    .select(sql<number>`COUNT(*)`.as('count'))
    .where('occurred_at', '>=', sinceMs)
    // #287: mode switches and observed Braiins pause/resume
    // transitions live in bid_events for the History page but they
    // aren't Braiins mutations - keep this counter's meaning.
    .where('kind', 'not in', ['MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED']);
  if (untilMs !== undefined) q = q.where('occurred_at', '<=', untilMs);
  const row = await q.executeTakeFirst();
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
  untilMs?: number,
): Promise<number | null> {
  let q = db
    .selectFrom('bid_events')
    .select(['occurred_at'])
    .where('occurred_at', '>=', sinceMs);
  if (untilMs !== undefined) q = q.where('occurred_at', '<=', untilMs);
  const events = await q
    .where('kind', 'in', ['CREATE_BID', 'EDIT_PRICE'])
    .orderBy('occurred_at', 'asc')
    .execute();

  if (events.length === 0) return null;

  // Single pass: inline event timestamps into a VALUES clause and use
  // a correlated subquery to find each one's first delivery tick.
  // Event times are internally computed numbers (safe to interpolate).
  const eventTimes = events.map((e) => e.occurred_at);
  const valueRows = eventTimes.map((t) => `(${t})`).join(', ');
  const raw = `
    SELECT AVG(fill_ms) AS avg_fill_ms FROM (
      SELECT ev.column1 AS evt,
        (SELECT MIN(tick_at) FROM tick_metrics
         WHERE tick_at > ev.column1 AND delivered_ph > 0) - ev.column1 AS fill_ms
      FROM (VALUES ${valueRows}) AS ev
    ) WHERE fill_ms IS NOT NULL
  `;
  const result = await sql.raw(raw).execute(db);
  const row = (result as unknown as { rows: Array<{ avg_fill_ms: number | null }> }).rows?.[0];
  return row?.avg_fill_ms ?? null;
}
