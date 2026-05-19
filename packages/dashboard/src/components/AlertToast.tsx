import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useEffect } from 'react';

import type { AlertRow } from '../lib/api';

const INFO_TIMEOUT_MS = 5_000;
const LOUD_TIMEOUT_MS = 15_000;

export interface AlertToastProps {
  readonly alert: AlertRow;
  readonly onDismiss: () => void;
  readonly onActivate: () => void;
}

/**
 * #142: single in-dashboard toast for a freshly-arrived alert. The
 * left-border colour + severity pill mirror the in-page card
 * conventions on /alerts. Click anywhere on the toast (except the
 * dismiss button) navigates the user to /alerts.
 *
 * Recovery rows (paired_alert_id != null) override the severity
 * styling to emerald RESOLVED, matching how `Alerts.tsx` renders the
 * Resolved bucket. Without this an underlying-IMPORTANT recovery
 * would still read red even though the news is good.
 */
export function AlertToast({ alert, onDismiss, onActivate }: AlertToastProps) {
  const { i18n } = useLingui();
  void i18n;
  const isRecovery = alert.paired_alert_id !== null;
  const timeoutMs =
    isRecovery || alert.severity === 'INFO' ? INFO_TIMEOUT_MS : LOUD_TIMEOUT_MS;

  useEffect(() => {
    const handle = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(handle);
  }, [onDismiss, timeoutMs]);

  const borderCls = isRecovery
    ? 'border-l-emerald-500'
    : alert.severity === 'IMPORTANT'
      ? 'border-l-red-500'
      : alert.severity === 'WARNING'
        ? 'border-l-amber-400'
        : 'border-l-slate-500';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      className={
        'pointer-events-auto bg-slate-900 border border-slate-700 border-l-4 ' +
        borderCls +
        ' rounded shadow-lg w-80 sm:w-96 max-w-[calc(100vw-2rem)] p-3 cursor-pointer hover:bg-slate-800/80 transition-colors'
      }
    >
      <div className="flex items-start gap-2">
        <SeverityPill severity={alert.severity} isRecovery={isRecovery} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-100 font-semibold truncate">
            {alert.title}
          </div>
          <div className="text-xs text-slate-400 mt-0.5 line-clamp-2 break-words">
            {alert.body}
          </div>
        </div>
        <button
          type="button"
          aria-label={t`Dismiss`}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="text-slate-500 hover:text-slate-200 text-base leading-none px-1 -mt-0.5 -mr-1"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function SeverityPill({
  severity,
  isRecovery,
}: {
  severity: AlertRow['severity'];
  isRecovery: boolean;
}) {
  if (isRecovery) {
    return (
      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-800 text-emerald-300 whitespace-nowrap mt-0.5">
        <Trans>resolved</Trans>
      </span>
    );
  }
  const cls =
    severity === 'IMPORTANT'
      ? 'bg-red-900/40 border-red-800 text-red-300'
      : severity === 'WARNING'
        ? 'bg-amber-900/40 border-amber-800 text-amber-300'
        : 'bg-slate-800 border-slate-700 text-slate-300';
  return (
    <span
      className={
        'text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap mt-0.5 ' +
        cls
      }
    >
      {severity}
    </span>
  );
}
