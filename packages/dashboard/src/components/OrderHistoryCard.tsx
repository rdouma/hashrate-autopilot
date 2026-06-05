/**
 * #256: Braiins-style order-change history.
 *
 * Renders the controller's `bid_events` for the current chart range as a
 * scrollable table at the bottom of the Status page. Mirrors what Braiins
 * shows under the History tab of the Buy Order window, so the operator
 * doesn't need to round-trip to braiins.com to see what the autopilot
 * has been doing.
 *
 * Glyphs match the chart legend (Lucide circle-plus / edit_price circle
 * / gauge / ban) so the operator's mental "the green + meant CREATE on
 * the chart" lookup carries over.
 *
 * Data source is `/api/bid-events?range=...` (existing endpoint) so
 * nothing new on the backend.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useQuery } from '@tanstack/react-query';

import { api, type BidEventView } from '../lib/api';
import { getChartColor, parseOverrides } from '../lib/chartColors';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { type ChartRange } from '@hashrate-autopilot/shared';
import { useMemo } from 'react';

const REFRESH_INTERVAL_MS = 60_000;
const MAX_ROWS = 200;

interface Props {
  readonly chartRange: ChartRange;
  readonly chartColorOverrides?: string;
}

export function OrderHistoryCard({ chartRange, chartColorOverrides }: Props) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const denomination = useDenomination();
  const overrides = useMemo(() => parseOverrides(chartColorOverrides), [chartColorOverrides]);

  const query = useQuery({
    queryKey: ['order-history', chartRange],
    queryFn: () => api.bidEvents(chartRange),
    refetchInterval: REFRESH_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });

  // Render newest first - operator scans from the top.
  const events = (query.data?.events ?? [])
    .slice()
    .sort((a, b) => b.occurred_at - a.occurred_at)
    .slice(0, MAX_ROWS);

  const cCreate = getChartColor('events.create', overrides);
  const cEdit = getChartColor('events.edit_price', overrides);
  const cSpeed = getChartColor('events.edit_speed', overrides);
  const cCancel = getChartColor('events.cancel', overrides);

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">
        <Trans>Order history</Trans>
      </h3>
      {events.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-500 italic">
          <Trans>
            No bid events in the selected range. Widen the chart range above to see older events.
          </Trans>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500 uppercase tracking-wider bg-slate-950/40 sticky top-0">
                <tr>
                  <th className="text-left font-normal py-1.5 px-3 w-24"><Trans>When</Trans></th>
                  <th className="text-left font-normal py-1.5 px-3 w-28"><Trans>Action</Trans></th>
                  <th className="text-left font-normal py-1.5 px-3"><Trans>Change</Trans></th>
                  <th className="text-right font-normal py-1.5 px-3 hidden sm:table-cell"><Trans>Order</Trans></th>
                  <th className="text-left font-normal py-1.5 px-3 hidden md:table-cell"><Trans>Reason</Trans></th>
                </tr>
              </thead>
              <tbody className="text-slate-200">
                {events.map((e) => (
                  <Row key={e.id} event={e} fmt={fmt} denomination={denomination}
                    colors={{ create: cCreate, edit: cEdit, speed: cSpeed, cancel: cCancel }} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {query.data && query.data.events.length > MAX_ROWS && (
        <div className="text-[10px] text-slate-500 mt-1 px-1">
          {/* Translators: shown when the bid-event list is truncated. */}
          <Trans>Showing the most recent {MAX_ROWS} events for this range.</Trans>
        </div>
      )}
    </section>
  );
}

interface ColorSet {
  readonly create: string;
  readonly edit: string;
  readonly speed: string;
  readonly cancel: string;
}

function Row({
  event,
  fmt,
  denomination,
  colors,
}: {
  event: BidEventView;
  fmt: ReturnType<typeof useFormatters>;
  denomination: ReturnType<typeof useDenomination>;
  colors: ColorSet;
}) {
  const { i18n } = useLingui();
  void i18n;
  const kindLabel = labelForKind(event.kind);
  const orderShort = event.braiins_order_id
    ? event.braiins_order_id.slice(0, 10) + '…'
    : '—';
  return (
    <tr className="border-t border-slate-800/70 hover:bg-slate-800/30">
      <td className="py-1 px-3 align-top font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(event.occurred_at)}
      </td>
      <td className="py-1 px-3 align-top whitespace-nowrap">
        <KindGlyph kind={event.kind} colors={colors} />
        <span className="ml-1.5 text-slate-200">{kindLabel}</span>
        {event.source === 'OPERATOR' && (
          <span className="ml-1 text-[10px] text-slate-500">
            (<Trans>manual</Trans>)
          </span>
        )}
      </td>
      <td className="py-1 px-3 align-top text-slate-300 font-mono whitespace-nowrap">
        {formatChange(event, denomination)}
      </td>
      <td className="py-1 px-3 align-top text-slate-500 font-mono hidden sm:table-cell">
        {orderShort}
      </td>
      <td className="py-1 px-3 align-top text-slate-400 hidden md:table-cell">
        {event.reason ?? '—'}
      </td>
    </tr>
  );
}

function labelForKind(kind: BidEventView['kind']): string {
  switch (kind) {
    case 'CREATE_BID':
      return t`create`;
    case 'EDIT_PRICE':
      return t`edit price`;
    case 'EDIT_SPEED':
      return t`edit speed`;
    case 'CANCEL_BID':
      return t`cancel`;
  }
}

function formatChange(
  e: BidEventView,
  denomination: ReturnType<typeof useDenomination>,
): string {
  if (e.kind === 'CREATE_BID') {
    if (e.new_price_sat_per_ph_day === null) return '—';
    return `${denomination.formatSatPerPhDay(Math.round(e.new_price_sat_per_ph_day))}`;
  }
  if (e.kind === 'EDIT_PRICE') {
    if (e.old_price_sat_per_ph_day === null || e.new_price_sat_per_ph_day === null) return '—';
    const delta = e.new_price_sat_per_ph_day - e.old_price_sat_per_ph_day;
    const sign = delta >= 0 ? '+' : '';
    return `${denomination.formatSatPerPhDay(Math.round(e.old_price_sat_per_ph_day))} → ${denomination.formatSatPerPhDay(Math.round(e.new_price_sat_per_ph_day))} (${sign}${denomination.formatSatPerPhDay(Math.round(delta))})`;
  }
  if (e.kind === 'EDIT_SPEED') {
    if (e.speed_limit_ph === null) return '—';
    return denomination.formatHashrate(e.speed_limit_ph);
  }
  if (e.kind === 'CANCEL_BID') {
    return '—';
  }
  return '—';
}

/**
 * Inline 12×12 SVG matching the chart's top-edge bid-event glyphs
 * (Lucide circle-plus / circle / gauge / ban). EDIT_PRICE uses the
 * same plain filled circle as on the price line; everything else uses
 * the Lucide outline icons.
 */
function KindGlyph({
  kind,
  colors,
}: {
  kind: BidEventView['kind'];
  colors: ColorSet;
}) {
  const base = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
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
  // CANCEL_BID
  return (
    <svg {...base} stroke={colors.cancel}>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
