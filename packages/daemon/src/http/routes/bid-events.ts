/**
 * GET /api/bid-events?range=<preset>
 *
 * Returns executed CREATE/EDIT/CANCEL bid events inside the given range's
 * visible window, in chronological order. Used by the dashboard chart to
 * overlay markers on the price series.
 *
 * For ranges ≥ 1 month the overlay is suppressed at the product level
 * (individual markers lose signal at that zoom), so the server simply
 * returns an empty list. The dashboard does not need a separate
 * "hide events" switch.
 *
 * Prices are returned in sat/PH/day (internal storage is sat/EH/day;
 * divide by 1000 on serialisation, same convention as /api/metrics).
 *
 * Legacy: `since=<ms>` is still accepted.
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  showEventKindsForSpan,
} from '@hashrate-autopilot/shared';

import type { HttpServerDeps } from '../server.js';

const EH_PER_PH = 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BidEventView {
  readonly id: number;
  readonly occurred_at: number;
  readonly source: 'AUTOPILOT' | 'OPERATOR';
  readonly kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';
  readonly braiins_order_id: string | null;
  readonly old_price_sat_per_ph_day: number | null;
  readonly new_price_sat_per_ph_day: number | null;
  readonly speed_limit_ph: number | null;
  readonly amount_sat: number | null;
  readonly reason: string | null;
  /** #120: snapshot of the overpay setting at event time. Null on legacy rows. */
  readonly overpay_sat_per_ph_day: number | null;
  /** #120: snapshot of the dynamic-cap ceiling at event time. Null on legacy rows. */
  readonly max_overpay_vs_hashprice_sat_per_ph_day: number | null;
}

