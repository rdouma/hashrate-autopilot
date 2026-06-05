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
  /** #120: snapshot the overpay setting at event time. */
  overpay_sat_per_eh_day: number | null;
  /** #120: snapshot the dynamic-cap ceiling at event time. */
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
}

export interface BidEventRow extends BidEventInsert {
  id: number;
}

export class BidEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(event: BidEventInsert): Promise<void> {
    await this.db.insertInto('bid_events').values(event).execute();
  }

  async listSince(sinceMs: number, untilMs?: number): Promise<BidEventRow[]> {
    let q = this.db
      .selectFrom('bid_events')
      .selectAll()
      .where('occurred_at', '>=', sinceMs);
    if (untilMs !== undefined) q = q.where('occurred_at', '<=', untilMs);
    return q
      .orderBy('occurred_at', 'asc')
      .execute();
  }

  /**
   * #256 follow-up: paginated bid summaries for the History page.
   * Groups events by `braiins_order_id`, returns one row per order
   * with the time range, event count, and first/last price. Sorted
   * newest-bid first. `beforeMs` is the cursor: pass the
   * `last_event_at_ms` from the oldest row of the previous page to
   * get the next page back.
   *
   * Events with `braiins_order_id IS NULL` (the brief window between
   * a CREATE_BID and the Braiins API echoing back the order id on
   * the next tick) are bucketed under their successor event's order
   * id when possible; otherwise dropped from the summary. The exact
   * orphan-CREATE row stays visible in the per-bid event list when
   * the operator expands the bid - it's just not its own bid for
   * the summary.
   */
  async listBidSummaries(args: {
    limit: number;
    beforeMs?: number;
  }): Promise<
    Array<{
      braiins_order_id: string;
      first_event_at_ms: number;
      last_event_at_ms: number;
      first_price_sat: number | null;
      last_price_sat: number | null;
      event_count: number;
      has_cancel: 0 | 1;
    }>
  > {
    const rows = await this.db
      .selectFrom('bid_events')
      .select(({ fn, eb }) => [
        'braiins_order_id',
        fn.min<number>('occurred_at').as('first_event_at_ms'),
        fn.max<number>('occurred_at').as('last_event_at_ms'),
        fn.count<number>('id').as('event_count'),
        fn
          .max<number>(
            eb
              .case()
              .when('kind', '=', 'CANCEL_BID')
              .then(1)
              .else(0)
              .end(),
          )
          .as('has_cancel'),
      ])
      .where('braiins_order_id', 'is not', null)
      .groupBy('braiins_order_id')
      .orderBy('last_event_at_ms', 'desc')
      .limit(args.limit + 1)
      .execute();
    const filtered = args.beforeMs !== undefined
      ? rows.filter((r) => Number(r.last_event_at_ms) < args.beforeMs!)
      : rows;
    const page = filtered.slice(0, args.limit);

    // For each bid get first/last price - separate query because
    // SQLite's aggregate window functions don't reach back into the
    // original row easily for "value at MIN(occurred_at)" semantics.
    const ids = page.map((r) => r.braiins_order_id).filter((s): s is string => s !== null);
    if (ids.length === 0) return [];
    const priceRows = await this.db
      .selectFrom('bid_events')
      .select(['braiins_order_id', 'occurred_at', 'new_price_sat'])
      .where('braiins_order_id', 'in', ids)
      .where('new_price_sat', 'is not', null)
      .orderBy('occurred_at', 'asc')
      .execute();
    const firstPrice = new Map<string, number>();
    const lastPrice = new Map<string, number>();
    for (const r of priceRows) {
      if (r.braiins_order_id === null) continue;
      if (!firstPrice.has(r.braiins_order_id) && r.new_price_sat !== null) {
        firstPrice.set(r.braiins_order_id, r.new_price_sat);
      }
      if (r.new_price_sat !== null) {
        lastPrice.set(r.braiins_order_id, r.new_price_sat);
      }
    }

    return page.map((r) => ({
      braiins_order_id: r.braiins_order_id!,
      first_event_at_ms: Number(r.first_event_at_ms),
      last_event_at_ms: Number(r.last_event_at_ms),
      first_price_sat: firstPrice.get(r.braiins_order_id!) ?? null,
      last_price_sat: lastPrice.get(r.braiins_order_id!) ?? null,
      event_count: Number(r.event_count),
      has_cancel: Number(r.has_cancel) === 1 ? 1 : 0,
    }));
  }

  /**
   * All events for a single bid, oldest first. Used when the
   * operator expands a bid header on the History page.
   */
  async listEventsForOrder(braiinsOrderId: string): Promise<BidEventRow[]> {
    return this.db
      .selectFrom('bid_events')
      .selectAll()
      .where('braiins_order_id', '=', braiinsOrderId)
      .orderBy('occurred_at', 'asc')
      .execute();
  }
}
