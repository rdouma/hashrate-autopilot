/**
 * #316: timeline background bands + onset/recovery markers for alerted
 * condition spans, shared by HashrateChart and PriceChart. Each condition
 * class is tinted with its own configurable color slot and only renders
 * on the chart(s) it targets (CONDITION_SPAN_CLASSES[].charts).
 *
 * Each span draws:
 *   - a diagonal hatch band over its open period (#287 band language);
 *   - a small DOWN triangle at the onset (entered the condition) and an
 *     UP triangle at the recovery (returned to normal) at the top of the
 *     chart, so even a few-minutes span is visible and you can see when
 *     it cleared (operator feedback 2026-06-30);
 *   - a pulsing sonar beacon when the span is the focus target (jumped to
 *     from a History alert row via ?focus_span=).
 *
 * The native <title> tooltips name the condition, the source alert title,
 * and the duration - matching the existing untranslated band tooltips.
 */

import {
  conditionSpanClass,
  type AlertChartTarget,
} from '@hashrate-autopilot/shared';

import type { AlertConditionInterval } from '../lib/api';
import {
  conditionLabel,
  conditionRecoveryLabel,
} from '../lib/alertConditions';
import {
  darkenHex,
  getChartColor,
  parseOverrides,
  type ChartColorKey,
} from '../lib/chartColors';
import { formatDuration } from '../lib/format';

