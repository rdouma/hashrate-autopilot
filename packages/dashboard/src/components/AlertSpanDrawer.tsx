/**
 * #316: slide-over detail drawer for an alerted condition span, mirroring
 * BidEventDrawer. Shows the condition, severity, when it started and
 * recovered (or that it's ongoing), the duration, and the full alert
 * body, with a "View on chart" button that pans the price chart to the
 * onset and pulses a focus beacon on the band.
 */
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';

import type { AlertConditionSpanView } from '../lib/api';
import { conditionColor, conditionLabel } from '../lib/alertConditions';
import { formatDuration } from '../lib/format';
import { useFormatters } from '../lib/locale';

export function AlertSpanDrawer({
  span,
  onClose,
}: {
  span: AlertConditionSpanView;
  onClose: () => void;
}): React.JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const navigate = useNavigate();
  const color = conditionColor(span.event_class);
  const ongoing = span.end_ms === null;
  const durationMs = (span.end_ms ?? Date.now()) - span.start_ms;

  const goToChart = () => {
    navigate(`/?at=${span.start_ms}&focus_span=${span.open_id}`);
  };

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
        aria-label={t`Alert condition detail`}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {conditionLabel(span.event_class)}
              <span className="text-slate-500">· {span.severity}</span>
            </div>
            <div className="text-xs text-slate-300 mt-1 whitespace-nowrap">
              {ongoing ? <Trans>ongoing</Trans> : formatDuration(durationMs)}
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
          <button
            type="button"
            onClick={goToChart}
            className="px-3 py-1.5 rounded-md bg-amber-400 hover:bg-amber-300 text-slate-950 font-semibold text-xs inline-flex items-center gap-1.5 shadow-sm"
            title={t`Open the price chart pinned to this condition`}
          >
            <Trans>View on chart</Trans>
            <span aria-hidden="true">→</span>
          </button>

          <section className="space-y-1">
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500"><Trans>Started</Trans></span>
              <span className="text-slate-200 font-mono text-right">{fmt.timestamp(span.start_ms)}</span>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500"><Trans>Recovered</Trans></span>
              <span className="text-slate-200 font-mono text-right">
                {span.end_ms !== null ? fmt.timestamp(span.end_ms) : <Trans>ongoing</Trans>}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500"><Trans>Duration</Trans></span>
              <span className="text-slate-200 font-mono text-right">
                {ongoing ? <Trans>ongoing</Trans> : formatDuration(durationMs)}
              </span>
            </div>
          </section>

          <section>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              <Trans>What happened</Trans>
            </div>
            <p className="text-xs text-slate-200 whitespace-normal leading-snug">{span.body}</p>
          </section>
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}
