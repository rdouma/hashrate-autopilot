/**
 * Tiny read-only repo for `reward_events` aggregations consumed by
 * the per-tick observer (#102).
 *
 * Writes happen in payout-observer.ts (it owns the polling +
 * insertion path); this repo only exposes read methods needed by
 * tick_metrics or the dashboard. Keeping the read side here avoids
 * a circular import between observe and payout-observer.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export class RewardEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async listSince(sinceMs: number): Promise<{
    id: number;
    txid: string;
    vout: number;
    block_height: number;
    confirmations: number;
    value_sat: number;
    detected_at: number;
    reorged: number;
  }[]> {
    return this.db
      .selectFrom('reward_events')
      .selectAll()
      .where('detected_at', '>=', sinceMs)
      .orderBy('detected_at', 'asc')
      .execute();
  }

  /**
   * #226: highest `id` currently in the table, used by the alert
   * evaluator to baseline the `payout_confirmed` watermark at boot so
   * the silent-baseline pattern works the same way it does for
   * pool_block_credited (#117): everything that's already in the
   * ledger when the daemon starts is treated as already-known, only
   * new rows fire the celebration. Returns `null` when the table is
   * empty.
   */
  async maxId(): Promise<number | null> {
    const row = await this.db
      .selectFrom('reward_events')
      .select((eb) => eb.fn.max<number>('id').as('m'))
      .executeTakeFirst();
    const v = row?.m ?? null;
    return v === null ? null : Number(v);
  }

  /**
   * #226: rows with `id > sinceId`, ascending, non-reorged. The alert
   * evaluator scans this every tick to fire `payout_confirmed` on
   * exactly the new on-chain payouts. We filter out reorged rows
   * because firing the celebration for a payout that later got
   * un-confirmed would mislead the operator; if a reorg has already
   * been observed by the time we're scanning, drop it.
   */
  async sinceId(sinceId: number): Promise<{
    id: number;
    txid: string;
    vout: number;
    block_height: number;
    confirmations: number;
    value_sat: number;
    detected_at: number;
    reorged: number;
  }[]> {
    return this.db
      .selectFrom('reward_events')
      .selectAll()
      .where('id', '>', sinceId)
      .where('reorged', '=', 0)
      .orderBy('id', 'asc')
      .execute();
  }

  /**
   * Cumulative sum of `value_sat` for non-reorged reward events with
   * `detected_at <= sinceMs`. Used as `paid_total_sat` per tick - the
   * monotonically non-decreasing partner to `ocean_unpaid_sat` so the
   * lifetime-earnings line on the chart survives payout cliffs.
   *
   * Returns 0 when there are no rows (fresh install / payout_source =
   * 'none' / address never paid). Caller decides whether to coerce 0
   * to null (e.g. when no payout observer is wired so the metric is
   * structurally meaningless).
   */
  async sumPaidUpTo(throughMs: number): Promise<number> {
    const row = await this.db
      .selectFrom('reward_events')
      .select((eb) => eb.fn.sum<number>('value_sat').as('s'))
      .where('reorged', '=', 0)
      .where('detected_at', '<=', throughMs)
      .executeTakeFirst();
    return Number(row?.s ?? 0);
  }
}
