import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

const UNACK_ONLY_STORAGE_KEY = 'hashrate-autopilot.alertsUnacknowledgedOnly';
// #121: cursor pagination page size. Server hard-cap is 1000; 50 is
// enough to fit on a typical screen without scrolling and gives the
// "Load older" button the time to feel useful.
const PAGE_SIZE = 50;

import {
  api,
  type AlertDeliveryStatus,
  type AlertRow,
  type AlertSeverity,
} from '../lib/api';
import { formatAge, formatDuration } from '../lib/format';
import { useFormatters } from '../lib/locale';

export function Alerts() {
  const qc = useQueryClient();
  const { i18n } = useLingui();
  void i18n;
  // Persist the filter checkbox so an operator-set preference
  // survives a page reload. Sibling pattern to Status.tsx's chart
  // range / right-axis preferences. localStorage is fine here -
  // each operator's browser has its own filter intent.
  const [unackOnly, setUnackOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(UNACK_ONLY_STORAGE_KEY) === '1';
  });
  useEffect(() => {
    window.localStorage.setItem(UNACK_ONLY_STORAGE_KEY, unackOnly ? '1' : '0');
  }, [unackOnly]);

  // #134 follow-up: free-text search across event titles + bodies.
  // Pure client-side filter; the highlight rendering wraps matches in
  // <mark>. Empty query disables both filtering and highlighting.
  const [searchQuery, setSearchQuery] = useState('');

  // #121: cursor pagination. The head page (most-recent 50 rows)
  // refreshes on the same 30s cadence as before. Older pages are
  // appended one-at-a-time when the operator clicks "Load older",
  // and reset to empty when the filter toggle changes (otherwise
  // the operator would see filtered + unfiltered rows interleaved).
  const [olderPages, setOlderPages] = useState<
    Array<{ alerts: AlertRow[]; has_more: boolean }>
  >([]);

  // Reset older pages when the filter changes; the cursor referent
  // shifts with the filter set.
  useEffect(() => {
    setOlderPages([]);
  }, [unackOnly]);

  const headFilters: Parameters<typeof api.alertsList>[0] = { limit: PAGE_SIZE };
  if (unackOnly) headFilters.unacknowledged_only = true;

  const query = useQuery({
    queryKey: ['alerts', unackOnly],
    queryFn: () => api.alertsList(headFilters),
    refetchInterval: 30_000,
  });

  // Invalidate both the table query AND the nav-bar unread-count query
  // (Layout's `['alerts-head']`) so the red badge updates the instant
  // the operator clicks. Without the second invalidate the badge waits
  // up to 30s for its next poll - confusingly stale right after an ack.
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['alerts-head'] });
  };

  const ack = useMutation({
    mutationFn: (id: number) => api.alertAcknowledge(id),
    onSuccess: invalidateAll,
  });

  const ackAll = useMutation({
    mutationFn: () => api.alertAcknowledgeAll(),
    onSuccess: invalidateAll,
  });

  // Concatenate head + older pages, dedupe on id in case a new row
  // arrived during pagination and bumped a row from the head into a
  // later page (rare but possible when `unackOnly` is false).
  const alerts = useMemo(() => {
    const seen = new Set<number>();
    const out: AlertRow[] = [];
    const headRows = query.data?.alerts ?? [];
    for (const row of headRows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
      }
    }
    for (const page of olderPages) {
      for (const row of page.alerts) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          out.push(row);
        }
      }
    }
    return out;
  }, [query.data, olderPages]);

  // has_more comes from the most recently loaded page (the bottom of
  // the visible list). Empty older-pages array → use the head's flag.
  const hasMore =
    olderPages.length > 0
      ? olderPages[olderPages.length - 1]!.has_more
      : (query.data?.has_more ?? false);

  const totalCount = query.data?.total_count ?? alerts.length;
  const unackedCount = useMemo(
    () => alerts.filter((a) => a.acknowledged_at_ms === null).length,
    [alerts],
  );

  const loadOlder = useMutation({
    mutationFn: async () => {
      const lastRow = alerts[alerts.length - 1];
      if (!lastRow) throw new Error('no rows to paginate from');
      return api.alertsList({
        ...headFilters,
        before_created_at_ms: lastRow.created_at,
      });
    },
    onSuccess: (resp) =>
      setOlderPages((prev) => [...prev, { alerts: resp.alerts, has_more: resp.has_more }]),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-2xl text-slate-100">
          <Trans>Alerts</Trans>
        </h1>
        <p className="text-xs text-slate-500">
          <Trans>
            Audit trail for every notification the daemon recorded - sent, failed,
            muted, or given-up. Configure the Telegram destination on
            Config → Notifications.
          </Trans>
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={unackOnly}
            onChange={(e) => setUnackOnly(e.target.checked)}
            className="accent-amber-400 h-3.5 w-3.5"
          />
          <Trans>unacknowledged only</Trans>
        </label>
        <button
          type="button"
          onClick={() => ackAll.mutate()}
          disabled={ackAll.isPending || unackedCount === 0}
          className="px-2 py-1 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {ackAll.isPending ? (
            <Trans>marking…</Trans>
          ) : (
            <Trans>mark all as seen ({unackedCount})</Trans>
          )}
        </button>
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t`Search titles + bodies...`}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 w-full sm:w-48"
        />
        {alerts.length > 0 && (
          <span className="ml-auto text-xs text-slate-500">
            <Trans>
              showing {alerts.length} of {totalCount}
            </Trans>
          </span>
        )}
      </section>

      {query.isPending && (
        <div className="text-sm text-slate-500">
          <Trans>loading…</Trans>
        </div>
      )}

      {query.isError && (
        <div className="text-sm text-red-400">{(query.error as Error).message}</div>
      )}

      {query.data && alerts.length === 0 && (
        <div className="text-sm text-slate-500 italic py-6 text-center bg-slate-900 border border-slate-800 rounded">
          <Trans>no alerts matching the filter.</Trans>
        </div>
      )}

      {alerts.length > 0 && (
        <EventGroupedView
          alerts={alerts}
          query={searchQuery}
          onAcknowledge={(id) => ack.mutate(id)}
        />
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => loadOlder.mutate()}
            disabled={loadOlder.isPending}
            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-40"
          >
            {loadOlder.isPending ? <Trans>loading…</Trans> : <Trans>load older</Trans>}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * #134: event-grouped view. An "event" is a firing AlertRow plus
 * (optionally) its recovery row joined via paired_alert_id. INFO-only
 * rows without a recovery render as a single-entry event so the page
 * stays homogeneous - one card per event group, even when the group
 * has only one entry.
 *
 * Open events (no recovery yet) sit pinned at the top; resolved events
 * sit below. Both sections sort newest-first.
 *
 * Open events render expanded by default (the operator immediately
 * sees what's currently wrong); resolved events render collapsed
 * (header only). The chevron on each header toggles state per-card,
 * stored in component-local React state.
 */
interface AlertEventGroup {
  firing: AlertRow;
  recovery: AlertRow | null;
}

function groupIntoEvents(alerts: AlertRow[]): AlertEventGroup[] {
  // Build lookup: firing_id -> recovery row.
  const recoveryByFiringId = new Map<number, AlertRow>();
  for (const row of alerts) {
    if (row.paired_alert_id !== null) {
      recoveryByFiringId.set(row.paired_alert_id, row);
    }
  }
  // Walk firings in source order (newest first by created_at).
  const groups: AlertEventGroup[] = [];
  for (const row of alerts) {
    if (row.paired_alert_id !== null) continue; // recovery row, attached to a firing
    groups.push({
      firing: row,
      recovery: recoveryByFiringId.get(row.id) ?? null,
    });
  }
  return groups;
}

function EventGroupedView({
  alerts,
  query,
  onAcknowledge,
}: {
  alerts: AlertRow[];
  query: string;
  onAcknowledge: (id: number) => void;
}) {
  const allGroups = useMemo(() => groupIntoEvents(alerts), [alerts]);
  // #134 follow-up: free-text filter. Match firing.title|body and
  // recovery.title|body against the lowercased query. Empty query
  // disables filtering. Highlighting at render time uses the same
  // query string.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((g) => {
      const haystack = [
        g.firing.title,
        g.firing.body,
        g.recovery?.title ?? '',
        g.recovery?.body ?? '',
      ]
        .join('\n')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [allGroups, query]);
  // #139: bucket model. OPEN = firing, no ack, no recovery (the
  // "needs my attention" set). #153: ACKNOWLEDGED + RESOLVED merged
  // into a single bucket sorted strictly newest-first across both
  // states. The boundary between the two states never represented a
  // time boundary - in the previous two-section layout a 2-min-ago
  // recovery could appear visually below a 1-day-old ack, breaking
  // chronological reading. The per-card right-side pill still
  // distinguishes RESOLVED (emerald) vs ACKNOWLEDGED (slate).
  const open = useMemo(
    () =>
      groups.filter(
        (g) => g.recovery === null && g.firing.acknowledged_at_ms === null,
      ),
    [groups],
  );
  const done = useMemo(
    () =>
      groups
        .filter(
          (g) =>
            g.recovery !== null ||
            (g.recovery === null && g.firing.acknowledged_at_ms !== null),
        )
        .sort((a, b) => b.firing.created_at - a.firing.created_at),
    [groups],
  );

  // Per-card expand/collapse override. Default state is computed at
  // render time: open events expanded, resolved collapsed. The set
  // tracks IDs that have been TOGGLED away from their default; an
  // empty set means everyone is at their default.
  const [toggled, setToggled] = useState<Set<number>>(() => new Set());
  const toggle = (id: number) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      {open.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-amber-400 mb-2">
            <Trans>Open ({open.length})</Trans>
          </h2>
          <div className="space-y-2">
            {open.map((g) => (
              <EventCard
                key={g.firing.id}
                group={g}
                query={query}
                expandedDefault={true}
                isToggled={toggled.has(g.firing.id)}
                onToggle={() => toggle(g.firing.id)}
                onAcknowledge={() => onAcknowledge(g.firing.id)}
              />
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-2">
            <Trans>Acknowledged and resolved ({done.length})</Trans>
          </h2>
          <div className="space-y-2">
            {done.map((g) => (
              <EventCard
                key={g.firing.id}
                group={g}
                query={query}
                // Collapse by default. Search-active expands so the
                // operator can scan body text without per-row clicks.
                expandedDefault={query.trim().length > 0}
                isToggled={toggled.has(g.firing.id)}
                onToggle={() => toggle(g.firing.id)}
                onAcknowledge={() => onAcknowledge(g.firing.id)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EventCard({
  group,
  query,
  expandedDefault,
  isToggled,
  onToggle,
  onAcknowledge,
}: {
  group: AlertEventGroup;
  query: string;
  expandedDefault: boolean;
  isToggled: boolean;
  onToggle: () => void;
  onAcknowledge: () => void;
}) {
  const fmt = useFormatters();
  const expanded = isToggled ? !expandedDefault : expandedDefault;
  const { firing, recovery } = group;
  const durationOpenMs =
    (recovery?.created_at ?? Date.now()) - firing.created_at;
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-slate-800/40"
      >
        <span className="text-slate-500 text-xs mt-0.5 select-none w-3 shrink-0">
          {expanded ? '▾' : '▸'}
        </span>
        <SeverityBadge severity={firing.severity} isRecovery={false} />
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-sm text-slate-100">
              <HighlightText text={firing.title} query={query} />
            </span>
            <span
              className={
                'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap ' +
                (recovery
                  ? 'bg-emerald-900/30 border-emerald-800 text-emerald-300'
                  : firing.acknowledged_at_ms !== null
                    ? 'bg-slate-800/60 border-slate-700 text-slate-300'
                    : 'bg-amber-900/30 border-amber-700 text-amber-300')
              }
            >
              {recovery ? (
                <Trans>resolved</Trans>
              ) : firing.acknowledged_at_ms !== null ? (
                <Trans>acknowledged · {formatAge(firing.created_at)}</Trans>
              ) : (
                <Trans>open · {formatAge(firing.created_at)}</Trans>
              )}
            </span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {fmt.timestamp(firing.created_at)} · {formatAge(firing.created_at)}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-2 space-y-2 bg-slate-950/40">
          {/* Resolved first, Fired below: within the card, the newest
              entry sits on top so the reading order matches the
              page-level newest-first ordering. */}
          {recovery && (
            <EntryRow
              kind="resolved"
              row={recovery}
              timestampLabel={fmt.timestamp(recovery.created_at)}
              ageLabel={formatAge(recovery.created_at)}
              durationOpenMs={durationOpenMs}
              query={query}
              onAcknowledge={() => {}}
            />
          )}
          <EntryRow
            kind="fired"
            row={firing}
            timestampLabel={fmt.timestamp(firing.created_at)}
            ageLabel={formatAge(firing.created_at)}
            query={query}
            onAcknowledge={onAcknowledge}
          />
        </div>
      )}
    </div>
  );
}

function EntryRow({
  kind,
  row,
  timestampLabel,
  ageLabel,
  durationOpenMs,
  query,
  onAcknowledge,
}: {
  kind: 'fired' | 'resolved';
  row: AlertRow;
  timestampLabel: string;
  ageLabel: string;
  durationOpenMs?: number;
  query: string;
  onAcknowledge: () => void;
}) {
  return (
    <div className="text-sm space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">
          {kind === 'fired' ? <Trans>fired</Trans> : <Trans>resolved</Trans>}
        </span>
        <span className="text-xs text-slate-500">
          {timestampLabel} · {ageLabel}
          {kind === 'resolved' && durationOpenMs !== undefined && (
            <>
              {' · '}
              <Trans>was open for {formatDuration(durationOpenMs)}</Trans>
            </>
          )}
        </span>
        {kind === 'fired' && row.acknowledged_at_ms === null && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAcknowledge(); }}
            className="ml-auto px-2 py-0.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
          >
            <Trans>mark as seen</Trans>
          </button>
        )}
        {kind === 'fired' && row.acknowledged_at_ms !== null && (
          <span className="ml-auto text-[10px] text-slate-500">
            <Trans>acknowledged {formatAge(row.acknowledged_at_ms)}</Trans>
          </span>
        )}
      </div>
      <div className="text-xs text-slate-300 break-words">
        <HighlightText text={row.body} query={query} />
      </div>
      <DeliveryBadge status={row.delivery_status} attempts={row.delivery_attempts} />
    </div>
  );
}

/**
 * #129: severity-label badge in front of every alert title.
 *
 * Three tiers - IMPORTANT (red, the high-priority bucket that fires
 * the retry ladder + Telegram emoji prefix), WARNING (amber, soft
 * warnings), INFO (slate, opt-in good news + recovery rows). Recovery
 * rows are stored as INFO with a non-null `paired_alert_id`; render
 * them as RESOLVED (emerald) so the operator can scan resolved-vs-
 * still-firing at a glance, mirroring the Telegram message prefix.
 */
function SeverityBadge({
  severity,
  isRecovery,
}: {
  severity: AlertSeverity;
  isRecovery: boolean;
}) {
  if (isRecovery) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-800 text-emerald-300 whitespace-nowrap">
        <Trans>resolved</Trans>
      </span>
    );
  }
  const cls =
    severity === 'IMPORTANT'
      ? 'bg-red-900/40 border-red-800 text-red-300'
      : severity === 'WARNING'
        ? 'bg-amber-900/40 border-amber-800 text-amber-300'
        : 'bg-slate-800 border-slate-700 text-slate-400';
  const label =
    severity === 'IMPORTANT' ? (
      <Trans>important</Trans>
    ) : severity === 'WARNING' ? (
      <Trans>warning</Trans>
    ) : (
      <Trans>info</Trans>
    );
  return (
    <span
      className={
        'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap ' +
        cls
      }
    >
      {label}
    </span>
  );
}

function DeliveryBadge({
  status,
  attempts,
}: {
  status: AlertDeliveryStatus;
  attempts: number;
}) {
  const cls =
    status === 'sent'
      ? 'text-emerald-300'
      : status === 'failed' || status === 'gave_up'
        ? 'text-red-400'
        : status === 'muted'
          ? 'text-slate-500'
          : 'text-amber-300';
  return (
    <span className={'text-xs font-mono ' + cls}>
      {status}
      {attempts > 0 && ` · ${attempts}`}
    </span>
  );
}

/**
 * #134 follow-up: render text with case-insensitive substring matches
 * wrapped in <mark>. Empty query falls through to plain text. The
 * regex-escape lets the operator search for strings that contain
 * regex metacharacters (`.`, `(`, `*`) without breaking the splitter.
 */
function HighlightText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  const lower = q.toLowerCase();
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lower ? (
          <mark key={i} className="bg-amber-400/40 text-amber-100 rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}
