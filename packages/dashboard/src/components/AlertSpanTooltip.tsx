/**
 * #316: pinned pop-up for a condition-band marker clicked on a chart -
 * same interaction language as the other chart markers (pool blocks, IP
 * changes), not the History slide-over. Shows the condition, severity,
 * started/recovered/duration, the alert body, and a "View in history"
 * link that jumps to the matching row on the History page.
 */
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { AlertConditionSpanView } from '../lib/api';
import { conditionColor, conditionLabel } from '../lib/alertConditions';
import { formatDuration } from '../lib/format';
import { useFormatters } from '../lib/locale';

export interface AlertSpanTooltipState {
  span: AlertConditionSpanView;
  x: number;
  y: number;
}

export function AlertSpanTooltip({
  tip,
  onClose,
}: {
  tip: AlertSpanTooltipState;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement | null>(null);
  const { span } = tip;
  const color = conditionColor(span.event_class);
  const ongoing = span.end_ms === null;
  const durationMs = (span.end_ms ?? Date.now()) - span.start_ms;

  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let left = tip.x + 12;
    let top = tip.y + 12;
    if (left + rect.width > window.innerWidth - margin) left = tip.x - rect.width - 12;
    if (top + rect.height > window.innerHeight - margin) top = tip.y - rect.height - 12;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, span.open_id]);

  return (
    <div
      ref={ref}
      className={`fixed z-50 bg-slate-950 border border-slate-500 rounded-lg shadow-lg p-3 text-xs pointer-events-auto max-w-[20rem] ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
          <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          {conditionLabel(span.event_class)}
          <span className="text-slate-500">· {span.severity}</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t`close`}
          className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
        >
          ×
        </button>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-slate-300">
        <div className="flex justify-between gap-4">
          <span className="text-slate-500"><Trans>Started</Trans></span>
          <span>{fmt.timestamp(span.start_ms)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-500"><Trans>Recovered</Trans></span>
          <span>{span.end_ms !== null ? fmt.timestamp(span.end_ms) : <Trans>ongoing</Trans>}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-500"><Trans>Duration</Trans></span>
          <span>{ongoing ? <Trans>ongoing</Trans> : formatDuration(durationMs)}</span>
        </div>
      </div>
      <p className="mt-2 text-slate-300 whitespace-normal leading-snug">{span.body}</p>
      <button
        type="button"
        onClick={() => navigate(`/history?focus_span=${span.open_id}`)}
        className="mt-2 text-amber-300 hover:text-amber-200 inline-flex items-center gap-1"
      >
        <Trans>View in history</Trans>
        <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}
