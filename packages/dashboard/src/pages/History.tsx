/**
 * #256 v2: flat-table /history page.
 *
 * Replaces the per-bid collapsible view. Toolbar of filters at top +
 * flat table + infinite scroll. Server pages 100 events at a time
 * via a `before_id` cursor.
 *
 * Columns: When | Bid (full id) | Action | Fillable | Price before
 *          | Price after | Δ price | Speed | Source. Δ price colour-
 * coded green=down/red=up. Speed/bid id are server-side coalesced
 * across events on the same bid so the column is never empty when
 * the row is provably tied to a known order.
 *
 * Toolbar filters: action kind (chips with Lucide glyphs), bid id
 * substring, date range (browser native date picker, parsed in local
 * time to avoid the off-by-one timezone shift), source (dropdown with
 * a help tooltip explaining what AUTOPILOT vs MANUAL means), and
 * |Δ price| ≥ N in the currently-selected hashrate denomination
 * (TH/PH/EH) - converts to the daemon's sat/EH/day internal unit on
 * the wire. Reset button on the right with a Lucide rotate-ccw icon.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useInfiniteQuery, useQuery, keepPreviousData } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  CONDITION_SPAN_CLASSES,
  conditionSpanClass,
} from '@hashrate-autopilot/shared';
import {
  api,
  type AlertConditionSpanView,
  type BidHistoryFilters,
  type BidHistoryFlatEvent,
  type BidEventView,
} from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { formatNumber, formatDuration } from '../lib/format';
import { CHART_COLOR_DEFAULTS, type ChartColorKey } from '../lib/chartColors';
import { DatePicker } from '../components/DatePicker';
import { BidEventDrawer } from '../components/BidEventDrawer';
import { useLocation, useNavigate } from 'react-router-dom';

const PAGE_SIZE = 100;
type Kind = NonNullable<BidHistoryFilters['kinds']>[number];

/** #316: condition class shown as an alert row + filter chip in History. */
const ALERT_FILTER_CLASSES = CONDITION_SPAN_CLASSES.map((c) => c.openClass);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Translated short label for a condition class (matches the chart bands). */
function conditionLabel(openClass: string): string {
  switch (openClass) {
    case 'hashrate_below_floor': return t`below floor`;
    case 'zero_hashrate': return t`zero hashrate`;
    case 'datum_unreachable': return t`DATUM unreachable`;
    case 'api_unreachable': return t`marketplace API down`;
    case 'wallet_runway': return t`low wallet runway`;
    case 'solo_overheating': return t`Bitaxe overheating`;
    default: return openClass;
  }
}

/**
 * #285 follow-up: persist History filters across navigation. Operator
 * was navigating History → drawer → "View on chart" → back to History
 * and finding the filter chips reset. localStorage survives full page
 * reloads too (not just in-app nav), so the saved filter set follows
 * the operator next session as well. Date range is stored as ms so
 * round-tripping doesn't lose precision.
 */
const FILTERS_STORAGE_KEY = 'hashrate-autopilot.history-filters';

function readStoredFilters(): BidHistoryFilters {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<BidHistoryFilters>;
    // Be defensive: drop anything that doesn't fit the schema (an old
    // build may have written a field we no longer carry). Validators
    // here are intentionally loose - drop on mismatch, never throw.
    const out: BidHistoryFilters = {};
    if (Array.isArray(parsed.kinds)) {
      const valid = parsed.kinds.filter((k): k is Kind =>
        k === 'CREATE_BID' || k === 'EDIT_PRICE' || k === 'EDIT_SPEED' || k === 'CANCEL_BID',
      );
      if (valid.length > 0) out.kinds = valid;
    }
    if (typeof parsed.orderIdContains === 'string' && parsed.orderIdContains.length > 0) {
      out.orderIdContains = parsed.orderIdContains;
    }
    if (typeof parsed.sinceMs === 'number' && Number.isFinite(parsed.sinceMs)) {
      out.sinceMs = parsed.sinceMs;
    }
    if (typeof parsed.untilMs === 'number' && Number.isFinite(parsed.untilMs)) {
      out.untilMs = parsed.untilMs;
    }
    if (typeof parsed.minAbsPriceDelta === 'number' && Number.isFinite(parsed.minAbsPriceDelta)) {
      out.minAbsPriceDelta = parsed.minAbsPriceDelta;
    }
    return out;
  } catch {
    return {};
  }
}

