/**
 * Append-only log of executed bid events (CREATE / EDIT / CANCEL), from
 * both the tick-driven autopilot and manual operator actions. Drives
 * the marker overlay on the dashboard hashrate chart.
 *
 * Separate from the `decisions` log because decisions is per-tick and
 * does not cover the operator bump-price path, which bypasses the
 * controller entirely.
 */

import type { Kysely } from 'kysely';

import type {
  BidEventKind,
  BidEventSource,
  Database,
} from '../types.js';

export interface BidEventInsert {
  occurred_at: number;
  source: BidEventSource;
  kind: BidEventKind;
  braiins_order_id: string | null;
  old_price_sat: number | null;
  new_price_sat: number | null;
  speed_limit_ph: number | null;
  amount_sat: number | null;
  reason: string | null;
}

export interface BidEventRow extends BidEventInsert {
  id: number;
}

export class BidEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(event: BidEventInsert): Promise<void> {
    await this.db.insertInto('bid_events').values(event).execute();
  }

  async listSince(sinceMs: number): Promise<BidEventRow[]> {
    const rows = await this.db
      .selectFrom('bid_events')
      .selectAll()
      .where('occurred_at', '>=', sinceMs)
      .orderBy('occurred_at', 'asc')
      .execute();
    return rows;
  }
}
