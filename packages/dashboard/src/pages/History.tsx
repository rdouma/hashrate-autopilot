/**
 * #256 follow-up: standalone /history page.
 *
 * Replaces the bottom-of-Status OrderHistoryCard. Shows every bid the
 * controller has ever created as a collapsible header; click a bid
 * to expand its modification log inline. Pagination over bid headers
 * (newest first, "load older bids" button at the bottom) so a busy
 * setup doesn't choke on first paint; per-bid modifications load
 * fully on expand, so an active bid with hundreds of EDIT_PRICE
 * events shows the whole life of the bid at once.
 *
 * Column layout mirrors Braiins's own Buy Order History tab:
 * When | Action | Delta | Reason. Delta carries the per-event price
 * delta at a glance; Reason carries the controller's full
 * explanation. The bid header carries summary stats (created → last
 * event, first price → last price, mod count, status badge) so the
 * operator can scan the bid list without expanding.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
  api,
  type BidEventView,
  type BidHistorySummary,
} from '../lib/api';
import { getChartColor, parseOverrides } from '../lib/chartColors';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { formatNumber } from '../lib/format';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 60_000;

export function History() {
  const { i18n } = useLingui();
  void i18n;

  // Bid-summary pagination - "load older bids" appends another page.
  const summariesQuery = useInfiniteQuery({
    queryKey: ['bid-history-summaries'],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.bidHistorySummaries(PAGE_SIZE, pageParam),
    getNextPageParam: (last) => last.next_cursor_ms ?? undefined,
    // Refresh the first page periodically so a new bid landing while
    // the operator is on the page surfaces without a manual refresh.
    refetchInterval: POLL_INTERVAL_MS,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: api.config,
    staleTime: 60_000,
  });
  const overrides = useMemo(
    () => parseOverrides(configQuery.data?.config?.chart_color_overrides),
    [configQuery.data?.config?.chart_color_overrides],
  );

  const allBids: BidHistorySummary[] = useMemo(
    () => summariesQuery.data?.pages.flatMap((p) => p.bids) ?? [],
    [summariesQuery.data],
  );

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-slate-100">
        <Trans>Order history</Trans>
      </h2>
      {summariesQuery.isPending ? (
        <div className="text-xs text-slate-500 italic px-3 py-2">
          <Trans>Loading…</Trans>
        </div>
      ) : allBids.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-500 italic">
          <Trans>No bids recorded yet. Once the controller submits its first bid, it'll show up here.</Trans>
        </div>
      ) : (
        <ul className="space-y-2">
          {allBids.map((bid) => (
            <BidRow key={bid.braiins_order_id} bid={bid} overrides={overrides} />
          ))}
        </ul>
      )}
      {summariesQuery.hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => summariesQuery.fetchNextPage()}
            disabled={summariesQuery.isFetchingNextPage}
            className="text-xs text-amber-300 border border-amber-700 rounded px-3 py-1 hover:bg-amber-500/10 disabled:opacity-40"
          >
            {summariesQuery.isFetchingNextPage ? (
              <Trans>Loading…</Trans>
            ) : (
              <Trans>Load older bids</Trans>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function BidRow({
  bid,
  overrides,
}: {
  bid: BidHistorySummary;
  overrides: Partial<Record<string, string>>;
}) {
  const [open, setOpen] = useState(false);
  const fmt = useFormatters();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const eventsQuery = useQuery({
    queryKey: ['bid-history-events', bid.braiins_order_id],
    queryFn: () => api.bidHistoryEvents(bid.braiins_order_id),
    enabled: open,
    refetchInterval: open ? POLL_INTERVAL_MS : false,
    staleTime: 30_000,
  });

  const statusBadge = (() => {
    if (bid.status === 'cancelled') {
      return (
        <span className="ml-2 inline-block border border-red-500/50 bg-red-500/10 text-red-400 rounded px-1.5 py-px text-[10px] leading-tight">
          <Trans>cancelled</Trans>
        </span>
      );
    }
    return (
      <span className="ml-2 inline-block border border-slate-500/50 bg-slate-500/10 text-slate-400 rounded px-1.5 py-px text-[10px] leading-tight">
        <Trans>closed / active</Trans>
      </span>
    );
  })();

  return (
    <li className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-3 py-2 hover:bg-slate-800/40 flex items-start gap-2"
      >
        <span className="text-slate-500 text-xs mt-1">{open ? '▾' : '▸'}</span>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-slate-300 break-all">
            {bid.braiins_order_id}
            {statusBadge}
          </div>
          <div className="mt-1 text-[11px] text-slate-500 flex flex-wrap gap-x-4 gap-y-0.5">
            <span>
              <Trans>created</Trans> {fmt.timestamp(bid.first_event_at_ms)}{' '}
              <span className="text-slate-600">→</span>{' '}
              {fmt.timestamp(bid.last_event_at_ms)}
            </span>
            <span>
              {bid.first_price_sat_per_ph_day !== null
                ? denomination.formatSatPerPhDay(Math.round(bid.first_price_sat_per_ph_day))
                : '—'}{' '}
              <span className="text-slate-600">→</span>{' '}
              {bid.last_price_sat_per_ph_day !== null
                ? denomination.formatSatPerPhDay(Math.round(bid.last_price_sat_per_ph_day))
                : '—'}
            </span>
            <span>
              {bid.event_count} <Trans>events</Trans>
            </span>
          </div>
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-800">
          {eventsQuery.isPending ? (
            <div className="px-3 py-2 text-xs text-slate-500 italic">
              <Trans>Loading events…</Trans>
            </div>
          ) : (
            <EventsTable
              events={eventsQuery.data?.events ?? []}
              overrides={overrides}
            />
          )}
        </div>
      )}
    </li>
  );
}

function EventsTable({
  events,
  overrides,
}: {
  events: ReadonlyArray<BidEventView>;
  overrides: Partial<Record<string, string>>;
}) {
  const fmt = useFormatters();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;
  const cCreate = getChartColor('events.create', overrides);
  const cEdit = getChartColor('events.edit_price', overrides);
  const cSpeed = getChartColor('events.edit_speed', overrides);
  const cCancel = getChartColor('events.cancel', overrides);

  if (events.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-slate-500 italic">
        <Trans>No events recorded for this bid.</Trans>
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead className="text-slate-500 uppercase tracking-wider bg-slate-950/40">
        <tr>
          <th className="text-left font-normal py-1.5 px-3 w-32"><Trans>When</Trans></th>
          <th className="text-left font-normal py-1.5 px-3 w-32"><Trans>Action</Trans></th>
          <th className="text-right font-normal py-1.5 px-3 w-28"><Trans>Delta</Trans></th>
          <th className="text-left font-normal py-1.5 px-3"><Trans>Reason</Trans></th>
        </tr>
      </thead>
      <tbody className="text-slate-200">
        {events.map((e) => (
          <EventRow
            key={e.id}
            event={e}
            fmt={fmt}
            denomination={denomination}
            colors={{ create: cCreate, edit: cEdit, speed: cSpeed, cancel: cCancel }}
          />
        ))}
      </tbody>
    </table>
  );
}

interface Colors {
  readonly create: string;
  readonly edit: string;
  readonly speed: string;
  readonly cancel: string;
}

function EventRow({
  event,
  fmt,
  denomination,
  colors,
}: {
  event: BidEventView;
  fmt: ReturnType<typeof useFormatters>;
  denomination: ReturnType<typeof useDenomination>;
  colors: Colors;
}) {
  const { i18n } = useLingui();
  void i18n;
  const labels = useActionLabels();
  const intlLocale = 'en-US';
  void intlLocale;
  const deltaText = (() => {
    if (event.kind === 'EDIT_PRICE') {
      if (event.old_price_sat_per_ph_day === null || event.new_price_sat_per_ph_day === null) {
        return '—';
      }
      const delta = event.new_price_sat_per_ph_day - event.old_price_sat_per_ph_day;
      const sign = delta >= 0 ? '+' : '';
      return `${sign}${formatNumber(Math.round(delta), {})}`;
    }
    if (event.kind === 'EDIT_SPEED' && event.speed_limit_ph !== null) {
      return denomination.formatHashrate(event.speed_limit_ph);
    }
    return '';
  })();

  return (
    <tr className="border-t border-slate-800/70 hover:bg-slate-800/30 align-top">
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(event.occurred_at)}
      </td>
      <td className="py-1 px-3 whitespace-nowrap">
        <ActionGlyph kind={event.kind} colors={colors} />
        <span className="ml-1.5 text-slate-200">{labels[event.kind]}</span>
        {event.source === 'OPERATOR' && (
          <span className="ml-1 text-[10px] text-slate-500">
            (<Trans>manual</Trans>)
          </span>
        )}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
        {deltaText}
      </td>
      <td className="py-1 px-3 text-slate-400">{event.reason ?? '—'}</td>
    </tr>
  );
}

function useActionLabels(): Record<BidEventView['kind'], string> {
  return {
    CREATE_BID: t`create`,
    EDIT_PRICE: t`edit price`,
    EDIT_SPEED: t`edit speed`,
    CANCEL_BID: t`cancel`,
  };
}

function ActionGlyph({
  kind,
  colors,
}: {
  kind: BidEventView['kind'];
  colors: Colors;
}) {
  const base = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'inline-block align-middle',
  };
  if (kind === 'CREATE_BID') {
    return (
      <svg {...base} stroke={colors.create}>
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
        <path d="M12 8v8" />
      </svg>
    );
  }
  if (kind === 'EDIT_PRICE') {
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className="inline-block align-middle">
        <circle cx="7" cy="7" r="4.5" fill={colors.edit} stroke="#0f172a" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'EDIT_SPEED') {
    return (
      <svg {...base} stroke={colors.speed}>
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    );
  }
  return (
    <svg {...base} stroke={colors.cancel}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