function persistFilters(filters: BidHistoryFilters): void {
  if (typeof window === 'undefined') return;
  try {
    // Empty object is the "no filters" state; clear the slot instead
    // of writing `{}` so a future readStoredFilters returns the
    // default without parsing.
    if (Object.keys(filters).length === 0) {
      window.localStorage.removeItem(FILTERS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
    }
  } catch {
    // localStorage unavailable (private mode etc.). Ignore.
  }
}

export function History() {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const denomination = useDenomination();
  const [filters, setFiltersState] = useState<BidHistoryFilters>(readStoredFilters);
  const setFilters = (next: BidHistoryFilters | ((prev: BidHistoryFilters) => BidHistoryFilters)) => {
    setFiltersState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      persistFilters(value);
      return value;
    });
  };
  const [selectedEvent, setSelectedEvent] = useState<BidHistoryFlatEvent | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<number | null>(null);
  // #316: which alert-condition classes show as rows. Default: all on.
  // An empty set hides every alert row (matching the chip-off semantics).
  const [shownAlertClasses, setShownAlertClasses] = useState<Set<string>>(
    () => new Set(ALERT_FILTER_CLASSES),
  );
  const toggleAlertClass = (c: string) =>
    setShownAlertClasses((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  const location = useLocation();
  const navigate = useNavigate();

  const query = useInfiniteQuery({
    queryKey: ['bid-history-flat', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.bidHistoryFlatEvents(filters, pageParam, PAGE_SIZE),
    getNextPageParam: (last) => last.next_cursor_id ?? undefined,
    refetchInterval: 60_000,
  });

  const events: BidHistoryFlatEvent[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.events) ?? [],
    [query.data],
  );

  // #316: alert-condition spans, fetched for the toolbar's date window
  // (default: last year) and merged into the feed as rows. Sparse, so a
  // single fetch covers the whole window.
  const alertWindow = useMemo(() => {
    const until = filters.untilMs ?? Date.now();
    const since = filters.sinceMs ?? until - YEAR_MS;
    return { since, until };
  }, [filters.sinceMs, filters.untilMs]);
  const alertSpansQuery = useQuery({
    queryKey: ['history-alert-spans', alertWindow.since, alertWindow.until],
    queryFn: () => api.alertSpans(alertWindow.since, alertWindow.until),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  // Bound alert rows to the loaded bid-event range so an old alert can't
  // float at the bottom of the list below a gap of not-yet-loaded bids.
  // When there are no bid events at all, show everything in the window.
  const oldestBidTs = events.length > 0 ? events[events.length - 1]!.occurred_at : null;
  const visibleAlertSpans: AlertConditionSpanView[] = useMemo(() => {
    const spans = alertSpansQuery.data?.spans ?? [];
    return spans.filter(
      (s) =>
        shownAlertClasses.has(s.event_class) &&
        s.start_ms <= alertWindow.until &&
        s.start_ms >= alertWindow.since &&
        (oldestBidTs === null || s.start_ms >= oldestBidTs),
    );
  }, [alertSpansQuery.data, shownAlertClasses, alertWindow, oldestBidTs]);

  // Merged, newest-first timeline of bid events + alert rows.
  type TimelineItem =
    | { kind: 'bid'; ts: number; ev: BidHistoryFlatEvent }
    | { kind: 'alert'; ts: number; span: AlertConditionSpanView };
  const timelineItems: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...events.map((ev) => ({ kind: 'bid' as const, ts: ev.occurred_at, ev })),
      ...visibleAlertSpans.map((span) => ({ kind: 'alert' as const, ts: span.start_ms, span })),
    ];
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [events, visibleAlertSpans]);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [query]);

  // #285: ?focus_event=<id> from the price chart's "Show in history"
  // link. Pull more pages until the target row is loaded, scroll it
  // into view, highlight it briefly, then strip the param so a
  // subsequent navigation doesn't re-trigger the highlight loop.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('focus_event');
    if (!raw) return;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id)) return;
    const match = events.find((e) => e.id === id);
    if (match) {
      // Defer the scroll a tick so the row is in the DOM and any
      // pending re-render has settled.
      requestAnimationFrame(() => {
        const el = document.getElementById(`bid-event-row-${id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      setHighlightedEventId(id);
      window.setTimeout(() => setHighlightedEventId(null), 1500);
      // Strip the param so reloads or in-app nav don't relaunch the
      // highlight. Use replace so the browser back button doesn't
      // land here.
      params.delete('focus_event');
      const next = params.toString();
      navigate(`/history${next ? `?${next}` : ''}`, { replace: true });
    } else if (query.hasNextPage && !query.isFetchingNextPage) {
      // Row isn't in the loaded set; pull another page. The effect
      // will re-run when the new events land and we'll retry.
      void query.fetchNextPage();
    }
    // intentionally not depending on `events`/`query.hasNextPage`
    // values to avoid extra firings; we read the latest snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, events.length, query.hasNextPage]);

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-slate-100">
        <Trans>Order history</Trans>
      </h2>
      <Toolbar
        filters={filters}
        onChange={setFilters}
        shownAlertClasses={shownAlertClasses}
        onToggleAlertClass={toggleAlertClass}
      />
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500 tracking-wider bg-slate-950/40">
            <tr>
              <th className="text-left font-normal py-1.5 px-3 whitespace-nowrap normal-case"><Trans>When</Trans></th>
              <th className="text-left font-normal py-1.5 px-3 normal-case"><Trans>Bid</Trans></th>
              <th className="text-left font-normal py-1.5 px-3 normal-case"><Trans>Action</Trans></th>
              <th className="text-right font-normal py-1.5 px-3 normal-case"><Trans>Fillable</Trans></th>
              <th className="text-right font-normal py-1.5 px-3 normal-case"><Trans>Price before</Trans></th>
              <th className="text-right font-normal py-1.5 px-3 normal-case"><Trans>Price after</Trans></th>
              <th className="text-right font-normal py-1.5 px-3 normal-case"><Trans>Δ price</Trans></th>
              <th className="text-right font-normal py-1.5 px-3 normal-case"><Trans>Speed</Trans></th>
              <th className="text-left font-normal py-1.5 px-3 normal-case"><Trans>Reason</Trans></th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {timelineItems.map((item) =>
              item.kind === 'bid' ? (
                <EventRow
                  key={`bid-${item.ev.id}`}
                  event={item.ev}
                  fmt={fmt}
                  denomination={denomination}
                  highlighted={highlightedEventId === item.ev.id}
                  onClick={() => setSelectedEvent(item.ev)}
                />
              ) : (
                <AlertSpanRow
                  key={`alert-${item.span.open_id}`}
                  span={item.span}
                  fmt={fmt}
                  onClick={() => navigate(`/?at=${item.span.start_ms}`)}
                />
              ),
            )}
            {timelineItems.length === 0 && !query.isPending && (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                  <Trans>No events match the current filters.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div ref={sentinelRef} />
      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="text-xs text-amber-300 border border-amber-700 rounded px-3 py-1 hover:bg-amber-500/10 disabled:opacity-40"
          >
            {query.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
          </button>
        </div>
      )}
      <div className="text-[10px] text-slate-600 text-center pt-1">
        {events.length}{' '}
        {query.hasNextPage ? <Trans>events loaded; scroll for more</Trans> : <Trans>events (end of history)</Trans>}
      </div>
      {selectedEvent && (
        <BidEventDrawer
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function Toolbar({
  filters,
  onChange,
  shownAlertClasses,
  onToggleAlertClass,
}: {
  filters: BidHistoryFilters;
  onChange: (next: BidHistoryFilters) => void;
  /** #316: condition classes currently shown as alert rows. */
  shownAlertClasses: Set<string>;
  onToggleAlertClass: (openClass: string) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const denomination = useDenomination();
  const kinds: Kind[] = filters.kinds ? [...filters.kinds] : [];

  const toggleKind = (k: Kind) => {
    const set = new Set(kinds);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    onChange({ ...filters, kinds: set.size > 0 ? Array.from(set) : undefined });
  };

  // #266 follow-up: locale-aware custom date picker (see DatePicker.tsx).
  // Browser-native input[type=date] always rendered as mm/dd/yyyy
  // regardless of dashboard language - unacceptable for non-en-US
  // operators. The custom picker formats via Intl.DateTimeFormat in
  // the active dashboard locale and emits a local-midnight ms
  // timestamp (start-of-day for sinceMs, end-of-day for untilMs).
  const updateDate = (key: 'sinceMs' | 'untilMs', ms: number | undefined) => {
    const next = { ...filters };
    if (ms === undefined) delete next[key];
    else next[key] = ms;
    onChange(next);
  };

  // #256 v2 follow-up: the Δ price filter input and the |Δ price|
  // value in `filters` are both in the operator's currently-selected
  // hashrate denomination (TH/PH/EH/day). Convert to sat/PH/day for
  // the API on read, which then converts to sat/EH/day for storage.
  // PH is the canonical "internal" unit on the dashboard side; EH/TH
  // come and go via the `denomination` toggle.
  const unitLabel = denomination.hashrateUnit; // 'TH' | 'PH' | 'EH'
  const deltaInPhDay = filters.minAbsPriceDelta ?? null;
  const deltaInUnit = (() => {
    if (deltaInPhDay === null) return '';
    if (unitLabel === 'TH') return String(Math.round(deltaInPhDay / 1000));
    if (unitLabel === 'EH') return String(Math.round(deltaInPhDay * 1000));
    return String(Math.round(deltaInPhDay));
  })();
  const updateDelta = (v: string) => {
    const raw = v ? Number(v) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) {
      const next = { ...filters };
      delete next.minAbsPriceDelta;
      onChange(next);
      return;
    }
    let phDay = raw;
    if (unitLabel === 'TH') phDay = raw * 1000;
    else if (unitLabel === 'EH') phDay = raw / 1000;
    onChange({ ...filters, minAbsPriceDelta: phDay });
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-4 sm:gap-y-2 text-xs">
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>Action</Trans></label>
        <div className="flex flex-wrap gap-1">
          {(['CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID', 'MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED'] as Kind[]).map((k) => (
            <ActionChip
              key={k}
              kind={k}
              active={kinds.includes(k)}
              onClick={() => toggleKind(k)}
            />
          ))}
        </div>
      </div>
      {/* #316: alert-condition rows toggle. Default all on; turning a
          chip off hides that condition's rows (client-side filter). */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>Alerts</Trans></label>
        <div className="flex flex-wrap gap-1">
          {ALERT_FILTER_CLASSES.map((openClass) => {
            const active = shownAlertClasses.has(openClass);
            const color =
              CHART_COLOR_DEFAULTS[
                (conditionSpanClass(openClass)?.colorSlot ?? 'events.alert_below_floor') as ChartColorKey
              ];
            return (
              <button
                key={openClass}
                type="button"
                onClick={() => onToggleAlertClass(openClass)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] ${
                  active
                    ? 'border-slate-600 bg-slate-800 text-slate-200'
                    : 'border-slate-800 text-slate-500 hover:text-slate-300'
                }`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: active ? color : 'transparent', border: `1px solid ${color}` }}
                />
                {conditionLabel(openClass)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>Bid id contains</Trans></label>
        <input
          type="text"
          value={filters.orderIdContains ?? ''}
          onChange={(e) => onChange({ ...filters, orderIdContains: e.target.value || undefined })}
          placeholder="B866…"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full sm:w-32 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      {/* From + To form one logical date-range pair. On mobile they sit
          side-by-side as a single row (sm:contents dissolves this wrapper
          on desktop so each flows into the toolbar's wrap as before). */}
      <div className="flex gap-3 sm:contents">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0 sm:flex-none">
          <label className="text-[10px] tracking-wider text-slate-500"><Trans>From</Trans></label>
          <DatePicker
            value={filters.sinceMs}
            snap="start"
            onChange={(ms) => updateDate('sinceMs', ms)}
            ariaLabel={t`From date`}
            className="w-full sm:w-auto"
          />
        </div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0 sm:flex-none">
          <label className="text-[10px] tracking-wider text-slate-500"><Trans>To</Trans></label>
          <DatePicker
            value={filters.untilMs}
            snap="end"
            onChange={(ms) => updateDate('untilMs', ms)}
            ariaLabel={t`To date`}
            className="w-full sm:w-auto"
          />
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500">
          {t`Δ price ≥ (sat/${unitLabel}/day)`}
        </label>
        <input
          type="number"
          min={0}
          step={unitLabel === 'TH' ? 1 : unitLabel === 'EH' ? 1000 : 100}
          value={deltaInUnit}
          onChange={(e) => updateDelta(e.target.value)}
          placeholder="0"
          className="no-spinner w-full sm:w-24 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      {/* #256 v2 follow-up: Reset button on the RIGHT side with a
          Lucide rotate-ccw icon, labelled "reset" rather than "clear
          all". Full-width, right-aligned row on mobile; ml-auto on desktop. */}
      <button
        type="button"
        onClick={() => onChange({})}
        className="w-full sm:w-auto sm:ml-auto flex items-center justify-end gap-1 text-[11px] text-slate-500 hover:text-amber-300 self-end"
        title={t`Reset all filters`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
        <Trans>reset</Trans>
      </button>
    </div>
  );
}

/**
 * Filter chip for the Action toolbar. Carries the same Lucide glyph
 * as the row's Action column so the toolbar reads as a visual map of
 * what's available in the table.
 */
function ActionChip({
  kind,
  active,
  onClick,
}: {
  kind: Kind;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] ${
        active
          ? 'border-amber-700 text-amber-300 bg-amber-500/10'
          : 'border-slate-700 text-slate-400 hover:border-slate-500'
      }`}
    >
      <ActionGlyph kind={kind} />
      {labelForKindShort(kind)}
    </button>
  );
}

function EventRow({
  event,
  fmt,
  denomination,
  highlighted,
  onClick,
}: {
  event: BidHistoryFlatEvent;
  fmt: ReturnType<typeof useFormatters>;
  denomination: ReturnType<typeof useDenomination>;
  /** #285: ?focus_event= flash after navigation from the chart. */
  highlighted: boolean;
  /** #285: open the bid-event drawer for this row. */
  onClick: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const labels = useActionLabels();
  const oldPrice = event.old_price_sat_per_ph_day;
  const newPrice = event.new_price_sat_per_ph_day;
  const delta =
    oldPrice !== null && newPrice !== null ? newPrice - oldPrice : null;
  // #256 v2 follow-up: full bid id, not truncated.
  const bidId = event.braiins_order_id ?? '—';
  const speedText =
    event.speed_limit_ph !== null
      ? denomination.formatHashrate(event.speed_limit_ph)
      : '—';

  return (
    <tr
      id={`bid-event-row-${event.id}`}
      onClick={onClick}
      className={`border-t border-slate-800/70 align-top cursor-pointer transition-colors ${
        highlighted
          ? 'bg-amber-500/10 ring-1 ring-amber-500/40'
          : 'hover:bg-slate-800/30'
      }`}
    >
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(event.occurred_at)}
      </td>
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {bidId}
      </td>
      <td className="py-1 px-3 whitespace-nowrap">
        <ActionGlyph kind={event.kind} />
        <span className="ml-1.5 text-slate-200">{labels[event.kind]}</span>
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-400 whitespace-nowrap">
        {event.fillable_at_event_sat_per_ph_day !== null
          ? formatNumber(Math.round(event.fillable_at_event_sat_per_ph_day), {})
          : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-400 whitespace-nowrap">
        {oldPrice !== null ? formatNumber(Math.round(oldPrice), {}) : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
        {newPrice !== null ? formatNumber(Math.round(newPrice), {}) : '—'}
      </td>
      <td className={`py-1 px-3 text-right font-mono whitespace-nowrap ${
        delta === null
          ? 'text-slate-500'
          : delta > 0
            ? 'text-red-300'
            : delta < 0
              ? 'text-emerald-300'
              : 'text-slate-500'
      }`}>
        {delta !== null
          ? `${delta >= 0 ? '+' : ''}${formatNumber(Math.round(delta), {})}`
          : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
        {speedText}
      </td>
      {/* #285: reason column. `bid_events.reason` is populated by
          decide.ts for every autopilot-emitted event (CREATE / EDIT_PRICE
          / EDIT_SPEED / CANCEL); operator-initiated rows render '—'.
          Truncate-with-title keeps the column readable on dense screens
          but the full reason is one hover away. The click-row drawer
          carries it in full alongside the rest of the bid-event detail. */}
      <td className="py-1 px-3 text-slate-400 max-w-[20rem] truncate" title={event.reason ?? undefined}>
        {event.reason ?? '—'}
      </td>
    </tr>
  );
}

/**
 * #316: an alerted condition span rendered as a History row. Shares the
 * table grid with bid-event rows; the numeric bid columns are blank.
 * The condition glyph + label are tinted with the same color slot as the
 * chart band. Clicking pans the price chart to the span start.
 */
function AlertSpanRow({
  span,
  fmt,
  onClick,
}: {
  span: AlertConditionSpanView;
  fmt: ReturnType<typeof useFormatters>;
  onClick: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const cls = conditionSpanClass(span.event_class);
  const color = cls ? CHART_COLOR_DEFAULTS[cls.colorSlot as ChartColorKey] : '#fb923c';
  const ongoing = span.end_ms === null;
  const durationMs = (span.end_ms ?? Date.now()) - span.start_ms;
  const dash = <span className="text-slate-600">—</span>;
  return (
    <tr
      onClick={onClick}
      className="border-t border-slate-800/70 align-top cursor-pointer transition-colors hover:bg-slate-800/30"
      title={t`View on chart`}
    >
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(span.start_ms)}
      </td>
      <td className="py-1 px-3 font-mono whitespace-nowrap">{dash}</td>
      <td className="py-1 px-3 whitespace-nowrap">
        <svg
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="inline-block align-middle"
        >
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <span className="ml-1.5" style={{ color }}>
          {conditionLabel(span.event_class)}
        </span>
        <span className="ml-2 text-[11px] text-slate-500 font-mono">
          {ongoing ? t`ongoing` : formatDuration(durationMs)}
        </span>
      </td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-slate-400 max-w-[20rem] truncate" title={span.body}>
        {span.body}
      </td>
    </tr>
  );
}

function useActionLabels(): Record<BidEventView['kind'], string> {
  return {
    CREATE_BID: t`create`,
    EDIT_PRICE: t`edit price`,
    EDIT_SPEED: t`edit speed`,
    CANCEL_BID: t`cancel`,
    // #287: run-mode switches + observed Braiins pause/resume.
    MODE_CHANGE: t`mode change`,
    BID_PAUSED: t`bid paused`,
    BID_RESUMED: t`bid resumed`,
  };
}

function labelForKindShort(kind: Kind): string {
  switch (kind) {
    case 'CREATE_BID': return t`create`;
    case 'EDIT_PRICE': return t`price`;
    case 'EDIT_SPEED': return t`speed`;
    case 'CANCEL_BID': return t`cancel`;
    case 'MODE_CHANGE': return t`mode`;
    case 'BID_PAUSED': return t`paused`;
    case 'BID_RESUMED': return t`resumed`;
  }
}

function ActionGlyph({ kind }: { kind: BidEventView['kind'] }) {
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
      <svg {...base} stroke="#34d399">
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
        <path d="M12 8v8" />
      </svg>
    );
  }
  if (kind === 'EDIT_PRICE') {
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className="inline-block align-middle">
        <circle cx="7" cy="7" r="4.5" fill="#facc15" stroke="#0f172a" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'EDIT_SPEED') {
    return (
      <svg {...base} stroke="#38bdf8">
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    );
  }
  if (kind === 'MODE_CHANGE') {
    // Lucide `power` - run-mode switch (DRY_RUN / LIVE / PAUSED).
    return (
      <svg {...base} stroke="#c4b5fd">
        <path d="M12 2v10" />
        <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
      </svg>
    );
  }
  if (kind === 'BID_PAUSED') {
    // Lucide `circle-pause` - Braiins paused the bid.
    return (
      <svg {...base} stroke="#fbbf24">
        <circle cx="12" cy="12" r="10" />
        <line x1="10" x2="10" y1="15" y2="9" />
        <line x1="14" x2="14" y1="15" y2="9" />
      </svg>
    );
  }
  if (kind === 'BID_RESUMED') {
    // Lucide `circle-play` - Braiins resumed the bid.
    return (
      <svg {...base} stroke="#34d399">
        <circle cx="12" cy="12" r="10" />
        <polygon points="10 8 16 12 10 16 10 8" />
      </svg>
    );
  }
  return (
    <svg {...base} stroke="#f87171">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
