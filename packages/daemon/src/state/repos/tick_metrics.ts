/**
 * Repository for the tick_metrics time series.
 *
 * - One row inserted per tick (best-effort; failures are logged but
 *   don't break the tick loop).
 * - `listSince(ms)` returns the raw series ascending by tick_at.
 * - `listAggregated(ms, bucketMs)` returns bucketed averages for longer
 *   time ranges (1 w → 5 min buckets, 1 m → 1 h buckets, 1 y / all →
 *   1 d buckets). See `@braiins-hashrate/shared` → CHART_RANGE_SPECS.
 * - Optional retention: `pruneOlderThan(ms)` deletes rows older than
 *   the given wall-clock threshold.
 */

import { sql, type Kysely, type Selectable } from 'kysely';

import type { Database, TickMetricsTable } from '../types.js';

export interface InsertTickMetricArgs {
  readonly tick_at: number;
  readonly delivered_ph: number;
  readonly target_ph: number;
  readonly floor_ph: number;
  readonly owned_bid_count: number;
  readonly unknown_bid_count: number;
  readonly our_primary_price_sat_per_eh_day: number | null;
  readonly best_bid_sat_per_eh_day: number | null;
  readonly best_ask_sat_per_eh_day: number | null;
  readonly fillable_ask_sat_per_eh_day: number | null;
  readonly hashprice_sat_per_eh_day: number | null;
  readonly max_bid_sat_per_eh_day: number | null;
  readonly available_balance_sat: number | null;
  readonly datum_hashrate_ph: number | null;
  readonly ocean_hashrate_ph: number | null;
  readonly share_log_pct: number | null;
  readonly spend_sat: number | null;
  readonly primary_bid_consumed_sat: number | null;
  readonly run_mode: TickMetricsTable['run_mode'];
  readonly action_mode: TickMetricsTable['action_mode'];
}

export type TickMetricRow = Selectable<TickMetricsTable>;

/**
 * Bucketed row — matches TickMetricRow shape on the fields the chart
 * consumes. Fields not aggregated here (owned_bid_count, run_mode etc.)
 * are not surfaced, since the chart doesn't need them.
 */
export interface AggregatedTickMetricRow {
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
}