export function AlertConditionBands({
  intervals,
  target,
  xScale,
  dataMinX,
  dataMaxX,
  top,
  height,
  colorOverrides,
  idSuffix,
  focusSpanOpenId = null,
  hoverTickAt = null,
  onSpanClick,
}: {
  intervals: ReadonlyArray<AlertConditionInterval>;
  target: AlertChartTarget;
  xScale: (x: number) => number;
  dataMinX: number;
  dataMaxX: number;
  top: number;
  height: number;
  /** Parsed chart_color_overrides (from parseOverrides). */
  colorOverrides: ReturnType<typeof parseOverrides>;
  /** Unique-per-chart suffix so the <pattern> ids don't collide. */
  idSuffix: string;
  /** #316: the span (open_id) jumped to from History; gets a sonar beacon. */
  focusSpanOpenId?: number | null;
  /**
   * #317: the crosshair's hovered timestamp. The onset/recovery markers
   * are hidden by default (just the hatch band shows) and fade in only
   * near the cursor, so the chart stays clean but the clickable glyphs
   * surface when you reach for them. Null = not hovering -> markers
   * hidden (except the focused span).
   */
  hoverTickAt?: number | null;
  /** #316: clicking an onset/recovery marker -> pinned pop-up at (x, y). */
  onSpanClick?: (span: AlertConditionInterval['span'], clientX: number, clientY: number) => void;
}) {
  // px radius over which a marker fades in around the cursor.
  const REVEAL_PX = 90;
  const hoverX = hoverTickAt != null ? xScale(hoverTickAt) : null;
  const proximity = (mx: number): number =>
    hoverX == null ? 0 : Math.max(0, 1 - Math.abs(mx - hoverX) / REVEAL_PX);
  const relevant = intervals.filter((iv) =>
    conditionSpanClass(iv.span.event_class)?.charts.includes(target),
  );
  if (relevant.length === 0) return null;

  // One <pattern> per distinct class present in the viewport.
  const classes = Array.from(
    new Map(
      relevant
        .map((iv) => conditionSpanClass(iv.span.event_class))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => [c.openClass, c]),
    ).values(),
  );

  // y for the top-edge marker glyphs (just inside the plot top).
  const markerY = top + 5;

  return (
    <>
      <defs>
        {classes.map((c) => {
          const color = getChartColor(c.colorSlot as ChartColorKey, colorOverrides);
          return (
            <pattern
              key={c.openClass}
              id={`alertBand_${c.openClass}_${idSuffix}`}
              patternUnits="userSpaceOnUse"
              width="10"
              height="10"
              patternTransform="rotate(45)"
            >
              <rect width="10" height="10" fill={darkenHex(color, 0.45)} fillOpacity="0.22" />
              <line x1="0" y1="0" x2="0" y2="10" stroke={color} strokeWidth="1.5" strokeOpacity="0.5" />
            </pattern>
          );
        })}
      </defs>
      {relevant.map((iv, i) => {
        const cls = conditionSpanClass(iv.span.event_class);
        if (!cls) return null;
        const x0 = xScale(Math.max(dataMinX, iv.x0));
        const x1 = xScale(Math.min(dataMaxX, iv.x1));
        if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 < x0) return null;
        const color = getChartColor(cls.colorSlot as ChartColorKey, colorOverrides);
        const clampedSpan = Math.min(dataMaxX, iv.x1) - Math.max(dataMinX, iv.x0);
        const ongoing = !Number.isFinite(iv.x1);
        const label = conditionLabel(iv.span.event_class);
        // Recovery marker only when the condition closed inside the view.
        const recoveredInView =
          iv.span.end_ms !== null &&
          iv.span.end_ms >= dataMinX &&
          iv.span.end_ms <= dataMaxX;
        const recX = recoveredInView ? xScale(iv.span.end_ms as number) : null;
        const onsetInView = iv.x0 >= dataMinX && iv.x0 <= dataMaxX;
        const click = onSpanClick
          ? (e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
              e.stopPropagation();
              onSpanClick(iv.span, e.clientX, e.clientY);
            }
          : undefined;
        const clickable = onSpanClick ? { cursor: 'pointer' as const } : undefined;
        // Markers are hidden by default and fade in near the cursor; the
        // focused (jumped-to) span's markers always show.
        const focused = focusSpanOpenId !== null && iv.span.open_id === focusSpanOpenId;
        const onsetOp = focused ? 1 : proximity(x0);
        const recOp = focused ? 1 : recX !== null ? proximity(recX) : 0;
        const hitEvents = (op: number) => (op > 0.35 ? 'auto' : 'none');
        return (
          <g key={`alert-band-${iv.span.open_id}-${i}`}>
            {x1 > x0 && (
              <rect
                x={x0}
                y={top}
                width={x1 - x0}
                height={height}
                fill={`url(#alertBand_${cls.openClass}_${idSuffix})`}
                onClick={click}
                style={clickable}
              >
                <title>
                  {`${label}: ${iv.span.title} (${formatDuration(clampedSpan)}${ongoing ? ', ongoing' : ''})`}
                </title>
              </rect>
            )}
            {/* Onset line + DOWN triangle (entered the condition).
                Fades in near the cursor (see proximity). */}
            {onsetInView && (
              <>
                <g opacity={onsetOp} style={{ transition: 'opacity 120ms' }} pointerEvents="none">
                  <line
                    x1={x0}
                    y1={top}
                    x2={x0}
                    y2={top + height}
                    stroke={color}
                    strokeWidth="1.2"
                    strokeOpacity="0.7"
                    strokeDasharray="3 2"
                  />
                  <path
                    d={`M${x0 - 5},${markerY - 5} L${x0 + 5},${markerY - 5} L${x0},${markerY + 4} Z`}
                    fill={color}
                  />
                </g>
                {/* Generous transparent hit target; only clickable when shown. */}
                <rect
                  x={x0 - 8}
                  y={markerY - 8}
                  width={16}
                  height={18}
                  fill="transparent"
                  onClick={click}
                  style={clickable}
                  pointerEvents={hitEvents(onsetOp)}
                >
                  <title>{`${label} started · ${iv.span.title}`}</title>
                </rect>
              </>
            )}
            {/* Recovery: dashed end line + hollow UP triangle (back to normal). */}
            {recX !== null && (
              <>
                <g opacity={recOp} style={{ transition: 'opacity 120ms' }} pointerEvents="none">
                  <line
                    x1={recX}
                    y1={top}
                    x2={recX}
                    y2={top + height}
                    stroke={color}
                    strokeWidth="1"
                    strokeOpacity="0.4"
                    strokeDasharray="2 3"
                  />
                  <path
                    d={`M${recX - 5},${markerY + 4} L${recX + 5},${markerY + 4} L${recX},${markerY - 5} Z`}
                    fill="none"
                    stroke={color}
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </g>
                <rect
                  x={recX - 8}
                  y={markerY - 8}
                  width={16}
                  height={18}
                  fill="transparent"
                  onClick={click}
                  style={clickable}
                  pointerEvents={hitEvents(recOp)}
                >
                  <title>{`${conditionRecoveryLabel(iv.span.event_class)} (${formatDuration(clampedSpan)})`}</title>
                </rect>
              </>
            )}
            {/* Focus beacon when jumped to from a History alert row. */}
            {focusSpanOpenId !== null && iv.span.open_id === focusSpanOpenId && (
              <g pointerEvents="none">
                <style>{`
                  @keyframes alertFocusPing_${idSuffix} {
                    0%   { transform: scale(1);   opacity: 0.95; }
                    100% { transform: scale(6.8); opacity: 0;    }
                  }
                  .alert-focus-ping-${idSuffix} {
                    animation: alertFocusPing_${idSuffix} 2.4s ease-out infinite;
                    transform-box: fill-box;
                    transform-origin: center;
                    vector-effect: non-scaling-stroke;
                    fill: none;
                    stroke-width: 2;
                  }
                `}</style>
                <circle cx={x0} cy={markerY} r={5} className={`alert-focus-ping-${idSuffix}`} stroke={color} />
                <circle cx={x0} cy={markerY} r={5} className={`alert-focus-ping-${idSuffix}`} stroke={color} style={{ animationDelay: '-0.8s' }} />
                <circle cx={x0} cy={markerY} r={5} className={`alert-focus-ping-${idSuffix}`} stroke={color} style={{ animationDelay: '-1.6s' }} />
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}
