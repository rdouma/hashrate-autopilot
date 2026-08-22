/**
 * #316: slide-over detail drawer for an alerted condition span, mirroring
 * BidEventDrawer. Shows the condition, severity, when it started and
 * recovered (or that it's ongoing), the duration, and the full alert
 * body, with a "View on chart" button that pans the price chart to the
 * onset and pulses a focus beacon on the band.
 *
 * #322: opened from a recovery row, the drawer presents the healing
 * instead - emerald "<condition> resolved" header, the recovery body,
 * and "View on chart" pans to the band's CLOSING edge (still beaconing
 * the same span).
 */
import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import type { AlertConditionSpanView } from '../lib/api';
import { conditionColor, conditionLabel } from '../lib/alertConditions';
import { EventNoteField } from './EventNoteField';
import { useChartColorOverrides } from '../lib/chartColorOverrides';
import { formatDuration } from '../lib/format';
import { useFormatters } from '../lib/locale';

export function AlertSpanDrawer({
  span,
  recovery = false,
  onClose,
}: {
  span: AlertConditionSpanView;
  /** #322: present the span's recovery moment instead of its opening. */
  recovery?: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const navigate = useNavigate();
  const color = recovery ? '#34d399' : conditionColor(span.event_class, useChartColorOverrides());
  const ongoing = span.end_ms === null;
  const endForCalc = span.end_ms ?? Date.now();

  // #341: break the span into its two halves. The alert *duration* is the
  // time from the loud alert firing to recovery (what the drawer used to
  // call "Duration" - the small number the operator found misleading). The
  // *threshold* is the sustained wait before firing; the *total* is the
  // real outage (onset -> recovery), which is what the operator actually
  // cares about ("how long did I have zero hashrate?").
  //
  // When the firing row recorded condition-onset (onset_known) both the
  // threshold and total are EXACT. Otherwise (pre-0119 rows) we estimate
  // the threshold from current config and footnote it as a best guess.
  const alertDurationMs = endForCalc - span.fired_at;
  const thresholdMs = span.onset_known
    ? span.fired_at - span.start_ms
    : span.threshold_minutes !== null
      ? span.threshold_minutes * 60_000
      : null;
  const totalMs = span.onset_known
    ? endForCalc - span.start_ms
    : thresholdMs !== null
      ? thresholdMs + alertDurationMs
      : alertDurationMs;
  // Estimated (rather than exact) only when we had to lean on current
  // config because the onset was never recorded.
  const isEstimate = !span.onset_known && thresholdMs !== null;
  const approx = (s: string) => (isEstimate ? `≈ ${s}` : s);

  const goToChart = () => {
    // Recovery rows jump to the band's closing edge (and beacon it);
    // open rows to the onset.
    if (recovery && span.end_ms !== null) {
      navigate(`/?at=${span.end_ms}&focus_span=${span.open_id}&focus_span_edge=end`);
    } else {
      navigate(`/?at=${span.start_ms}&focus_span=${span.open_id}`);
    }
  };

  const body = (
    <div className="fixed inset-0 z-40 flex">
      <div
        className="flex-1 bg-black/40 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="bg-slate-900 border-l border-slate-700 shadow-2xl w-full sm:w-[28rem] lg:w-[34rem] xl:w-[40rem] max-w-[92vw] overflow-y-auto pointer-events-auto flex flex-col"
        role="dialog"
        aria-label={t`Alert condition detail`}
      >
        <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
              <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              {recovery
                ? t`${conditionLabel(span.event_class)} resolved`
                : conditionLabel(span.event_class)}
              {!recovery && <span className="text-slate-500">· {span.severity}</span>}
            </div>
            <div className="text-xs text-slate-300 mt-1 whitespace-nowrap">
              {ongoing ? <Trans>ongoing</Trans> : approx(formatDuration(totalMs))}
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

          {/* #341: the condition broken into threshold -> fired -> recovered,
              then the two durations (alert window vs. the real total outage)
              so "Duration 56s" no longer reads as the whole story. */}
          <section className="space-y-1">
            {thresholdMs !== null && (
              <div className="flex justify-between gap-3 text-xs">
                <span className="text-slate-500"><Trans>Threshold before firing</Trans></span>
                <span className="text-slate-200 font-mono text-right">{approx(formatDuration(thresholdMs))}</span>
              </div>
            )}
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500"><Trans>Alert fired</Trans></span>
              <span className="text-slate-200 font-mono text-right">{fmt.timestamp(span.fired_at)}</span>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500">{span.end_estimated ? <Trans>Ended (estimated)</Trans> : <Trans>Recovered</Trans>}</span>
              <span className="text-slate-200 font-mono text-right">
                {span.end_ms !== null ? fmt.timestamp(span.end_ms) : <Trans>ongoing</Trans>}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-slate-500"><Trans>Alert duration</Trans></span>
              <span className="text-slate-200 font-mono text-right">
                {ongoing ? <Trans>ongoing</Trans> : formatDuration(alertDurationMs)}
              </span>
            </div>
            <div className="flex justify-between gap-3 text-xs border-t border-slate-800 pt-1 mt-1">
              <span className="text-slate-400"><Trans>Total condition time</Trans></span>
              <span className="text-slate-100 font-mono text-right font-semibold">
                {ongoing ? <Trans>ongoing</Trans> : approx(formatDuration(totalMs))}
              </span>
            </div>
          </section>

          {isEstimate && (
            <p className="text-[11px] text-slate-500 leading-snug">
              <Trans>
                Threshold and total are estimated from your current alert
                settings. Historical config changes aren't stored, so this is
                a best guess (≈), not an exact record.
              </Trans>
            </p>
          )}

          <section>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              <Trans>What happened</Trans>
            </div>
            <p className="text-xs text-slate-200 whitespace-normal leading-snug">
              {recovery ? span.recovery_body ?? span.body : span.body}
            </p>
          </section>
          <EventNoteField eventKey={`alertspan:${span.open_id}`} />
        </div>
      </aside>
    </div>
  );

  return createPortal(body, document.body);
}
