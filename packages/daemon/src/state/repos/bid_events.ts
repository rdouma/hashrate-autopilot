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

  /**
   * #256 v2: flat-table History page query. Cursor pagination
   * (`beforeId` from the oldest row on the previous page), full
   * filter surface from the toolbar.
   *
   * `kinds`, `source`, `orderIdContains`, `sinceMs`, `untilMs`, and
   * `minAbsPriceDeltaSat` all filter independently. Empty means
   * "no constraint on this axis". The query is hand-written rather
   * than going through Kysely's filter builder because we want a
   * single SQL hop that also pulls each event's fillable_ask
   * snapshot - the closest tick at-or-before `occurred_at` - so the
   * dashboard doesn't have to round-trip per row.
   */
  async listEventsForHistory(args: {
    limit: number;
    beforeId?: number;
    kinds?: ReadonlyArray<BidEventKind>;
    source?: BidEventSource;
    orderIdContains?: string;
    sinceMs?: number;
    untilMs?: number;
    /** Absolute |new_price_sat - old_price_sat| in sat/EH/day. EDIT_PRICE only. */
    minAbsPriceDeltaSat?: number;
  }): Promise<
    Array<
      BidEventRow & {
        fillable_at_event_sat: number | null;
        effective_braiins_order_id: string | null;
        effective_speed_limit_ph: number | null;
        /**
         * #266 follow-up: last-known new_price_sat for this bid at or
         * before the row's occurred_at. Lets the dashboard fill the
         * price columns on EDIT_SPEED rows (which carry NULL prices
         * themselves) - operator finds blank prices odd because the
         * bid clearly still has one.
         */
        effective_last_price_sat: number | null;
      }
    >
  > {
    const where: string[] = [];
    if (args.beforeId !== undefined && Number.isFinite(args.beforeId)) {
      where.push(`e.id < ${Math.floor(args.beforeId)}`);
    }
    if (args.kinds && args.kinds.length > 0) {
      const list = args.kinds.map((k) => `'${k}'`).join(',');
      where.push(`e.kind IN (${list})`);
    }
    if (args.source) {
      where.push(`e.source = '${args.source}'`);
    }
    if (args.orderIdContains && /^[A-Za-z0-9._-]+$/.test(args.orderIdContains)) {
      where.push(`e.braiins_order_id LIKE '%${args.orderIdContains}%'`);
    }
    if (args.sinceMs !== undefined && Number.isFinite(args.sinceMs)) {
      where.push(`e.occurred_at >= ${Math.floor(args.sinceMs)}`);
    }
    if (args.untilMs !== undefined && Number.isFinite(args.untilMs)) {
      where.push(`e.occurred_at <= ${Math.floor(args.untilMs)}`);
    }
    if (
      args.minAbsPriceDeltaSat !== undefined &&
      Number.isFinite(args.minAbsPriceDeltaSat) &&
      args.minAbsPriceDeltaSat > 0
    ) {
      const v = Math.floor(args.minAbsPriceDeltaSat);
      // Only meaningful for EDIT_PRICE (the only kind with both
      // old_price_sat and new_price_sat populated and meaningfully
      // diffable). Other kinds bypass this filter entirely so a
      // CREATE/CANCEL doesn't get hidden by a |Δ| threshold.
      where.push(
        `(e.kind != 'EDIT_PRICE' OR ABS(COALESCE(e.new_price_sat,0) - COALESCE(e.old_price_sat,0)) >= ${v})`,
      );
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // #266 follow-up: CTE so the speed coalesce can reference the
    // EFFECTIVE order id (not just the direct e.braiins_order_id).
    // Build 621 used the direct id which still pointed at NULL for
    // CREATE rows that landed before Braiins echoed back - those
    // CREATEs carry the bid's speed but couldn't be joined. With a
    // unified effective_order_id, speed cascades properly even
    // through orphan-CREATE rows.
    //
    // Coalesce window widened from 5 min to 1 hour so older orphan
    // CREATEs whose next event sits further in the future still
    // surface their order id.
    const whereClauseRebased = whereClause.replace(/\be\./g, 'e.');
    const sqlText = `
      WITH events_with_effective_id AS (
        SELECT
          e.*,
          COALESCE(
            e.braiins_order_id,
            (SELECT e2.braiins_order_id
               FROM bid_events e2
              WHERE e2.occurred_at >= e.occurred_at
                AND e2.occurred_at <= e.occurred_at + 3600000
                AND e2.braiins_order_id IS NOT NULL
              ORDER BY e2.occurred_at ASC
              LIMIT 1)
          ) AS effective_order_id
          FROM bid_events e
      )
      SELECT
        e.*,
        e.effective_order_id AS effective_braiins_order_id,
        (SELECT t.fillable_ask_sat_per_eh_day
           FROM tick_metrics t
          WHERE t.tick_at <= e.occurred_at
            AND t.fillable_ask_sat_per_eh_day IS NOT NULL
          ORDER BY t.tick_at DESC
          LIMIT 1) AS fillable_at_event_sat,
        COALESCE(
          e.speed_limit_ph,
          (SELECT e3.speed_limit_ph
             FROM events_with_effective_id e3
            WHERE e3.effective_order_id = e.effective_order_id
              AND e3.effective_order_id IS NOT NULL
              AND e3.speed_limit_ph IS NOT NULL
              AND e3.occurred_at <= e.occurred_at
              AND e3.kind IN ('CREATE_BID', 'EDIT_SPEED')
            ORDER BY e3.occurred_at DESC
            LIMIT 1)
        ) AS effective_speed_limit_ph,
        (SELECT e4.new_price_sat
           FROM events_with_effective_id e4
          WHERE e4.effective_order_id = e.effective_order_id
            AND e4.effective_order_id IS NOT NULL
            AND e4.new_price_sat IS NOT NULL
            AND e4.occurred_at <= e.occurred_at
            AND e4.kind IN ('CREATE_BID', 'EDIT_PRICE')
          ORDER BY e4.occurred_at DESC
          LIMIT 1) AS effective_last_price_sat
        FROM events_with_effective_id e
        ${whereClauseRebased}
        ORDER BY e.id DESC
        LIMIT ${Math.floor(args.limit)}
    `;
    // Kysely raw passthrough.
    const result = await this.db.executeQuery({
      sql: sqlText,
      parameters: [],
      query: { kind: 'RawNode' as never },
    } as never);
    type Row = BidEventRow & {
      fillable_at_event_sat: number | null;
      effective_braiins_order_id: string | null;
      effective_speed_limit_ph: number | null;
      effective_last_price_sat: number | null;
    };
    const rows = (result as unknown as { rows: Row[] }).rows ?? [];
    return rows;
  }
}