export async function registerBidEventsRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string; since?: string; until?: string; span?: string } }>(
    '/api/bid-events',
    async (req) => {
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);
      const parsedSpan = Number.parseInt(req.query.span ?? '', 10);

      // #169: arbitrary viewport path: since=<ms>&until=<ms>&span=<ms>
      //
      // `since/until` is the FETCH range (visible viewport plus a 100%
      // buffer on each side for pan-snappiness). `span` is the actual
      // visible span the client expects to be filtered against. When
      // omitted (or before the client started sending it), fall back
      // to `until - since` - the legacy behaviour. The two diverge
      // because `showEventKindsForSpan` returns RARE_KINDS for
      // spans <= 7d and [] above, and fetch span is ~3x visible span:
      // a 60h visible window has fetch span 180h, which the legacy
      // filter dropped to empty even though the client (filtering by
      // visible) still expected RARE_KINDS. Symptom was CREATE / EDIT
      // SPEED / CANCEL glyphs vanishing on any zoom past 56h visible
      // (#265 v3 follow-up).
      if (
        !req.query.range &&
        Number.isFinite(parsedSince) && parsedSince > 0 &&
        Number.isFinite(parsedUntil) && parsedUntil > parsedSince
      ) {
        const visibleSpan =
          Number.isFinite(parsedSpan) && parsedSpan > 0
            ? parsedSpan
            : parsedUntil - parsedSince;
        const kinds = showEventKindsForSpan(visibleSpan);
        if (kinds.length === 0) return { events: [] };
        const allowedKinds = new Set(kinds);
        const rows = await deps.bidEventsRepo.listSince(parsedSince, parsedUntil);
        return { events: rows.filter((r) => allowedKinds.has(r.kind)).map(toView) };
      }

      // Legacy: ?since=<ms> alone forces the classic raw lookup.
      if (!req.query.range && Number.isFinite(parsedSince) && parsedSince > 0) {
        const rows = await deps.bidEventsRepo.listSince(parsedSince);
        return { events: rows.map(toView) };
      }

      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];

      if (spec.showEventKinds.length === 0) {
        return { events: [] };
      }

      const allowedKinds = new Set(spec.showEventKinds);
      const sinceMs =
        spec.windowMs === null
          ? 0
          : Date.now() - spec.windowMs;
      const rows = (
        await deps.bidEventsRepo.listSince(
          sinceMs === 0 ? 0 : Math.max(0, sinceMs),
        )
      ).filter((r) => allowedKinds.has(r.kind));

      // Legacy default window (24 h) if someone calls /api/bid-events
      // with no params at all - unchanged behaviour.
      if (!req.query.range && !Number.isFinite(parsedSince)) {
        const defaultSince = Date.now() - DEFAULT_WINDOW_MS;
        const filtered = rows.filter((r) => r.occurred_at >= defaultSince);
        return { events: filtered.map(toView) };
      }

      return { events: rows.map(toView) };
    },
  );

  // #256 follow-up: History page endpoints.
  //
  // GET /api/bid-history?limit=20&before_ms=<cursor>
  //   Returns paginated bid summaries grouped by braiins_order_id,
  //   newest-first. Cursor is `last_event_at_ms` from the oldest row
  //   of the previous page.
  app.get<{ Querystring: { limit?: string; before_ms?: string } }>(
    '/api/bid-history',
    async (req) => {
      const limit = Math.max(
        1,
        Math.min(100, parseInt(req.query.limit ?? '20', 10) || 20),
      );
      const beforeMs = req.query.before_ms
        ? Number.parseInt(req.query.before_ms, 10)
        : undefined;
      const args =
        beforeMs && beforeMs > 0
          ? { limit, beforeMs }
          : { limit };
      const summaries = await deps.bidEventsRepo.listBidSummaries(args);
      return {
        bids: summaries.map((s) => ({
          braiins_order_id: s.braiins_order_id,
          first_event_at_ms: s.first_event_at_ms,
          last_event_at_ms: s.last_event_at_ms,
          first_price_sat_per_ph_day:
            s.first_price_sat !== null ? s.first_price_sat / EH_PER_PH : null,
          last_price_sat_per_ph_day:
            s.last_price_sat !== null ? s.last_price_sat / EH_PER_PH : null,
          event_count: s.event_count,
          status: s.has_cancel === 1 ? 'cancelled' : 'closed_or_active',
        })),
        next_cursor_ms:
          summaries.length === limit
            ? summaries[summaries.length - 1]!.last_event_at_ms
            : null,
      };
    },
  );

  // GET /api/bid-history/:order_id/events
  //   All events for one specific Braiins order, oldest first.
  app.get<{ Params: { order_id: string } }>(
    '/api/bid-history/:order_id/events',
    async (req) => {
      const rows = await deps.bidEventsRepo.listEventsForOrder(
        req.params.order_id,
      );
      return { events: rows.map(toView) };
    },
  );

  // #256 v2: flat-table /history endpoint with toolbar filters.
  //   Cursor: before_id from the LAST row of the previous page.
  //   Filters: kinds (csv), source, order_id, since_ms, until_ms,
  //            min_abs_price_delta_sat_per_ph_day.
  app.get<{
    Querystring: {
      limit?: string;
      before_id?: string;
      kinds?: string;
      source?: string;
      order_id?: string;
      since_ms?: string;
      until_ms?: string;
      min_abs_price_delta?: string;
    };
  }>('/api/bid-history-events', async (req) => {
    const limit = Math.max(
      1,
      Math.min(500, parseInt(req.query.limit ?? '100', 10) || 100),
    );
    const beforeId = req.query.before_id
      ? Number.parseInt(req.query.before_id, 10)
      : undefined;
    const kinds = req.query.kinds
      ? (req.query.kinds.split(',').filter((s) =>
          ['CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID'].includes(s),
        ) as Array<'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID'>)
      : undefined;
    const source =
      req.query.source === 'AUTOPILOT' || req.query.source === 'OPERATOR'
        ? (req.query.source as 'AUTOPILOT' | 'OPERATOR')
        : undefined;
    const orderIdContains = req.query.order_id?.trim() || undefined;
    const sinceMs = req.query.since_ms
      ? Number.parseInt(req.query.since_ms, 10)
      : undefined;
    const untilMs = req.query.until_ms
      ? Number.parseInt(req.query.until_ms, 10)
      : undefined;
    // Filter is in sat/PH/day on the wire; internal storage is sat/EH/day.
    const minAbsPriceDeltaPhDay = req.query.min_abs_price_delta
      ? Number.parseInt(req.query.min_abs_price_delta, 10)
      : undefined;
    const minAbsPriceDeltaSat =
      minAbsPriceDeltaPhDay && minAbsPriceDeltaPhDay > 0
        ? minAbsPriceDeltaPhDay * EH_PER_PH
        : undefined;

    const args: Parameters<typeof deps.bidEventsRepo.listEventsForHistory>[0] = {
      limit,
    };
    if (beforeId && Number.isFinite(beforeId)) args.beforeId = beforeId;
    if (kinds && kinds.length > 0) args.kinds = kinds;
    if (source) args.source = source;
    if (orderIdContains) args.orderIdContains = orderIdContains;
    if (sinceMs && Number.isFinite(sinceMs)) args.sinceMs = sinceMs;
    if (untilMs && Number.isFinite(untilMs)) args.untilMs = untilMs;
    if (minAbsPriceDeltaSat) args.minAbsPriceDeltaSat = minAbsPriceDeltaSat;

    const rows = await deps.bidEventsRepo.listEventsForHistory(args);
    return {
      events: rows.map((r) => {
        const v = toView(r);
        // #266 follow-up: EDIT_SPEED carries no price columns of its
        // own. Fill from the effective last-known price so the row
        // doesn't have an awkward blank where the bid demonstrably
        // still has a live price; delta is zero by definition.
        const lastPhDay =
          r.kind === 'EDIT_SPEED' && r.effective_last_price_sat !== null
            ? r.effective_last_price_sat / EH_PER_PH
            : null;
        return {
          ...v,
          ...(lastPhDay !== null
            ? {
                old_price_sat_per_ph_day: lastPhDay,
                new_price_sat_per_ph_day: lastPhDay,
              }
            : {}),
          // #256 v2 follow-up: prefer the SQL-coalesced effective IDs
          // and speed so the table never shows an em-dash for a row
          // that's provably tied to a known bid.
          braiins_order_id: r.effective_braiins_order_id ?? r.braiins_order_id,
          speed_limit_ph: r.effective_speed_limit_ph ?? r.speed_limit_ph,
          fillable_at_event_sat_per_ph_day:
            r.fillable_at_event_sat !== null
              ? r.fillable_at_event_sat / EH_PER_PH
              : null,
        };
      }),
      next_cursor_id: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  });
}

