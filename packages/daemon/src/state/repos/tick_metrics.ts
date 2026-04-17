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
      ])
      .where('tick_at', '>=', sinceMs)
      .groupBy(sql`tick_at / ${sql.lit(bucketMs)}`)
      .orderBy(sql`tick_at / ${sql.lit(bucketMs)}`, 'asc')
      .limit(limit)
      .execute();

    return rows;
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