export class TickMetricsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(args: InsertTickMetricArgs): Promise<void> {
    await this.db.insertInto('tick_metrics').values(args).execute();
  }

  async listSince(sinceMs: number, limit = 10_000): Promise<TickMetricRow[]> {
    return this.db
      .selectFrom('tick_metrics')
      .selectAll()
      .where('tick_at', '>=', sinceMs)
      .orderBy('tick_at', 'asc')
      .limit(limit)
      .execute();
  }

  /**
   * Bucketed aggregation. Groups rows by `floor(tick_at / bucketMs)` and
   * returns one row per bucket, using AVG for every numeric field. The
   * anchor timestamp is `MAX(tick_at)` within the bucket (the end of the
   * bucket the operator actually sees).
   *
   * MVP simplification (vs the original issue): `target_ph`, `floor_ph`,
   * `available_balance_sat`, and `best_ask_sat_per_eh_day` are currently
   * averaged; the issue proposed end-of-bucket for the first three and
   * median for the last. The deviation is documented in the same issue;
   * target/floor rarely change mid-bucket so AVG is visually identical,
   * and median in SQLite requires a window-function pass we can layer in
   * later without changing the endpoint.
   */
  async listAggregated(
    sinceMs: number,
    bucketMs: number,
    limit = 10_000,
  ): Promise<AggregatedTickMetricRow[]> {
    if (bucketMs <= 0) {
      const raws = await this.listSince(sinceMs, limit);
      return raws.map((r) => ({
        tick_at: r.tick_at,
        delivered_ph: r.delivered_ph,
        target_ph: r.target_ph,
        floor_ph: r.floor_ph,
        our_primary_price_sat_per_eh_day: r.our_primary_price_sat_per_eh_day,
        best_bid_sat_per_eh_day: r.best_bid_sat_per_eh_day,
        best_ask_sat_per_eh_day: r.best_ask_sat_per_eh_day,
        fillable_ask_sat_per_eh_day: r.fillable_ask_sat_per_eh_day,
        hashprice_sat_per_eh_day: r.hashprice_sat_per_eh_day,
        max_bid_sat_per_eh_day: r.max_bid_sat_per_eh_day,
        available_balance_sat: r.available_balance_sat,
        datum_hashrate_ph: r.datum_hashrate_ph,
        ocean_hashrate_ph: r.ocean_hashrate_ph,
        share_log_pct: r.share_log_pct,
        primary_bid_consumed_sat: r.primary_bid_consumed_sat,
      }));
    }

    const rows = await this.db
      .selectFrom('tick_metrics')
      .select([
        sql<number>`MAX(tick_at)`.as('tick_at'),
        sql<number>`AVG(delivered_ph)`.as('delivered_ph'),
        sql<number>`AVG(target_ph)`.as('target_ph'),
        sql<number>`AVG(floor_ph)`.as('floor_ph'),
        sql<number | null>`AVG(our_primary_price_sat_per_eh_day)`.as(
          'our_primary_price_sat_per_eh_day',
        ),
        sql<number | null>`AVG(best_bid_sat_per_eh_day)`.as('best_bid_sat_per_eh_day'),
        sql<number | null>`AVG(best_ask_sat_per_eh_day)`.as('best_ask_sat_per_eh_day'),
        sql<number | null>`AVG(fillable_ask_sat_per_eh_day)`.as(
          'fillable_ask_sat_per_eh_day',
        ),
        sql<number | null>`AVG(hashprice_sat_per_eh_day)`.as(
          'hashprice_sat_per_eh_day',
        ),
        sql<number | null>`AVG(max_bid_sat_per_eh_day)`.as(
          'max_bid_sat_per_eh_day',
        ),
        sql<number | null>`AVG(available_balance_sat)`.as('available_balance_sat'),
        sql<number | null>`AVG(datum_hashrate_ph)`.as('datum_hashrate_ph'),
        sql<number | null>`AVG(ocean_hashrate_ph)`.as('ocean_hashrate_ph'),
        sql<number | null>`AVG(share_log_pct)`.as('share_log_pct'),
        // Cumulative counter — MAX gives the end-of-bucket value, so
        // bucket-to-bucket deltas yield the actual-spend per bucket.
        // AVG would smear the ramp and break the derived rate.
        sql<number | null>`MAX(primary_bid_consumed_sat)`.as('primary_bid_consumed_sat'),
      ])
      .where('tick_at', '>=', sinceMs)
      .groupBy(sql`tick_at / ${sql.lit(bucketMs)}`)
      .orderBy(sql`tick_at / ${sql.lit(bucketMs)}`, 'asc')
      .limit(limit)
      .execute();

    return rows;
  }

  /**
   * Rolling-window average of `delivered_ph` across all ticks with
   * `tick_at >= sinceMs`. Returns `null` when there are no rows in the
   * window (fresh install, pruned history, daemon just started).
   *
   * Used by the P&L panel's "projected spend/day" and the Braiins panel's
   * runway forecast to smooth over the per-tick delivery jitter that
   * was making both numbers fluctuate wildly. Matches the window Ocean
   * uses for its own "estimated earnings/day at the address's 3-hour
   * hashrate" reading, so the income and spend sides of the P&L panel
   * are on the same cadence.
   */
  async avgDeliveredPhSince(sinceMs: number): Promise<number | null> {
    // Counter-derived: per-tick PH = delta × 86.4e9 / (our_bid × dur).
    // Time-weighted average over the window simplifies to
    // SUM(delta × 86.4e9 / our_bid) / SUM(dur). Uses the same zero-dip
    // filter pattern as actualSpendSatSince — see #52 and the stats.ts
    // rationale. Falls back to null (not AVG(delivered_ph)) when the
    // window has no valid counter-deltas; callers already handle null
    // as "insufficient history".
    const queryText = `
      SELECT
        CASE WHEN SUM(valid_dur) > 0 THEN
          CAST(SUM(delta_over_bid) AS REAL) * 86400000000.0 / SUM(valid_dur)
        ELSE NULL END AS avg_ph
      FROM (
        SELECT
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0
              AND dur BETWEEN 1 AND 300000
              AND our_bid > 0
            THEN (c1 - c0) * 1.0 / our_bid
            ELSE 0
          END AS delta_over_bid,
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0
              AND dur BETWEEN 1 AND 300000
              AND our_bid > 0
            THEN dur
            ELSE 0
          END AS valid_dur
        FROM (
          SELECT
            primary_bid_consumed_sat AS c1,
            LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at) AS c0,
            COALESCE(
              LEAD(tick_at) OVER (ORDER BY tick_at) - tick_at,
              60000
            ) AS dur,
            our_primary_price_sat_per_eh_day AS our_bid
          FROM tick_metrics
          WHERE tick_at >= ${sinceMs}
        )
      )
    `;
    const row = await sql.raw(queryText).execute(this.db);
    const r = (row as unknown as { rows: Array<{ avg_ph: number | null }> }).rows?.[0];
    return r?.avg_ph ?? null;
  }

  /**
   * Range aggregates for the P&L per-day panel (issue #43). Returns the
   * averages + tick-level spend sum needed to compute `spend/day` and
   * `projected income/day` symmetrically over the same window as the
   * hashrate chart's selected range.
   *
   * `tick_count` is included so the dashboard can decide whether the
   * window has enough coverage to trust the averages (fresh install,
   * post-prune, etc.) and badge an `insufficient history` fallback
   * when it doesn't. Unbounded (null `sinceMs`) is supported for the
   * `all` chart range.
   */
  async rangeFinanceAggregates(sinceMs: number | null): Promise<{
    tick_count: number;
    first_tick_at: number | null;
    last_tick_at: number | null;
    avg_hashprice_sat_per_eh_day: number | null;
    avg_delivered_ph: number | null;
    /**
     * Actual sat consumed across the range, summed from per-tick
     * `primary_bid_consumed_sat` deltas. Applies the same zero-dip
     * filter as the stats endpoint — any delta where either endpoint
     * is 0 or the tick gap is out of bounds is skipped. This is what
     * Braiins actually charged us; no bid-price modelling.
     */
    actual_spend_sat: number | null;
  }> {
    let q = this.db.selectFrom('tick_metrics');
    if (sinceMs !== null) q = q.where('tick_at', '>=', sinceMs);
    const row = await q
      .select([
        sql<number>`COUNT(*)`.as('tick_count'),
        sql<number | null>`MIN(tick_at)`.as('first_tick_at'),
        sql<number | null>`MAX(tick_at)`.as('last_tick_at'),
        sql<number | null>`AVG(hashprice_sat_per_eh_day)`.as(
          'avg_hashprice_sat_per_eh_day',
        ),
        sql<number | null>`AVG(delivered_ph)`.as('avg_delivered_ph'),
      ])
      .executeTakeFirstOrThrow();
    const actualSpendSat = await this.actualSpendSatSince(sinceMs);
    return {
      tick_count: row.tick_count,
      first_tick_at: row.first_tick_at ?? null,
      last_tick_at: row.last_tick_at ?? null,
      avg_hashprice_sat_per_eh_day: row.avg_hashprice_sat_per_eh_day ?? null,
      avg_delivered_ph: row.avg_delivered_ph ?? null,
      actual_spend_sat: actualSpendSat,
    };
  }

  /**
   * Rolling-average inputs for the sustained cheap-mode check (#50).
   * Returns the simple-mean best_ask and hashprice over the window, plus
   * the count of samples that contributed to each. Samples with either
   * field null are excluded from that field's average independently —
   * matches how the rest of the stats endpoints handle the common case
   * where hashprice may be cached-null while best_ask is present (or
   * vice versa).
   */
  async cheapModeWindowAggregates(sinceMs: number): Promise<{
    avg_best_ask_sat_per_eh_day: number | null;
    avg_hashprice_sat_per_eh_day: number | null;
    best_ask_sample_count: number;
    hashprice_sample_count: number;
  }> {
    const row = await this.db
      .selectFrom('tick_metrics')
      .select([
        sql<number | null>`AVG(best_ask_sat_per_eh_day)`.as('avg_best_ask'),
        sql<number | null>`AVG(hashprice_sat_per_eh_day)`.as('avg_hashprice'),
        sql<number>`SUM(CASE WHEN best_ask_sat_per_eh_day IS NOT NULL THEN 1 ELSE 0 END)`.as(
          'best_ask_count',
        ),
        sql<number>`SUM(CASE WHEN hashprice_sat_per_eh_day IS NOT NULL THEN 1 ELSE 0 END)`.as(
          'hashprice_count',
        ),
      ])
      .where('tick_at', '>=', sinceMs)
      .executeTakeFirst();
    return {
      avg_best_ask_sat_per_eh_day: row?.avg_best_ask ?? null,
      avg_hashprice_sat_per_eh_day: row?.avg_hashprice ?? null,
      best_ask_sample_count: Number(row?.best_ask_count ?? 0),
      hashprice_sample_count: Number(row?.hashprice_count ?? 0),
    };
  }

  /**
   * Total sat actually consumed across ticks at or after `sinceMs`,
   * summed from valid inter-tick deltas of `primary_bid_consumed_sat`.
   *
   * Filter (matches stats.ts):
   *   - both endpoints of each delta must be > 0 (zero mid-sequence is
   *     a transient "no primary bid" snapshot and LAG across it would
   *     report the recovery counter as fresh spend, inflating the sum
   *     by orders of magnitude — see the April 23 incident)
   *   - delta must be non-negative (primary-bid ID swap produces
   *     a negative; already caught by the > 0 guard but kept
   *     explicit)
   *   - tick gap between 1 ms and 5 min — longer gaps are restarts
   *
   * Unbounded when `sinceMs` is null (used by the P&L `all` range).
   */
  async actualSpendSatSince(sinceMs: number | null): Promise<number | null> {
    const where = sinceMs !== null ? `WHERE tick_at >= ${sinceMs}` : '';
    const queryText = `
      SELECT SUM(delta) AS total_sat
      FROM (
        SELECT
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0 AND dur BETWEEN 1 AND 300000
            THEN c1 - c0
            ELSE 0
          END AS delta
        FROM (
          SELECT
            primary_bid_consumed_sat AS c1,
            LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at) AS c0,
            tick_at - LAG(tick_at) OVER (ORDER BY tick_at) AS dur
          FROM tick_metrics
          ${where}
        )
      )
    `;
    const res = await sql.raw(queryText).execute(this.db);
    const row = (res as unknown as { rows: Array<{ total_sat: number | null }> }).rows?.[0];
    const v = row?.total_sat ?? null;
    return v === null ? null : Number(v);
  }

  /**
   * Trailing duration-weighted effective rate (sat/EH/day) over a
   * rolling window ending at the most recent tick. Powers the hero
   * PRICE card on the Status page — the "live" figure, distinct from
   * the range-averaged `avg cost / PH delivered` in the stats row.
   *
   * Formula (sat/EH/day):
   *   MIN(
   *     Σ(Δsat) × 86_400_000_000 / Σ(delivered_ph × Δt_ms),
   *     Σ(bid × delivered_ph × Δt_ms) / Σ(delivered_ph × Δt_ms)
   *   )
   * — duration-weighted realised rate, capped at the duration-weighted
   * average bid. The cap is structurally required: under pay-your-bid
   * Braiins cannot charge above our bid, so any uncapped result above
   * it is a computation artefact from `delivered_ph` (a trailing
   * `avg_speed_ph`) under-reporting relative to real-time
   * `Δprimary_bid_consumed_sat`. Same cap discipline as `/api/stats`
   * (see stats.ts → "the bid is a hard ceiling").
   *
   * Window choice matters: at 5–20 min the raw ratio routinely exceeds
   * the bid (capped result pegs flat at the bid, hiding all signal).
   * 30+ min lets the avg_speed_ph lag wash out so the unfiltered ratio
   * is self-consistent. Caller picks the window.
   *
   * Same zero-dip filter as `actualSpendSatSince`: each sample
   * requires both endpoints positive, c1 >= c0, tick gap in [1ms,
   * 5min], and delivered_ph > 0. Returns null if no sample in the
   * window passes the filter.
   */
  async effectiveSatPerEhDayWindow(windowMs: number): Promise<number | null> {
    const sinceMs = Date.now() - windowMs;
    const queryText = `
      SELECT
        CASE WHEN SUM(phms) > 0 THEN
          MIN(
            CAST(SUM(dsat) AS REAL) * 86400000000.0 / SUM(phms),
            CAST(SUM(bid_phms) AS REAL) / SUM(phms)
          )
        ELSE NULL END AS rate
      FROM (
        SELECT
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0
              AND dur BETWEEN 1 AND 300000
              AND delivered_ph > 0
              AND bid > 0
            THEN c1 - c0
            ELSE 0
          END AS dsat,
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0
              AND dur BETWEEN 1 AND 300000
              AND delivered_ph > 0
              AND bid > 0
            THEN delivered_ph * dur
            ELSE 0
          END AS phms,
          CASE
            WHEN c1 > 0 AND c0 > 0 AND c1 >= c0
              AND dur BETWEEN 1 AND 300000
              AND delivered_ph > 0
              AND bid > 0
            THEN bid * delivered_ph * dur
            ELSE 0
          END AS bid_phms
        FROM (
          SELECT
            primary_bid_consumed_sat AS c1,
            LAG(primary_bid_consumed_sat) OVER (ORDER BY tick_at) AS c0,
            tick_at - LAG(tick_at) OVER (ORDER BY tick_at) AS dur,
            delivered_ph,
            our_primary_price_sat_per_eh_day AS bid
          FROM tick_metrics
          WHERE tick_at >= ${sinceMs}
        )
      )
    `;
    const res = await sql.raw(queryText).execute(this.db);
    const row = (res as unknown as { rows: Array<{ rate: number | null }> }).rows?.[0];
    return row?.rate ?? null;
  }

  /**
   * Timestamp of the earliest recorded tick, or `null` if the table is
   * empty. Used by the `all` preset to size its aggregation bucket to
   * whatever history actually exists.
   */
  async firstTickAt(): Promise<number | null> {
    const row = await this.db
      .selectFrom('tick_metrics')
      .select(sql<number | null>`MIN(tick_at)`.as('min_tick_at'))
      .executeTakeFirst();
    return row?.min_tick_at ?? null;
  }

  async pruneOlderThan(cutoffMs: number): Promise<void> {
    await this.db.deleteFrom('tick_metrics').where('tick_at', '<', cutoffMs).execute();
  }
}
