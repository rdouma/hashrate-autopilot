import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

const UNACK_ONLY_STORAGE_KEY = 'braiins.alertsUnacknowledgedOnly';

import {
  api,
  type AlertDeliveryStatus,
  type AlertRow,
} from '../lib/api';
import { formatAge } from '../lib/format';

const SNOOZE_PRESETS: Array<{ minutes: number; label: () => string }> = [
  { minutes: 30, label: () => t`30m` },
  { minutes: 120, label: () => t`2h` },
  { minutes: 1440, label: () => t`24h` },
];

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

  const filters: Parameters<typeof api.alertsList>[0] = { limit: 200 };
  if (unackOnly) filters.unacknowledged_only = true;

  const query = useQuery({
    queryKey: ['alerts', unackOnly],
    queryFn: () => api.alertsList(filters),
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

  const snooze = useMutation({
    mutationFn: ({ id, minutes }: { id: number; minutes: number }) =>
      api.alertSnooze(id, minutes),
    onSuccess: invalidateAll,
  });

  const ackAll = useMutation({
    mutationFn: () => api.alertAcknowledgeAll(),
    onSuccess: invalidateAll,
  });

  const alerts = query.data?.alerts ?? [];
  const unackedCount = alerts.filter((a) => a.acknowledged_at_ms === null).length;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-2xl text-slate-100">
          <Trans>Alerts</Trans>
        </h1>
        <p className="text-xs text-slate-500">
          <Trans>
            Audit trail for every notification the daemon recorded - sent, failed,
            muted, snoozed, or given-up. Configure the Telegram destination on
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
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/40 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>when</Trans>
                </th>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>title</Trans>
                </th>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>delivery</Trans>
                </th>
                <th className="text-right px-3 py-2 font-normal">
                  <Trans>actions</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((row) => (
                <AlertRow
                  key={row.id}
                  row={row}
                  onAcknowledge={() => ack.mutate(row.id)}
                  onSnooze={(minutes) => snooze.mutate({ id: row.id, minutes })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AlertRow({
  row,
  onAcknowledge,
  onSnooze,
}: {
  row: AlertRow;
  onAcknowledge: () => void;
  onSnooze: (minutes: number) => void;
}) {
  return (
    <tr className="border-t border-slate-800 align-top">
      <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">
        {formatAge(row.created_at)}
      </td>
      <td className="px-3 py-2">
        <div className="text-slate-200">{row.title}</div>
        <div className="text-xs text-slate-500 mt-0.5 break-words max-w-xl">{row.body}</div>
      </td>
      <td className="px-3 py-2">
        <DeliveryBadge status={row.delivery_status} attempts={row.delivery_attempts} />
        {row.snoozed_until_ms !== null && row.snoozed_until_ms > Date.now() && (
          <div className="text-[10px] text-slate-500 mt-0.5">
            <Trans>snoozed until</Trans> {formatAge(row.snoozed_until_ms)}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {row.acknowledged_at_ms === null ? (
          <button
            onClick={onAcknowledge}
            className="px-2 py-1 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
          >
            <Trans>mark as seen</Trans>
          </button>
        ) : (
          <span className="text-[10px] text-slate-500">
            <Trans>acknowledged {formatAge(row.acknowledged_at_ms)}</Trans>
          </span>
        )}
        {row.delivery_status !== 'sent' && row.delivery_status !== 'gave_up' && (
          <span className="ml-2 inline-flex border border-slate-700 rounded overflow-hidden">
            {SNOOZE_PRESETS.map((p, i) => (
              <button
                key={p.minutes}
                onClick={() => onSnooze(p.minutes)}
                className={
                  'px-1.5 py-1 text-[10px] text-slate-400 hover:bg-slate-800 ' +
                  (i > 0 ? 'border-l border-slate-700' : '')
                }
                title={t`snooze ${p.label()}`}
              >
                {p.label()}
              </button>
            ))}
          </span>
        )}
      </td>
    </tr>
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
        : status === 'muted' || status === 'snoozed'
          ? 'text-slate-500'
          : 'text-amber-300';
  return (
    <span className={'text-xs font-mono ' + cls}>
      {status}
      {attempts > 0 && ` · ${attempts}`}
    </span>
  );
}
