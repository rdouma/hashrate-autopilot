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
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  api,
  type BidHistoryFilters,
  type BidHistoryFlatEvent,
  type BidEventView,
} from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { formatNumber } from '../lib/format';
import { DatePicker } from '../components/DatePicker';

const PAGE_SIZE = 100;
type Kind = NonNullable<BidHistoryFilters['kinds']>[number];

export function History() {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const denomination = useDenomination();
  const [filters, setFilters] = useState<BidHistoryFilters>({});

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

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-slate-100">
        <Trans>Order history</Trans>
      </h2>
      <Toolbar filters={filters} onChange={setFilters} />
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
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {events.map((e) => (
              <EventRow key={e.id} event={e} fmt={fmt} denomination={denomination} />
            ))}
            {events.length === 0 && !query.isPending && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-xs text-slate-500 italic">
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
    </div>
  );
}

function Toolbar({
  filters,
  onChange,
}: {
  filters: BidHistoryFilters;
  onChange: (next: BidHistoryFilters) => void;
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
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex flex-wrap items-end gap-x-4 gap-y-2 text-xs">
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>Action</Trans></label>
        <div className="flex gap-1">
          {(['CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID'] as Kind[]).map((k) => (
            <ActionChip
              key={k}
              kind={k}
              active={kinds.includes(k)}
              onClick={() => toggleKind(k)}
            />
          ))}
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
          className="w-32 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>From</Trans></label>
        <DatePicker
          value={filters.sinceMs}
          snap="start"
          onChange={(ms) => updateDate('sinceMs', ms)}
          ariaLabel={t`From date`}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] tracking-wider text-slate-500"><Trans>To</Trans></label>
        <DatePicker
          value={filters.untilMs}
          snap="end"
          onChange={(ms) => updateDate('untilMs', ms)}
          ariaLabel={t`To date`}
        />
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
          className="no-spinner w-24 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      {/* #256 v2 follow-up: Reset button on the RIGHT side with a
          Lucide rotate-ccw icon, labelled "reset" rather than "clear
          all". */}
      <button
        type="button"
        onClick={() => onChange({})}
        className="ml-auto flex items-center gap-1 text-[11px] text-slate-500 hover:text-amber-300 self-end"
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
}: {
  event: BidHistoryFlatEvent;
  fmt: ReturnType<typeof useFormatters>;
  denomination: ReturnType<typeof useDenomination>;
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
    <tr className="border-t border-slate-800/70 hover:bg-slate-800/30 align-top">
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

function labelForKindShort(kind: Kind): string {
  switch (kind) {
    case 'CREATE_BID': return t`create`;
    case 'EDIT_PRICE': return t`price`;
    case 'EDIT_SPEED': return t`speed`;
    case 'CANCEL_BID': return t`cancel`;
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
  return (
    <svg {...base} stroke="#f87171">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
