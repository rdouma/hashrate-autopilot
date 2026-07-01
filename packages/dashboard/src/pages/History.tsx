/**
 * #256 v2: flat-table /history page.
 *
 * Replaces the per-bid collapsible view. Toolbar of filters at top +
 * flat table + infinite scroll. Server pages 100 events at a time
 * via a `before_id` cursor.
 *
 * Columns: When | Action | Bid (full id) | Fillable | Price before
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  CONDITION_SPAN_CLASSES,
  CONDITION_OPEN_CLASSES,
  CONDITION_RECOVERY_CLASSES,
  conditionSpanClass,
} from '@hashrate-autopilot/shared';
import {
  api,
  type AlertConditionSpanView,
  type BidHistoryFilters,
  type BidHistoryFlatEvent,
  type BidEventView,
  type RewardEventView,
  type DepositView,
  type OurBlockMarker,
  type IpChangeEvent,
} from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { formatNumber, formatDuration } from '../lib/format';
import { CHART_COLOR_DEFAULTS, type ChartColorKey } from '../lib/chartColors';
import { formatConfigChange, type HashrateUnit } from '../lib/configFieldFormat';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import {
  logExtraJumpUrl,
  type BlockVariant,
  type LogExtraItem,
  type LogExtraKind,
} from '../lib/logExtra';
import {
  downloadBlob,
  isoUtc,
  pageBidEvents,
  streamTimelineXlsx,
  type TimelineExportRow,
} from '../lib/timelineExport';
import { conditionLabel } from '../lib/alertConditions';
import { DatePicker } from '../components/DatePicker';
import { BidEventDrawer } from '../components/BidEventDrawer';
import { AlertSpanDrawer } from '../components/AlertSpanDrawer';
import { useLocation, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';

const PAGE_SIZE = 100;
type Kind = NonNullable<BidHistoryFilters['kinds']>[number];

/** #318: the action kinds, in toolbar order. Opt-out filter: all shown
 *  by default; `filters.kinds` carries the currently-shown subset (or
 *  undefined = all, [] = none). */
const ACTION_KINDS: readonly Kind[] = [
  'CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID', 'MODE_CHANGE', 'BID_PAUSED', 'BID_RESUMED',
];

/** #316: condition class shown as an alert row + filter chip in History. */
const ALERT_FILTER_CLASSES = CONDITION_SPAN_CLASSES.map((c) => c.openClass);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * #318: alert event_classes already represented in the log by a span row
 * (the condition classes + recoveries) or a dedicated source (payouts,
 * pool blocks, deposits). Everything else becomes a generic point-alert
 * row - so future alert classes appear automatically.
 */
const ALERT_COVERED_ELSEWHERE = new Set<string>([
  ...CONDITION_OPEN_CLASSES,
  ...CONDITION_RECOVERY_CLASSES,
  'payout_confirmed',
  'pool_block_credited',
  'braiins_deposit_detected',
  'braiins_deposit_available',
]);

/** #317/#318: extra event types folded into the unified log (besides bids + alerts). */
const LOG_EXTRA_KINDS: readonly LogExtraKind[] = [
  'payout', 'deposit', 'block', 'ip', 'retarget', 'alert', 'config', 'boot',
];

const LOG_EXTRA_COLOR_SLOT: Record<
  Exclude<LogExtraKind, 'alert' | 'config' | 'boot'>,
  ChartColorKey
> = {
  payout: 'price.marker_payout_gem',
  deposit: 'price.marker_deposit',
  block: 'hashrate.pool_block_ours',
  ip: 'hashrate.marker_ip_change',
  retarget: 'hashrate.marker_retarget',
};

/** #318: block-variant color slot, mirroring the chart marker colors. */
const BLOCK_VARIANT_SLOT: Record<BlockVariant, ChartColorKey> = {
  ours: 'hashrate.pool_block_ours',
  others: 'hashrate.pool_block_others',
  bip110: 'hashrate.pool_block_bip110',
};

function logExtraColor(kind: LogExtraKind, blockVariant?: BlockVariant, eventClass?: string): string {
  if (kind === 'alert') {
    // #318 follow-up: "payout initiated" is good news, not a problem -
    // give it the positive payout-gem green instead of the alert amber.
    return eventClass === 'payout_initiated' ? '#10b981' : '#fbbf24';
  }
  if (kind === 'config') return '#a78bfa'; // violet-400 - config change
  if (kind === 'boot') return '#34d399'; // emerald-400 - daemon started
  if (kind === 'block') {
    return CHART_COLOR_DEFAULTS[BLOCK_VARIANT_SLOT[blockVariant ?? 'others']];
  }
  return CHART_COLOR_DEFAULTS[LOG_EXTRA_COLOR_SLOT[kind]];
}

function logExtraLabel(kind: LogExtraKind): string {
  switch (kind) {
    case 'payout': return t`payout`;
    case 'deposit': return t`deposit`;
    case 'block': return t`pool block`;
    case 'ip': return t`IP change`;
    case 'retarget': return t`difficulty retarget`;
    case 'alert': return t`alert`;
    case 'config': return t`config change`;
    case 'boot': return t`daemon started`;
  }
}

/** #318: short label for a point-alert row, by event class. */
function pointAlertLabel(eventClass: string): string {
  switch (eventClass) {
    case 'payout_initiated': return t`payout initiated`;
    case 'solo_best_difficulty': return t`best difficulty`;
    case 'beta_exit': return t`fee change`;
    default: return eventClass.replace(/_/g, ' ');
  }
}

