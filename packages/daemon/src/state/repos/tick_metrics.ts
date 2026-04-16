/**
 * Repository for the tick_metrics time series.
 *
 * - One row inserted per tick (best-effort; failures are logged but
 *   don't break the tick loop).
 * - `listSince(ms)` returns the series ordered ascending by tick_at for
 *   the hashrate chart.
 * - Optional retention: `pruneOlderThan(ms)` deletes rows older than
 *   the given wall-clock threshold.
 */

import type { Kysely, Selectable } from 'kysely';

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
  readonly available_balance_sat: number | null;
  readonly run_mode: TickMetricsTable['run_mode'];
  readonly action_mode: TickMetricsTable['action_mode'];
}

export type TickMetricRow = Selectable<TickMetricsTable>;

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

  async pruneOlderThan(cutoffMs: number): Promise<void> {
    await this.db.deleteFrom('tick_metrics').where('tick_at', '<', cutoffMs).execute();
  }
}
