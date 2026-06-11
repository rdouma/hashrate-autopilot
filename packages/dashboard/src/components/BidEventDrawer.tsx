/**
 * #285: slide-over drawer that surfaces the full context of a bid
 * event from the History page. The chart's pinned BidEventTooltip on
 * PriceChart already shows this information when you click a marker;
 * the drawer is the same content reachable from the table without
 * leaving the page.
 *
 * Content shown:
 *   - Action header (kind + automatic/manual badge + close)
 *   - Local + UTC timestamp
 *   - Kind-specific rows (price, speed, budget, delta)
 *   - Market snapshot at the event tick (fillable, hashprice, max bid,
 *     effective cap, overpay snapshots) - fetched on drawer open via
 *     a tight ±60 s window against /api/metrics
 *   - Full reason text (no truncate)
 *   - Bid id
 *   - Copy as JSON button (event + market_at_event payload)
 *   - "View on chart →" link that navigates to /?focus_event=<id>;
 *     Status.tsx pans the chart viewport to the event timestamp
 *
 * Mobile: full-screen takeover. Desktop: right-aligned drawer ~24 rem
 * wide. Esc / click on the backdrop / X button dismisses.
 *
 * Why fetch market data here (not on the History row): the table's
 * page response would balloon if we joined tick_metrics for every
 * row, and most rows are skimmed without opening the drawer. Fetching
 * on demand keeps the table load cheap.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api, type BidHistoryFlatEvent, type MetricPoint } from '../lib/api';
import { useFormatters } from '../lib/locale';
import { formatNumber } from '../lib/format';
import { formatAgeMinutes, formatTimestampUtc } from '../lib/format';
import { copyToClipboard } from '../lib/clipboard';
import { SatSymbol } from './SatSymbol';

export interface BidEventDrawerProps {
  readonly event: BidHistoryFlatEvent;
  readonly onClose: () => void;
}

export function BidEventDrawer({ event, onClose }: BidEventDrawerProps): React.JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  // Esc closes. Bind on the document while the drawer is mounted so
  // the table underneath keeps its own keyboard shortcuts free.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Market snapshot fetch: ±60 s window around the event timestamp.
  // Tight window keeps the response tiny (couple of ticks at most);
  // we pick the closest tick to the event time as the snapshot.
  const WINDOW_MS = 60_000;
  const marketQuery = useQuery({
    queryKey: ['drawer-market', event.occurred_at],
    queryFn: () =>
      api.metricsViewport(
        event.occurred_at - WINDOW_MS,
        event.occurred_at + WINDOW_MS,
      ),
    staleTime: 5 * 60_000,
  });
  const marketAtEvent: MetricPoint | null = useMemo(() => {
    const pts = marketQuery.data?.points;
    if (!pts || pts.length === 0) return null;
    let best: MetricPoint | null = null;
    let bestDiff = Infinity;
    for (const p of pts) {
      const d = Math.abs(p.tick_at - event.occurred_at);
      if (d < bestDiff) {
        bestDiff = d;
        best = p;
      }
    }
    return best;
  }, [marketQuery.data, event.occurred_at]);

  // The event row carries its own overpay snapshot (#120) - prefer
  // that over the chart-tick value so editing overpay after the fact
  // doesn't rewrite history.
  const overpayAtEvent = event.overpay_sat_per_ph_day ?? null;
  const maxOverpayAtEvent = event.max_overpay_vs_hashprice_sat_per_ph_day ?? null;

  // Effective cap (matching the chart tooltip's logic): min(max_bid,
  // hashprice + max_overpay_vs_hashprice) when both legs are present;
  // otherwise just max_bid.
  const effectiveCapAtEvent = useMemo(() => {
    if (!marketAtEvent || marketAtEvent.max_bid_sat_per_ph_day === null) return null;
    const fixed = marketAtEvent.max_bid_sat_per_ph_day;
    const hashprice = marketAtEvent.hashprice_sat_per_ph_day;
    const dyn =
      maxOverpayAtEvent !== null && hashprice !== null
        ? hashprice + maxOverpayAtEvent
        : null;
    return dyn !== null ? Math.min(fixed, dyn) : fixed;
  }, [marketAtEvent, maxOverpayAtEvent]);

  const kindLabel =
    event.kind === 'CREATE_BID'
      ? t`CREATE`
      : event.kind === 'EDIT_PRICE'
        ? t`EDIT PRICE`
        : event.kind === 'EDIT_SPEED'
          ? t`EDIT SPEED`
          : event.kind === 'MODE_CHANGE'
            ? t`MODE CHANGE`
            : event.kind === 'BID_PAUSED'
              ? t`BID PAUSED`
              : event.kind === 'BID_RESUMED'
                ? t`BID RESUMED`
                : t`CANCEL`;
  const sourceLabel = event.source === 'OPERATOR' ? t`manual` : t`automatic`;
  const headerColor =
    event.kind === 'CREATE_BID'
      ? 'text-emerald-300'
      : event.kind === 'EDIT_PRICE'
        ? 'text-amber-300'
        : event.kind === 'EDIT_SPEED'
          ? 'text-sky-300'
          : event.kind === 'MODE_CHANGE'
            ? 'text-violet-300'
            : event.kind === 'BID_PAUSED'
              ? 'text-amber-300'
              : event.kind === 'BID_RESUMED'
                ? 'text-emerald-300'
                : 'text-red-300';

  const oldPrice = event.old_price_sat_per_ph_day;
  const newPrice = event.new_price_sat_per_ph_day;
  const delta = oldPrice !== null && newPrice !== null ? newPrice - oldPrice : null;

  const copyJson = async () => {
    const payload = {
      event,
      market_at_event: marketAtEvent
        ? {
            tick_at: marketAtEvent.tick_at,
            fillable_ask_sat_per_ph_day: marketAtEvent.fillable_ask_sat_per_ph_day,
            hashprice_sat_per_ph_day: marketAtEvent.hashprice_sat_per_ph_day,
            max_bid_sat_per_ph_day: marketAtEvent.max_bid_sat_per_ph_day,
            effective_cap_sat_per_ph_day: effectiveCapAtEvent,
            overpay_sat_per_ph_day: overpayAtEvent,
            max_overpay_vs_hashprice_sat_per_ph_day: maxOverpayAtEvent,
            our_primary_price_sat_per_ph_day: marketAtEvent.our_primary_price_sat_per_ph_day,
          }
        : null,
    };
    try {
      await copyToClipboard(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };

  const goToChart = () => {
    // Pass both the id (for symmetry / future use) and the timestamp
    // so Status doesn't need a round-trip to look the event up.
    navigate(`/?focus_event=${event.id}&at=${event.occurred_at}`);
  };

  const body = (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop. Click to close. */}
      <div
        className="flex-1 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel. Full-screen on mobile, fixed-width on >= sm. */}
      <aside
        className="bg-slate-900 border-l border-slate-700 shadow-2xl w-full sm:w-[24rem] max-w-full overflow-y-auto pointer-events-auto flex flex-col"
        role="dialog"
        aria-label={t`Bid event detail`}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <div className={`text-xs font-semibold uppercase tracking-wider ${headerColor}`}>
              {kindLabel} <span className="text-slate-500">· {sourceLabel}</span>
            </div>
            <div className="text-xs text-slate-300 mt-1 whitespace-nowrap">
              {fmt.timestamp(event.occurred_at)}
              <span className="text-slate-500 ml-2">· {formatAgeMinutes(event.occurred_at)}</span>
            </div>
            <div className="text-[10px] text-slate-500">{formatTimestampUtc(event.occurred_at)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-lg -mt-0.5 px-1"
          >
            ×
          </button>
        </div>

        <div className="flex-1 px-4 py-3 space-y-3">
          {event.reason && (
            <section>
              <SectionHeader label={t`reason`} />
              <p className="text-xs text-slate-200 italic whitespace-normal leading-snug">
                {event.reason}
              </p>
            </section>
          )}

          {event.kind === 'CREATE_BID' && (
            <section>
              <SectionHeader label={t`create`} />
              <Row label={t`price`} value={`${formatNumber(Math.round(newPrice ?? 0), {})} sat/PH/day`} />
              <Row label={t`speed`} value={`${event.speed_limit_ph ?? '-'} PH/s`} />
              <Row label={t`budget`} value={`${formatNumber(event.amount_sat ?? 0, {})} sat`} />
            </section>
          )}
          {event.kind === 'EDIT_PRICE' && (
            <section>
              <SectionHeader label={t`edit price`} />
              <Row
                label={t`price`}
                value={`${formatNumber(Math.round(oldPrice ?? 0), {})} → ${formatNumber(Math.round(newPrice ?? 0), {})} sat/PH/day`}
              />
              {delta !== null && (
                <Row
                  label={t`delta`}
                  value={`${delta >= 0 ? '+' : ''}${formatNumber(Math.round(delta), {})} sat/PH/day`}
                />
              )}
            </section>
          )}
          {event.kind === 'EDIT_SPEED' && (
            <section>
              <SectionHeader label={t`edit speed`} />
              <Row label={t`new speed`} value={`${event.speed_limit_ph ?? '-'} PH/s`} />
            </section>
          )}
          {event.kind === 'CANCEL_BID' && (
            <section>
              <SectionHeader label={t`cancel`} />
              <p className="text-xs text-slate-400 italic">
                <Trans>Bid was cancelled. See reason above.</Trans>
              </p>
            </section>
          )}

          <section>
            <SectionHeader label={t`market at this tick`} />
            {marketQuery.isLoading && (
              <p className="text-xs text-slate-500 italic">
                <Trans>loading…</Trans>
              </p>
            )}
            {!marketQuery.isLoading && !marketAtEvent && (
              <p className="text-xs text-slate-500 italic">
                <Trans>no tick recorded near this event</Trans>
              </p>
            )}
            {marketAtEvent && (
              <>
                {event.fillable_at_event_sat_per_ph_day !== null && (
                  <Row label={t`fillable`} value={`${formatNumber(Math.round(event.fillable_at_event_sat_per_ph_day), {})} sat/PH/day`} />
                )}
                {overpayAtEvent !== null && (
                  <Row label={t`overpay`} value={`${formatNumber(Math.round(overpayAtEvent), {})} sat/PH/day`} />
                )}
                {marketAtEvent.hashprice_sat_per_ph_day !== null && (
                  <Row label={t`hashprice`} value={`${formatNumber(Math.round(marketAtEvent.hashprice_sat_per_ph_day), {})} sat/PH/day`} />
                )}
                {maxOverpayAtEvent !== null && (
                  <Row label={t`max overpay vs hashprice`} value={`${formatNumber(Math.round(maxOverpayAtEvent), {})} sat/PH/day`} />
                )}
                {marketAtEvent.max_bid_sat_per_ph_day !== null && (
                  <Row label={t`max bid`} value={`${formatNumber(Math.round(marketAtEvent.max_bid_sat_per_ph_day), {})} sat/PH/day`} />
                )}
                {effectiveCapAtEvent !== null && (
                  <Row label={t`effective cap`} value={`${formatNumber(Math.round(effectiveCapAtEvent), {})} sat/PH/day`} />
                )}
              </>
            )}
          </section>

          {event.braiins_order_id && (
            <section>
              <SectionHeader label={t`bid id`} />
              <p className="text-[11px] font-mono text-slate-300 break-all">
                {event.braiins_order_id}
              </p>
            </section>
          )}
        </div>

        <div className="border-t border-slate-800 px-4 py-3 sticky bottom-0 bg-slate-900 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={copyJson}
            className={`px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 inline-flex items-center gap-1.5 text-[11px] ${copied ? 'text-emerald-300' : 'text-slate-200'}`}
          >
            {copied ? <Trans>copied</Trans> : <Trans>copy JSON</Trans>}
          </button>
          <button
            type="button"
            onClick={goToChart}
            className="text-[11px] text-amber-300 hover:underline inline-flex items-center gap-1"
            title={t`Open the price chart pinned to this event`}
          >
            <Trans>View on chart</Trans>{' →'}
          </button>
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">
      {label}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  // Strip the trailing `sat/PH/day` so the unit reads small + muted
  // beside the number, matching the rest of the dashboard's idiom.
  const m = value.match(/^(.+?)\s+sat\/PH\/day$/);
  return (
    <div className="flex justify-between gap-3 text-xs text-slate-300">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono tabular-nums">
        {m ? (
          <>
            {m[1]}
            <span className="text-slate-500 text-[10px] ml-1">
              <SatSymbol className="opacity-70" />/PH/day
            </span>
          </>
        ) : (
          value
        )}
      </span>
    </div>
  );
}