function toView(r: {
  id: number;
  occurred_at: number;
  source: 'AUTOPILOT' | 'OPERATOR';
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';
  braiins_order_id: string | null;
  old_price_sat: number | null;
  new_price_sat: number | null;
  speed_limit_ph: number | null;
  amount_sat: number | null;
  reason: string | null;
  overpay_sat_per_eh_day: number | null;
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
}): BidEventView {
  return {
    id: r.id,
    occurred_at: r.occurred_at,
    source: r.source,
    kind: r.kind,
    braiins_order_id: r.braiins_order_id,
    old_price_sat_per_ph_day:
      r.old_price_sat !== null ? r.old_price_sat / EH_PER_PH : null,
    new_price_sat_per_ph_day:
      r.new_price_sat !== null ? r.new_price_sat / EH_PER_PH : null,
    speed_limit_ph: r.speed_limit_ph,
    amount_sat: r.amount_sat,
    reason: r.reason,
    overpay_sat_per_ph_day:
      r.overpay_sat_per_eh_day !== null ? r.overpay_sat_per_eh_day / EH_PER_PH : null,
    max_overpay_vs_hashprice_sat_per_ph_day:
      r.max_overpay_vs_hashprice_sat_per_eh_day !== null
        ? r.max_overpay_vs_hashprice_sat_per_eh_day / EH_PER_PH
        : null,
  };
}