/** Lucide glyph per extra kind, tinted with its marker color. */
function LogExtraGlyph({
  kind,
  blockVariant,
  eventClass,
}: {
  kind: LogExtraKind;
  blockVariant?: BlockVariant;
  eventClass?: string;
}) {
  const color = logExtraColor(kind, blockVariant, eventClass);
  const base = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'inline-block align-middle',
  };
  // #318: our own block reads as a crown (same 10×10 path the chart
  // draws), matching the chart marker; others/BIP-110 keep the cube,
  // distinguished by color (blue vs yellow).
  if (kind === 'block' && blockVariant === 'ours') {
    return (
      <svg width="12" height="12" viewBox="0 0 10 10" className="inline-block align-middle">
        <g fill={color} fillOpacity="0.45" stroke={color} strokeWidth="1.1" strokeLinejoin="round">
          <path d="M0 8 L1.5 3 L4 5.5 L5 1 L6 5.5 L8.5 3 L10 8 Z" />
          <line x1="0" y1="9.5" x2="10" y2="9.5" stroke={color} strokeWidth="1.4" />
        </g>
      </svg>
    );
  }
  // #318 follow-up: "payout initiated" is a positive event, so it gets
  // Lucide `hand-coins` (a payout) instead of the alarm bell that made it
  // read as a problem.
  if (kind === 'alert' && eventClass === 'payout_initiated') {
    return (
      <svg {...base}>
        <path d="M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17" />
        <path d="m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" />
        <path d="m2 16 6 6" />
        <circle cx="16" cy="9" r="2.9" />
        <circle cx="6" cy="5" r="3" />
      </svg>
    );
  }
  switch (kind) {
    case 'payout': // Lucide gem
      return (
        <svg {...base}>
          <path d="M6 3h12l4 6-10 13L2 9Z" />
          <path d="M11 3 8 9l4 13 4-13-3-6" />
          <path d="M2 9h20" />
        </svg>
      );
    case 'deposit': // Lucide fuel
      return (
        <svg {...base}>
          <line x1="3" x2="15" y1="22" y2="22" />
          <line x1="4" x2="14" y1="9" y2="9" />
          <path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18" />
          <path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5" />
        </svg>
      );
    case 'block': // Lucide box
      return (
        <svg {...base}>
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      );
    case 'ip': // Lucide router
      return (
        <svg {...base}>
          <rect width="20" height="8" x="2" y="14" rx="2" />
          <path d="M6.01 18H6" />
          <path d="M10.01 18H10" />
          <path d="M15 10v4" />
          <path d="M17.84 7.17a4 4 0 0 0-5.66 0" />
          <path d="M20.66 4.34a8 8 0 0 0-11.31 0" />
        </svg>
      );
    case 'retarget': // Lucide pickaxe
      return (
        <svg {...base}>
          <path d="m14 13-8.381 8.38a1 1 0 0 1-3.001-3L11 9.999" />
          <path d="M15.973 4.027A13 13 0 0 0 5.902 2.373c-1.398.342-1.092 2.158.277 2.601a19.9 19.9 0 0 1 5.822 3.024" />
          <path d="M16.001 11.999a19.9 19.9 0 0 1 3.024 5.824c.444 1.369 2.26 1.676 2.603.278A13 13 0 0 0 20 8.069" />
          <path d="M18.352 3.352a1.205 1.205 0 0 0-1.704 0l-5.296 5.296a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l5.296-5.296a1.205 1.205 0 0 0 0-1.704z" />
        </svg>
      );
    case 'alert': // Lucide bell
      return (
        <svg {...base}>
          <path d="M10.268 21a2 2 0 0 0 3.464 0" />
          <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
        </svg>
      );
    case 'config': // Lucide sliders-horizontal
      return (
        <svg {...base}>
          <line x1="21" x2="14" y1="4" y2="4" />
          <line x1="10" x2="3" y1="4" y2="4" />
          <line x1="21" x2="12" y1="12" y2="12" />
          <line x1="8" x2="3" y1="12" y2="12" />
          <line x1="21" x2="16" y1="20" y2="20" />
          <line x1="12" x2="3" y1="20" y2="20" />
          <line x1="14" x2="14" y1="2" y2="6" />
          <line x1="8" x2="8" y1="10" y2="14" />
          <line x1="16" x2="16" y1="18" y2="22" />
        </svg>
      );
    case 'boot': // Lucide power
      return (
        <svg {...base}>
          <path d="M12 2v10" />
          <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
        </svg>
      );
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
      // #318: keep the exact selected subset, incl. an explicit [] (the
      // opt-out "none" state). Only a missing kinds field means "all".
      // (Prior validator dropped MODE_CHANGE/BID_PAUSED/BID_RESUMED and
      // any empty selection - both lost across a reload.)
      out.kinds = parsed.kinds.filter((k): k is Kind =>
        (ACTION_KINDS as readonly string[]).includes(k),
      );
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
  // #318 follow-up: "follow" (live tail) - refetch faster and, as new
  // events land, keep the feed pinned to the top so the newest entries
  // trace in. Toggling on jumps to the live edge (drops any date window).
  const [following, setFollowing] = useState(false);
  const toggleFollow = () => {
    setFollowing((on) => {
      if (!on) {
        // turning on: go live + scroll to the newest.
        setFilters((prev) => {
          const next = { ...prev };
          delete next.untilMs;
          return next;
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return !on;
    });
  };
  // #317: when a reveal link carries `ts` (the event's time) and the event
  // is well in the past, jump the feed's date window to around it so the
  // target row loads in context near the top - rather than floating far
  // below the live feed where the scroll can't reach it. The endpoint's
  // first page returns the newest bids <= until_ms.
  const JUMP_THRESHOLD_MS = 2 * 60 * 60 * 1000;
  const jumpWindowToTs = (tsRaw: string | null) => {
    if (!tsRaw) return;
    const ts = Number.parseInt(tsRaw, 10);
    if (!Number.isFinite(ts)) return;
    if (ts >= Date.now() - JUMP_THRESHOLD_MS) return; // recent: keep live feed
    setFilters((prev) => ({ ...prev, untilMs: ts + 60 * 60 * 1000 }));
  };
  const [selectedEvent, setSelectedEvent] = useState<BidHistoryFlatEvent | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<AlertConditionSpanView | null>(null);
  // #318 follow-up: clicking an extra log row opens a detail side panel
  // (like bid events + alert spans) rather than jumping straight to the
  // chart; the panel carries a "View on chart" button.
  const [selectedExtra, setSelectedExtra] = useState<LogExtraItem | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<number | null>(null);
  const [highlightedSpanId, setHighlightedSpanId] = useState<number | null>(null);
  // #317: generic focus key (`<kind>:<key>`) for the extra log rows.
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(null);
  // #317: which extra event kinds show as rows. Default: all on.
  const [shownExtraKinds, setShownExtraKinds] = useState<Set<LogExtraKind>>(
    () => new Set(LOG_EXTRA_KINDS),
  );
  const toggleExtraKind = (k: LogExtraKind) =>
    setShownExtraKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
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
  // #318 follow-up: bulk all/none per opt-out group, so isolating a
  // single event type (e.g. "only create") doesn't mean deselecting a
  // dozen alert + event chips by hand.
  const setAllAlertClasses = (on: boolean) =>
    setShownAlertClasses(on ? new Set(ALERT_FILTER_CLASSES) : new Set());
  const setAllExtraKinds = (on: boolean) =>
    setShownExtraKinds(on ? new Set(LOG_EXTRA_KINDS) : new Set());
  const location = useLocation();
  const navigate = useNavigate();

  const query = useInfiniteQuery({
    queryKey: ['bid-history-flat', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.bidHistoryFlatEvents(filters, pageParam, PAGE_SIZE),
    getNextPageParam: (last) => last.next_cursor_id ?? undefined,
    refetchInterval: following ? 15_000 : 60_000,
  });

  const events: BidHistoryFlatEvent[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.events) ?? [],
    [query.data],
  );

  // #318 follow-up: while following, each fresh fetch pins back to the
  // top - but only when the operator is already near the top, so a
  // deliberate scroll-down isn't yanked away mid-read.
  const lastFetchAt = query.dataUpdatedAt;
  useEffect(() => {
    if (!following) return;
    if (window.scrollY < 400) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [following, lastFetchAt]);

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

  // #317: extra event types folded into the log. Reuse the existing
  // endpoints; these are all sparse so a single fetch each is fine.
  const payoutsQuery = useQuery({
    queryKey: ['history-reward-events'],
    queryFn: () => api.rewardEvents(),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const depositsQuery = useQuery({
    queryKey: ['history-deposits'],
    queryFn: () => api.deposits(),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const oceanQuery = useQuery({
    queryKey: ['history-ocean'],
    queryFn: () => api.ocean(),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const ipChangesQuery = useQuery({
    queryKey: ['history-ip-changes', alertWindow.since, alertWindow.until],
    queryFn: () => api.ipChangesViewport(alertWindow.since, alertWindow.until),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const retargetsQuery = useQuery({
    queryKey: ['history-retargets', alertWindow.since, alertWindow.until],
    queryFn: () => api.retargets(alertWindow.since, alertWindow.until),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  // #318: raw alerts, for the point-alert rows (classes not already
  // covered as spans or by a dedicated source). One windowed fetch.
  const alertsLogQuery = useQuery({
    queryKey: ['history-alerts-log', alertWindow.since],
    queryFn: () => api.alertsList({ since_ms: alertWindow.since, limit: 1000 }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  // #318: config changes + daemon boots.
  const systemEventsQuery = useQuery({
    queryKey: ['history-system-events', alertWindow.since, alertWindow.until],
    queryFn: () => api.systemEvents(alertWindow.since, alertWindow.until),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  // #318 follow-up: config carries the block-explorer URL templates so the
  // detail drawer can deep-link deposits / payouts / blocks to an explorer.
  // Shares the cached ['config'] query with the rest of the app.
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => api.config() });
  const txUrlTemplate = configQuery.data?.config?.block_explorer_tx_url_template ?? '';
  const blockUrlTemplate = configQuery.data?.config?.block_explorer_url_template ?? '';

  // Bound alert rows to the loaded bid-event range so an old alert can't
  // float at the bottom of the list below a gap of not-yet-loaded bids.
  // When there are no bid events at all, show everything in the window.
  const oldestBidTs = events.length > 0 ? events[events.length - 1]!.occurred_at : null;
  const visibleAlertSpans: AlertConditionSpanView[] = useMemo(() => {
    const spans = alertSpansQuery.data?.spans ?? [];
    return spans.filter(
      (s) =>
        // A deep-linked span (highlighted via "View in history") is shown
        // regardless of the bid-range bind so it can't vanish mid-jump.
        s.open_id === highlightedSpanId ||
        (shownAlertClasses.has(s.event_class) &&
          s.start_ms <= alertWindow.until &&
          s.start_ms >= alertWindow.since &&
          (oldestBidTs === null || s.start_ms >= oldestBidTs)),
    );
  }, [alertSpansQuery.data, shownAlertClasses, alertWindow, oldestBidTs, highlightedSpanId]);

  // #317: build the extra log rows (payouts / deposits / our pool blocks /
  // IP changes) from their queries, then bound to the loaded bid range
  // (or force-show a deep-linked row) exactly like the alert rows.
  const visibleExtras: LogExtraItem[] = useMemo(() => {
    const all: LogExtraItem[] = [];
    for (const e of payoutsQuery.data?.events ?? []) {
      if (e.reorged) continue;
      all.push({
        kind: 'payout',
        key: `payout:${e.id}`,
        ts: e.detected_at,
        summary: `${formatNumber(e.value_sat, {})} sat · block ${e.block_height}`,
        payout: e,
      });
    }
    for (const d of depositsQuery.data?.deposits ?? []) {
      const ts = d.credited_at_ms ?? d.tx_timestamp_ms ?? d.first_seen_at_ms;
      all.push({
        kind: 'deposit',
        key: `deposit:${d.tx_id}`,
        ts,
        summary: `${formatNumber(d.amount_sat, {})} sat`,
        deposit: d,
      });
    }
    for (const b of oceanQuery.data?.our_recent_blocks ?? []) {
      // #318: all pool blocks, not just ours. Ocean's own blocks (found
      // by other miners) are context; ours are flagged in the summary.
      // Variant mirrors the chart marker precedence: ours -> crown,
      // BIP-110-signalling -> yellow cube, otherwise blue cube.
      const blockVariant: BlockVariant = b.found_by_us
        ? 'ours'
        : b.signals_bip110 === true
          ? 'bip110'
          : 'others';
      // The variant now rides on the glyph + label; keep the summary to
      // the block height + reward so it doesn't repeat "found by us".
      const blockLabel = blockVariant === 'ours'
        ? t`own pool block`
        : blockVariant === 'bip110'
          ? t`BIP 110 block`
          : t`pool block`;
      all.push({
        kind: 'block',
        key: `block:${b.block_hash}`,
        ts: b.timestamp_ms,
        summary: `block ${b.height} · ${formatNumber(b.total_reward_sat, {})} sat`,
        label: blockLabel,
        blockVariant,
        blockHash: b.block_hash,
        block: b,
      });
    }
    for (const c of ipChangesQuery.data?.events ?? []) {
      all.push({
        kind: 'ip',
        key: `ip:${c.id}`,
        ts: c.occurred_at,
        summary: `${c.old_ip ?? '—'} → ${c.new_ip}`,
        ip: c,
      });
    }
    for (const r of retargetsQuery.data?.retargets ?? []) {
      const pct = ((r.difficulty - r.previous) / r.previous) * 100;
      all.push({
        kind: 'retarget',
        key: `retarget:${r.tick_at}`,
        ts: r.tick_at,
        summary: `${(r.difficulty / 1e12).toFixed(1)} T · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
        retarget: r,
      });
    }
    for (const a of alertsLogQuery.data?.alerts ?? []) {
      const ec = a.event_class;
      if (!ec || ALERT_COVERED_ELSEWHERE.has(ec)) continue;
      all.push({
        kind: 'alert',
        key: `alert:${a.id}`,
        ts: a.created_at,
        label: pointAlertLabel(ec),
        summary: a.body || a.title,
        eventClass: ec,
      });
    }
    for (const s of systemEventsQuery.data?.events ?? []) {
      if (s.kind === 'config_change') {
        const unit = denomination.hashrateUnit as HashrateUnit;
        const human = s.field
          ? formatConfigChange(s.field, s.old_value, s.new_value, unit, (n) => formatNumber(n, {}))
          : { label: t`config change`, change: `${s.old_value ?? '—'} → ${s.new_value ?? '—'}` };
        all.push({
          kind: 'config',
          key: `config:${s.id}`,
          ts: s.occurred_at,
          summary: `${human.label}: ${human.change}`,
          system: s,
        });
      } else if (s.kind === 'daemon_started') {
        all.push({
          kind: 'boot',
          key: `boot:${s.id}`,
          ts: s.occurred_at,
          summary: s.detail ?? '',
          system: s,
        });
      }
    }
    return all.filter(
      (it) =>
        it.key === highlightedRowKey ||
        (shownExtraKinds.has(it.kind) &&
          it.ts <= alertWindow.until &&
          it.ts >= alertWindow.since &&
          (oldestBidTs === null || it.ts >= oldestBidTs)),
    );
  }, [
    payoutsQuery.data,
    depositsQuery.data,
    oceanQuery.data,
    ipChangesQuery.data,
    retargetsQuery.data,
    alertsLogQuery.data,
    systemEventsQuery.data,
    denomination.hashrateUnit,
    shownExtraKinds,
    alertWindow,
    oldestBidTs,
    highlightedRowKey,
  ]);

  // Recent alerts can sit just past the first bid page; since alert rows
  // are bound to the loaded bid range (to avoid a misleading time gap),
  // auto-load a few more bid pages until every shown alert in the last
  // 7 days is covered. Capped so a long-idle install doesn't fetch the
  // whole history on open.
  const AUTO_LOAD_PAGE_CAP = 6;
  const RECENT_ALERT_MS = 7 * 24 * 60 * 60 * 1000;
  useEffect(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    if ((query.data?.pages.length ?? 0) >= AUTO_LOAD_PAGE_CAP) return;
    if (oldestBidTs === null) return;
    const spans = alertSpansQuery.data?.spans ?? [];
    const cutoff = Date.now() - RECENT_ALERT_MS;
    const hiddenRecent = spans.some(
      (s) =>
        shownAlertClasses.has(s.event_class) &&
        s.start_ms < oldestBidTs &&
        s.start_ms >= cutoff &&
        s.start_ms >= alertWindow.since,
    );
    if (hiddenRecent) void query.fetchNextPage();
  }, [query, alertSpansQuery.data, shownAlertClasses, oldestBidTs, alertWindow.since]);

  // Merged, newest-first timeline of bid events + alert rows + extras.
  type TimelineItem =
    | { kind: 'bid'; ts: number; ev: BidHistoryFlatEvent }
    | { kind: 'alert'; ts: number; span: AlertConditionSpanView }
    | { kind: 'extra'; ts: number; extra: LogExtraItem };
  const timelineItems: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...events.map((ev) => ({ kind: 'bid' as const, ts: ev.occurred_at, ev })),
      ...visibleAlertSpans.map((span) => ({ kind: 'alert' as const, ts: span.start_ms, span })),
      ...visibleExtras.map((extra) => ({ kind: 'extra' as const, ts: extra.ts, extra })),
    ];
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }, [events, visibleAlertSpans, visibleExtras]);

  // #320: export every row matching the active filters (not just the
  // loaded page) to a formatted XLSX. Bid events page to completion
  // server-side; the extra kinds come from their already-loaded queries,
  // bounded by the active date range + group toggles.
  const [exporting, setExporting] = useState(false);
  const actionLabels = useActionLabels();
  const handleExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const inRange = (ts: number) =>
        (filters.sinceMs == null || ts >= filters.sinceMs) &&
        (filters.untilMs == null || ts <= filters.untilMs);
      // Extra rows are bounded (their queries hold the full set) - collect
      // them in memory, sorted newest-first, then MERGE against the
      // paged/streamed bid events so the whole set is never materialized.
      const extras: Array<{ ts: number; row: TimelineExportRow }> = [];
      const extraRow = (ts: number, type: string, reason: string) =>
        extras.push({
          ts,
          row: {
            whenUtc: isoUtc(ts),
            whenLocal: fmt.timestamp(ts),
            type,
            bid: null,
            fillable: null,
            priceBefore: null,
            priceAfter: null,
            deltaPrice: null,
            speed: null,
            reason,
          },
        });
      const bidToRow = (e: BidHistoryFlatEvent): TimelineExportRow => {
        const before = e.old_price_sat_per_ph_day;
        const after = e.new_price_sat_per_ph_day;
        return {
          whenUtc: isoUtc(e.occurred_at),
          whenLocal: fmt.timestamp(e.occurred_at),
          type: actionLabels[e.kind],
          bid: e.braiins_order_id,
          fillable:
            e.fillable_at_event_sat_per_ph_day != null
              ? Math.round(e.fillable_at_event_sat_per_ph_day)
              : null,
          priceBefore: before != null ? Math.round(before) : null,
          priceAfter: after != null ? Math.round(after) : null,
          deltaPrice: before != null && after != null ? Math.round(after - before) : null,
          speed: e.speed_limit_ph,
          reason: e.reason ?? '',
        };
      };

      if (shownExtraKinds.has('payout'))
        for (const p of payoutsQuery.data?.events ?? []) {
          if (p.reorged || !inRange(p.detected_at)) continue;
          extraRow(p.detected_at, logExtraLabel('payout'), `${formatNumber(p.value_sat, {})} sat · block ${p.block_height}`);
        }
      if (shownExtraKinds.has('deposit'))
        for (const d of depositsQuery.data?.deposits ?? []) {
          const ts = d.credited_at_ms ?? d.tx_timestamp_ms ?? d.first_seen_at_ms;
          if (!inRange(ts)) continue;
          extraRow(ts, logExtraLabel('deposit'), `${formatNumber(d.amount_sat, {})} sat · ${d.tx_id}`);
        }
      if (shownExtraKinds.has('block'))
        for (const b of oceanQuery.data?.our_recent_blocks ?? []) {
          if (!inRange(b.timestamp_ms)) continue;
          const lbl = b.found_by_us ? t`own pool block` : b.signals_bip110 === true ? t`BIP 110 block` : t`pool block`;
          extraRow(b.timestamp_ms, lbl, `block ${b.height} · ${formatNumber(b.total_reward_sat, {})} sat · ${b.block_hash}`);
        }
      if (shownExtraKinds.has('ip'))
        for (const c of ipChangesQuery.data?.events ?? []) {
          if (!inRange(c.occurred_at)) continue;
          extraRow(c.occurred_at, logExtraLabel('ip'), `${c.old_ip ?? '—'} → ${c.new_ip}`);
        }
      if (shownExtraKinds.has('retarget'))
        for (const r of retargetsQuery.data?.retargets ?? []) {
          if (!inRange(r.tick_at)) continue;
          const pct = ((r.difficulty - r.previous) / r.previous) * 100;
          extraRow(r.tick_at, logExtraLabel('retarget'), `${(r.difficulty / 1e12).toFixed(1)} T · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`);
        }
      if (shownExtraKinds.has('alert'))
        for (const a of alertsLogQuery.data?.alerts ?? []) {
          const ec = a.event_class;
          if (!ec || ALERT_COVERED_ELSEWHERE.has(ec) || !inRange(a.created_at)) continue;
          extraRow(a.created_at, pointAlertLabel(ec), a.body || a.title);
        }
      for (const s of systemEventsQuery.data?.events ?? []) {
        if (!inRange(s.occurred_at)) continue;
        if (s.kind === 'config_change' && shownExtraKinds.has('config'))
          extraRow(s.occurred_at, logExtraLabel('config'), `${s.field ?? '?'}: ${s.old_value ?? '—'} → ${s.new_value ?? '—'}`);
        else if (s.kind === 'daemon_started' && shownExtraKinds.has('boot'))
          extraRow(s.occurred_at, logExtraLabel('boot'), s.detail ?? '');
      }
      for (const s of alertSpansQuery.data?.spans ?? []) {
        if (!shownAlertClasses.has(s.event_class) || !inRange(s.start_ms)) continue;
        extraRow(s.start_ms, conditionLabel(s.event_class), s.body ?? '');
      }
      extras.sort((a, b) => b.ts - a.ts);

      // Streaming newest-first merge: bid events arrive desc, page by
      // page; extras are held desc in memory. Emit any extras newer than
      // the incoming bid event before it, so the whole set never lands in
      // memory at once - only one bid page + the compressed output.
      async function* mergedRows(): AsyncGenerator<TimelineExportRow> {
        let ei = 0;
        for await (const e of pageBidEvents(filters)) {
          const ts = e.occurred_at;
          while (ei < extras.length && extras[ei]!.ts >= ts) yield extras[ei++]!.row;
          yield bidToRow(e);
        }
        while (ei < extras.length) yield extras[ei++]!.row;
      }

      // #320: localize the sheet - headers + tab name follow the UI
      // language (Type/reason values are already translated by their
      // label functions). Order must match the export columns.
      const blob = await streamTimelineXlsx(mergedRows(), {
        sheetName: t`Timeline`,
        headers: [
          t`When (UTC)`,
          t`When (local)`,
          t`Type`,
          t`Bid`,
          t`Fillable (sat/PH/day)`,
          t`Price before`,
          t`Price after`,
          t`Δ price`,
          t`Speed (PH/s)`,
          t`Reason`,
        ],
      });
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `hashrate-autopilot-timeline-${stamp}.xlsx`);
    } catch (err) {
      console.error('[timeline export]', err);
      window.alert(t`Export failed - see the browser console for details.`);
    } finally {
      setExporting(false);
    }
  }, [
    exporting,
    filters,
    fmt,
    actionLabels,
    shownExtraKinds,
    shownAlertClasses,
    payoutsQuery.data,
    depositsQuery.data,
    oceanQuery.data,
    ipChangesQuery.data,
    retargetsQuery.data,
    alertsLogQuery.data,
    systemEventsQuery.data,
    alertSpansQuery.data,
  ]);

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
    // #318 follow-up: a bid event is fetched server-side, so a filter
    // that excludes its kind / price-delta / bid-id (or a date range
    // that predates it) means it never loads and the reveal can't
    // highlight it. Per the operator, reset those filters first - an
    // acceptable consequence of jumping to a currently-hidden row.
    // (Alert + extra reveals force-show past their toggles already.)
    if (
      filters.kinds !== undefined ||
      filters.minAbsPriceDelta != null ||
      filters.orderIdContains != null ||
      filters.sinceMs != null
    ) {
      setFilters({});
      jumpWindowToTs(params.get('ts'));
      return; // re-runs after the unfiltered refetch, then highlights
    }
    jumpWindowToTs(params.get('ts'));
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
      params.delete('ts');
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

  // #316: ?focus_span=<open_id> from a chart marker's "View in history"
  // link. The target span is force-shown via highlightedSpanId (see
  // visibleAlertSpans), so we don't need to page back to it - just
  // highlight, scroll, and strip the param. The highlight (and thus the
  // forced visibility) clears after 1.8 s.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('focus_span');
    if (!raw) return;
    const openId = Number.parseInt(raw, 10);
    if (!Number.isFinite(openId)) return;
    jumpWindowToTs(params.get('ts'));
    setHighlightedSpanId(openId);
    params.delete('focus_span');
    params.delete('ts');
    const next = params.toString();
    navigate(`/history${next ? `?${next}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // The target row is force-shown by highlightedSpanId, but its data may
  // arrive a beat after navigation (the alert-spans query is in flight).
  // Poll until the row exists, then scroll to it and start the brief
  // highlight-clear countdown - anchoring the flash to render time, not
  // navigation time, so a slow query doesn't clear it before it shows.
  useEffect(() => {
    if (highlightedSpanId === null) return;
    let tries = 0;
    let clearTimer: number | null = null;
    const poll = window.setInterval(() => {
      tries += 1;
      const el = document.getElementById(`alert-span-row-${highlightedSpanId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.clearInterval(poll);
        clearTimer = window.setTimeout(() => setHighlightedSpanId(null), 1800);
      } else if (tries >= 40) {
        window.clearInterval(poll);
        setHighlightedSpanId(null);
      }
    }, 100);
    return () => {
      window.clearInterval(poll);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
    };
  }, [highlightedSpanId]);

  // #317: generic ?focus=<kind>:<key> from an extra chart marker's "View
  // in history" link. Same shape as focus_span: force-show the row (see
  // visibleExtras), poll for it, scroll, briefly highlight.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('focus');
    if (!raw) return;
    jumpWindowToTs(params.get('ts'));
    setHighlightedRowKey(raw);
    params.delete('focus');
    params.delete('ts');
    const next = params.toString();
    navigate(`/history${next ? `?${next}` : ''}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // #318: ?jump_ts=<ms> jumps the log's date window to around a time
  // without highlighting a specific row - used by chart markers that
  // don't have a 1:1 log row id (e.g. the unpaid-drop / payout-initiated
  // dot). The relevant rows appear in the jumped-to window.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get('jump_ts');
    if (!raw) return;
    jumpWindowToTs(raw);
    params.delete('jump_ts');
    const next = params.toString();
    navigate(`/history${next ? `?${next}` : ''}`, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    if (highlightedRowKey === null) return;
    let tries = 0;
    let clearTimer: number | null = null;
    const poll = window.setInterval(() => {
      tries += 1;
      const el = document.getElementById(`log-row-${highlightedRowKey}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.clearInterval(poll);
        clearTimer = window.setTimeout(() => setHighlightedRowKey(null), 1800);
      } else if (tries >= 40) {
        window.clearInterval(poll);
        setHighlightedRowKey(null);
      }
    }, 100);
    return () => {
      window.clearInterval(poll);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
    };
  }, [highlightedRowKey]);

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-slate-100">
        <Trans>Timeline</Trans>
      </h2>
      <Toolbar
        filters={filters}
        onChange={setFilters}
        shownAlertClasses={shownAlertClasses}
        onToggleAlertClass={toggleAlertClass}
        onSetAllAlertClasses={setAllAlertClasses}
        shownExtraKinds={shownExtraKinds}
        onToggleExtraKind={toggleExtraKind}
        onSetAllExtraKinds={setAllExtraKinds}
        onExport={handleExport}
        exporting={exporting}
        following={following}
        onToggleFollow={toggleFollow}
      />
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500 tracking-wider bg-slate-950/40">
            <tr>
              <th className="text-left font-normal py-1.5 px-3 whitespace-nowrap normal-case"><Trans>When</Trans></th>
              <th className="text-left font-normal py-1.5 px-3 normal-case"><Trans>Action</Trans></th>
              <th className="text-left font-normal py-1.5 px-3 normal-case"><Trans>Bid</Trans></th>
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
              ) : item.kind === 'alert' ? (
                <AlertSpanRow
                  key={`alert-${item.span.open_id}`}
                  span={item.span}
                  fmt={fmt}
                  highlighted={highlightedSpanId === item.span.open_id}
                  onClick={() => setSelectedSpan(item.span)}
                />
              ) : (
                <LogExtraRow
                  key={item.extra.key}
                  extra={item.extra}
                  fmt={fmt}
                  highlighted={highlightedRowKey === item.extra.key}
                  onClick={() => setSelectedExtra(item.extra)}
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
      {selectedSpan && (
        <AlertSpanDrawer
          span={selectedSpan}
          onClose={() => setSelectedSpan(null)}
        />
      )}
      {selectedExtra && (
        <LogExtraDrawer
          extra={selectedExtra}
          fmt={fmt}
          txUrlTemplate={txUrlTemplate}
          blockUrlTemplate={blockUrlTemplate}
          onClose={() => setSelectedExtra(null)}
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
  onSetAllAlertClasses,
  shownExtraKinds,
  onToggleExtraKind,
  onSetAllExtraKinds,
  onExport,
  exporting,
  following,
  onToggleFollow,
}: {
  filters: BidHistoryFilters;
  onChange: (next: BidHistoryFilters) => void;
  /** #316: condition classes currently shown as alert rows. */
  shownAlertClasses: Set<string>;
  onToggleAlertClass: (openClass: string) => void;
  /** #318: bulk show/hide every alert class. */
  onSetAllAlertClasses: (on: boolean) => void;
  /** #317: extra event kinds currently shown as rows. */
  shownExtraKinds: Set<LogExtraKind>;
  onToggleExtraKind: (kind: LogExtraKind) => void;
  /** #318: bulk show/hide every extra event kind. */
  onSetAllExtraKinds: (on: boolean) => void;
  /** #320: export all matching rows to a formatted XLSX. */
  onExport: () => void;
  exporting: boolean;
  /** #318 follow-up: live-tail mode. */
  following: boolean;
  onToggleFollow: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const denomination = useDenomination();
  // #318: opt-out action filter (matches the Alerts/Events groups). All
  // kinds are shown by default; `filters.kinds` holds the currently-shown
  // subset. undefined = all shown; a subset = only those; [] = none.
  const shownKinds: Set<Kind> = filters.kinds ? new Set(filters.kinds) : new Set(ACTION_KINDS);

  const setShownKinds = (next: Set<Kind>) => {
    // Collapse "all shown" back to undefined so the URL/persistence stays
    // clean and the server applies no filter; keep [] explicit for "none".
    onChange({
      ...filters,
      kinds: next.size === ACTION_KINDS.length ? undefined : (Array.from(next) as Kind[]),
    });
  };

  const toggleKind = (k: Kind) => {
    const next = new Set(shownKinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setShownKinds(next);
  };
  const setAllKinds = (on: boolean) =>
    onChange({ ...filters, kinds: on ? undefined : [] });
  // #318 follow-up: global all/none - flip every chip in all three groups
  // at once (operator's chosen "keep reset + add global All/None").
  const selectAllGroups = (on: boolean) => {
    setAllKinds(on);
    onSetAllAlertClasses(on);
    onSetAllExtraKinds(on);
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
        <div className="flex items-center gap-2">
          <label className="text-[10px] tracking-wider text-slate-500"><Trans>Action</Trans></label>
          <AllNone onAll={() => setAllKinds(true)} onNone={() => setAllKinds(false)} />
        </div>
        <div className="flex flex-wrap gap-1">
          {ACTION_KINDS.map((k) => (
            <ActionChip
              key={k}
              kind={k}
              active={shownKinds.has(k)}
              onClick={() => toggleKind(k)}
            />
          ))}
        </div>
      </div>
      {/* #316: alert-condition rows toggle. Default all on; turning a
          chip off hides that condition's rows (client-side filter). */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label className="text-[10px] tracking-wider text-slate-500"><Trans>Alerts</Trans></label>
          <AllNone onAll={() => onSetAllAlertClasses(true)} onNone={() => onSetAllAlertClasses(false)} />
        </div>
        <div className="flex flex-wrap gap-1">
          {ALERT_FILTER_CLASSES.map((openClass) => {
            const active = shownAlertClasses.has(openClass);
            const color =
              CHART_COLOR_DEFAULTS[
                (conditionSpanClass(openClass)?.colorSlot ?? 'events.alert_condition') as ChartColorKey
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
                {/* #318 follow-up: the alert triangle (same glyph the
                    condition rows use), not a dot. Dimmed when off. */}
                <svg
                  width="12" height="12" viewBox="0 0 24 24"
                  fill="none" stroke={color} strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  className={`inline-block align-middle shrink-0 ${active ? '' : 'opacity-40'}`}
                >
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
                {conditionLabel(openClass)}
              </button>
            );
          })}
        </div>
      </div>
      {/* #317: extra event-type rows toggle (payouts / deposits / our pool
          blocks / IP changes). Default all on. */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <label className="text-[10px] tracking-wider text-slate-500"><Trans>Events</Trans></label>
          <AllNone onAll={() => onSetAllExtraKinds(true)} onNone={() => onSetAllExtraKinds(false)} />
        </div>
        <div className="flex flex-wrap gap-1">
          {LOG_EXTRA_KINDS.map((kind) => {
            const active = shownExtraKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => onToggleExtraKind(kind)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] ${
                  active
                    ? 'border-slate-600 bg-slate-800 text-slate-200'
                    : 'border-slate-800 text-slate-500 hover:text-slate-300'
                }`}
              >
                {/* #318 follow-up: the chip carries the row's own glyph
                    (not a dot) so the filter is recognizable - e.g. the
                    power icon = daemon-started. Dimmed when off. */}
                <span className={active ? '' : 'opacity-40'}>
                  <LogExtraGlyph kind={kind} />
                </span>
                {logExtraLabel(kind)}
              </button>
            );
          })}
        </div>
      </div>
      {/* #318 follow-up: the text/date/number fields (Bid id, From, To,
          Δ price) share one dedicated full-width row so Δ price no longer
          sits alone, with the reset button pushed to the right. On mobile
          the wrapper stacks like the rest of the toolbar. */}
      <div className="w-full flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-4 sm:gap-y-2">
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
            on desktop so each flows into the field row's wrap as before). */}
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
        {/* #318 follow-up: global select-all / select-none - two clear
            buttons (operator: the gray "all · none" text wasn't
            recognizable) that flip every chip in all three groups at
            once. Starts the right-aligned button cluster. */}
        <div className="hidden sm:flex items-center gap-2 sm:ml-auto self-end">
          <button
            type="button"
            onClick={() => selectAllGroups(true)}
            className="flex items-center justify-center gap-1.5 text-[11px] font-semibold rounded-md px-3 py-1.5 border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200"
            title={t`Enable every filter chip (all groups)`}
          >
            <Trans>select all</Trans>
          </button>
          <button
            type="button"
            onClick={() => selectAllGroups(false)}
            className="flex items-center justify-center gap-1.5 text-[11px] font-semibold rounded-md px-3 py-1.5 border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200"
            title={t`Clear every filter chip (all groups)`}
          >
            <Trans>select none</Trans>
          </button>
        </div>
        {/* #318 follow-up: live-tail toggle. Emerald + pulsing dot when
            on. export + reset follow. */}
        <button
          type="button"
          onClick={onToggleFollow}
          className={`w-full sm:w-auto flex items-center justify-center gap-1.5 text-[11px] font-semibold rounded-md px-3 py-1.5 border self-end ${
            following
              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
              : 'border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200'
          }`}
          title={following ? t`Following new events live - click to stop` : t`Follow new events live (auto-scroll to the newest)`}
        >
          <span
            className={`inline-block w-2 h-2 rounded-full ${following ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`}
            aria-hidden="true"
          />
          <Trans>follow</Trans>
        </button>
        {/* #320: export every matching row to a formatted XLSX. Secondary
            (slate) so the amber reset stays the primary action. */}
        <button
          type="button"
          onClick={onExport}
          disabled={exporting}
          className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-[11px] font-semibold rounded-md px-3 py-1.5 border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200 self-end disabled:opacity-50 disabled:cursor-wait"
          title={t`Download all matching rows as an Excel (.xlsx) file`}
        >
          {exporting ? (
            // Lucide loader-circle, spinning - clearer than "..." that
            // the export is working.
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
          )}
          {exporting ? <Trans>exporting…</Trans> : <Trans>export</Trans>}
        </button>
        {/* #318 follow-up: reset is now a real amber button (operator:
            "don't be afraid of it"), right-aligned at the end of the
            field row; full-width on mobile. */}
        <button
          type="button"
          onClick={() => {
            // #318 follow-up: a full reset - not just the bid-event filters,
            // but every group back on (operator: reset should re-enable
            // everything, not only the actions).
            onChange({});
            onSetAllAlertClasses(true);
            onSetAllExtraKinds(true);
          }}
          className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-[11px] font-semibold rounded-md px-3 py-1.5 bg-amber-400 hover:bg-amber-300 text-slate-950 self-end shadow-sm"
          title={t`Reset all filters`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <Trans>reset</Trans>
        </button>
      </div>
    </div>
  );
}

/**
 * #318 follow-up: bulk all/none control for an opt-out filter group.
 * Rendered as a segmented button pair (bordered pills) so it clearly
 * reads as clickable - the operator missed the old faint gray "all · none"
 * text entirely, thinking it was part of the header.
 */
function AllNone({ onAll, onNone }: { onAll: () => void; onNone: () => void }) {
  const { i18n } = useLingui();
  void i18n;
  const seg =
    'px-1.5 py-0.5 text-[10px] font-medium text-slate-300 hover:bg-slate-700 hover:text-white';
  return (
    <span className="inline-flex items-stretch rounded border border-slate-600 overflow-hidden bg-slate-800/60">
      <button type="button" onClick={onAll} className={seg}>
        <Trans>all</Trans>
      </button>
      <button type="button" onClick={onNone} className={`${seg} border-l border-slate-600`}>
        <Trans>none</Trans>
      </button>
    </span>
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
      <td className="py-1 px-3 whitespace-nowrap">
        <ActionGlyph kind={event.kind} />
        <span className="ml-1.5 text-slate-200">{labels[event.kind]}</span>
      </td>
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {bidId}
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
  highlighted,
  onClick,
}: {
  span: AlertConditionSpanView;
  fmt: ReturnType<typeof useFormatters>;
  highlighted: boolean;
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
      id={`alert-span-row-${span.open_id}`}
      onClick={onClick}
      className={`border-t border-slate-800/70 align-top cursor-pointer transition-colors ${
        highlighted ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : 'hover:bg-slate-800/30'
      }`}
      title={t`Show details`}
    >
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(span.start_ms)}
      </td>
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
      <td className="py-1 px-3 font-mono whitespace-nowrap">{dash}</td>
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

/**
 * #317/#318: a non-bid, non-alert event (payout / deposit / pool block /
 * IP change / retarget / point-alert / config / boot) as a log row.
 * Shares the table grid; numeric bid columns blank. Clicking opens the
 * detail side panel (LogExtraDrawer), which carries the "View on chart"
 * jump.
 */
function LogExtraRow({
  extra,
  fmt,
  highlighted,
  onClick,
}: {
  extra: LogExtraItem;
  fmt: ReturnType<typeof useFormatters>;
  highlighted: boolean;
  onClick: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const color = logExtraColor(extra.kind, extra.blockVariant, extra.eventClass);
  const dash = <span className="text-slate-600">—</span>;
  return (
    <tr
      id={`log-row-${extra.key}`}
      onClick={onClick}
      className={`border-t border-slate-800/70 align-top cursor-pointer transition-colors ${
        highlighted ? 'bg-amber-500/10 ring-1 ring-amber-500/40' : 'hover:bg-slate-800/30'
      }`}
      title={t`View details`}
    >
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(extra.ts)}
      </td>
      <td className="py-1 px-3 whitespace-nowrap">
        <LogExtraGlyph kind={extra.kind} blockVariant={extra.blockVariant} eventClass={extra.eventClass} />
        <span className="ml-1.5" style={{ color }}>
          {extra.label ?? logExtraLabel(extra.kind)}
        </span>
      </td>
      <td className="py-1 px-3 font-mono whitespace-nowrap">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-right">{dash}</td>
      <td className="py-1 px-3 text-slate-400 max-w-[20rem] truncate" title={extra.summary}>
        {extra.summary}
      </td>
    </tr>
  );
}

/**
 * #318 follow-up: block-explorer URL for an on-chain log entry (block ->
 * block URL, payout/deposit -> tx URL), or '' when it has no on-chain
 * component or no template is configured.
 */
function logExtraExplorerUrl(extra: LogExtraItem, txTpl: string, blockTpl: string): string {
  if (extra.kind === 'block' && extra.block && blockTpl) {
    return applyExplorerTemplate(blockTpl, {
      block_hash: extra.block.block_hash,
      height: extra.block.height,
    });
  }
  if (extra.kind === 'payout' && extra.payout && txTpl) {
    return applyExplorerTemplate(txTpl, { txid: extra.payout.txid });
  }
  if (extra.kind === 'deposit' && extra.deposit && txTpl) {
    return applyExplorerTemplate(txTpl, { txid: extra.deposit.tx_id });
  }
  return '';
}

/**
 * #318 follow-up: slide-over detail panel for an extra log entry,
 * mirroring BidEventDrawer / AlertSpanDrawer. Clicking a payout / deposit
 * / block / IP / retarget / point-alert / config / boot row opens this
 * instead of jumping straight to the chart - the operator expects a
 * detail step first, with explicit "View on chart" / "View in block
 * explorer" buttons.
 */
function LogExtraDrawer({
  extra,
  fmt,
  txUrlTemplate,
  blockUrlTemplate,
  onClose,
}: {
  extra: LogExtraItem;
  fmt: ReturnType<typeof useFormatters>;
  txUrlTemplate: string;
  blockUrlTemplate: string;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const navigate = useNavigate();
  const color = logExtraColor(extra.kind, extra.blockVariant, extra.eventClass);
  const label = extra.label ?? logExtraLabel(extra.kind);
  const jumpUrl = logExtraJumpUrl(extra);
  // #318 follow-up: on-chain events get a "View in block explorer" button
  // next to "View on chart" (block -> block URL, payout/deposit -> tx URL).
  const explorerUrl = logExtraExplorerUrl(extra, txUrlTemplate, blockUrlTemplate);

  const body = (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="flex-1 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="bg-slate-900 border-l border-slate-700 shadow-2xl w-full sm:w-[24rem] max-w-full overflow-y-auto pointer-events-auto flex flex-col"
        role="dialog"
        aria-label={t`Event detail`}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <div
              className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5"
              style={{ color }}
            >
              <LogExtraGlyph kind={extra.kind} blockVariant={extra.blockVariant} eventClass={extra.eventClass} />
              {label}
            </div>
            <div className="text-xs text-slate-300 mt-1 font-mono whitespace-nowrap">
              {fmt.timestamp(extra.ts)}
            </div>
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
          {(jumpUrl !== null || explorerUrl) && (
            <div className="flex flex-wrap gap-2">
              {jumpUrl !== null && (
                <button
                  type="button"
                  onClick={() => navigate(jumpUrl)}
                  className="px-3 py-1.5 rounded-md bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs inline-flex items-center gap-1.5 shadow-sm"
                  title={t`Open the chart at this event`}
                >
                  <Trans>View on chart</Trans>
                  <span aria-hidden="true">→</span>
                </button>
              )}
              {explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-md border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold text-xs inline-flex items-center gap-1.5"
                  title={t`Open this on-chain event in a block explorer`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                  <Trans>View in block explorer</Trans>
                </a>
              )}
            </div>
          )}

          <LogExtraDetail extra={extra} />
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}

/** Label/value row for the detail drawer (mono, right-aligned value). */
function DetailRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-200 font-mono text-right break-all">{value}</span>
    </div>
  );
}

/** #318 follow-up: mono value with a click-to-copy icon, for the long
 *  hashes / txids the operator doesn't want displayed as a wall of
 *  digits ("just say the hash, and let me copy it"). */
function CopyableValue({ value }: { value: string }) {
  const { i18n } = useLingui();
  void i18n;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={t`Copy`}
      className="group flex items-start gap-1.5 text-left w-full"
    >
      <span className="text-[11px] text-slate-300 font-mono break-all leading-snug flex-1">{value}</span>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5 text-slate-500 group-hover:text-amber-300">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
      )}
    </button>
  );
}

/**
 * #318 follow-up: per-kind detail for the log drawer, mirroring what the
 * event's chart tooltip shows (operator: the side panel should be
 * symmetric with the graph tooltip). Falls back to the row summary for
 * kinds without a rich tooltip (alert / config / daemon start). The
 * on-chain explorer link is a button in the drawer header, not here.
 */
function LogExtraDetail({ extra }: { extra: LogExtraItem }) {
  const { i18n } = useLingui();
  void i18n;
  const sat = (n: number) => `${formatNumber(n, {})} sat`;

  if (extra.kind === 'block' && extra.block) {
    const b = extra.block;
    const share = b.share_log_pct_at_block;
    return (
      <>
        <section className="space-y-1">
          <DetailRow label={<Trans>height</Trans>} value={b.height} />
          <DetailRow label={<Trans>pool reward</Trans>} value={sat(b.total_reward_sat)} />
          <DetailRow label={<Trans>subsidy</Trans>} value={sat(b.subsidy_sat)} />
          <DetailRow label={<Trans>fees</Trans>} value={sat(b.fees_sat)} />
          {share !== null && share > 0 && (
            <>
              <DetailRow label={<Trans>share log</Trans>} value={`${share.toFixed(4)}%`} />
              <DetailRow
                label={<Trans>our earnings (est.)</Trans>}
                value={sat(Math.round((b.total_reward_sat * share) / 100))}
              />
            </>
          )}
        </section>
        {b.signals_bip110 === true && (
          <div className="text-amber-300 text-[11px]">
            <Trans>Signaling BIP 110 (Reduced Data Temporary Soft Fork)</Trans>
          </div>
        )}
        <section>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            <Trans>Block hash</Trans>
          </div>
          <CopyableValue value={b.block_hash} />
        </section>
      </>
    );
  }
  if (extra.kind === 'payout' && extra.payout) {
    const e = extra.payout;
    return (
      <>
        <section className="space-y-1">
          <DetailRow label={<Trans>amount</Trans>} value={sat(e.value_sat)} />
          <DetailRow label={<Trans>block height</Trans>} value={e.block_height} />
        </section>
        <section>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            <Trans>Transaction</Trans>
          </div>
          <CopyableValue value={`${e.txid}:${e.vout}`} />
        </section>
      </>
    );
  }
  if (extra.kind === 'deposit' && extra.deposit) {
    const d = extra.deposit;
    return (
      <>
        <section className="space-y-1">
          <DetailRow label={<Trans>amount</Trans>} value={sat(d.amount_sat)} />
          {d.address && <DetailRow label={<Trans>address</Trans>} value={d.address} />}
        </section>
        <section>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            <Trans>Transaction</Trans>
          </div>
          <CopyableValue value={d.tx_id} />
        </section>
      </>
    );
  }
  if (extra.kind === 'ip' && extra.ip) {
    const c = extra.ip;
    return (
      <section className="space-y-1">
        <DetailRow label={<Trans>previous</Trans>} value={c.old_ip ?? '—'} />
        <DetailRow label={<Trans>new</Trans>} value={c.new_ip} />
      </section>
    );
  }
  if (extra.kind === 'retarget' && extra.retarget) {
    const r = extra.retarget;
    const pct = ((r.difficulty - r.previous) / r.previous) * 100;
    return (
      <section className="space-y-1">
        <DetailRow label={<Trans>difficulty</Trans>} value={`${(r.difficulty / 1e12).toFixed(2)} T`} />
        <DetailRow label={<Trans>previous</Trans>} value={`${(r.previous / 1e12).toFixed(2)} T`} />
        <DetailRow
          label={<Trans>change</Trans>}
          value={`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}
        />
      </section>
    );
  }
  // alert / config / daemon start: no rich tooltip -> show the summary.
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
        <Trans>Details</Trans>
      </div>
      <p className="text-xs text-slate-200 whitespace-normal leading-snug break-words">
        {extra.summary}
      </p>
    </section>
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
    // Lucide `arrow-left-right` - run-mode switch (DRY_RUN / LIVE /
    // PAUSED). Distinct from the `power` glyph, which daemon-started
    // owns; the two used to collide.
    return (
      <svg {...base} stroke="#c4b5fd">
        <path d="M8 3 4 7l4 4" />
        <path d="M4 7h16" />
        <path d="m16 21 4-4-4-4" />
        <path d="M20 17H4" />
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
