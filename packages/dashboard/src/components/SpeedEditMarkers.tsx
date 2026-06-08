// #281: speed-edit marker layer for the hashrate chart. An EDIT_SPEED
// bid event changes the PH/s cap on the bid, which directly moves the
// delivered-hashrate curve - so the operator wants those events
// annotated on the hashrate chart, not only on the price chart where
// they already appear. Each event is a Lucide `gauge` glyph above the
// plot plus a full-height dashed line (matching the hashrate chart's
// existing retarget / IP-change marker idiom, where one vertical line
// reads cleanly against three source series rather than anchoring to a
// single curve). Hover/click opens SpeedEditTooltip.
//
// Must be used INSIDE an <svg>. The caller passes its own x-scale, the
// plot's top / bottom y, and a pair of (enter / leave / click)
// handlers - the tooltip lives outside the SVG so the chart owns the
// hovered-state machinery. Same contract as IpChangeMarkers (#250).

import { useLayoutEffect, useRef, useState } from 'react';

import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';

import { formatAgeMinutes } from '../lib/format';
import { useFormatters } from '../lib/locale';

export interface SpeedEditMarkerEvent {
  readonly id: number;
  readonly occurred_at: number;
  /** New speed limit (PH/s) the bid was edited to. */
  readonly speed_limit_ph: number | null;
  /** Controller reason string, e.g. "target_hashrate change: speed
   *  3 → 4 PH/s". Carries the old→new in human-readable form. */
  readonly reason: string | null;
}

export interface SpeedEditTooltipState {
  event: SpeedEditMarkerEvent;
  /** Viewport x (page-relative), used to position the floating panel. */
  x: number;
  y: number;
  pinned: boolean;
}

const DEFAULT_COLOR = '#60a5fa'; // blue-400: matches the price chart's edit-speed glyph

export function SpeedEditMarkers({
  events,
  xScale,
  dataMinX,
  dataMaxX,
  topY,
  bottomY,
  color = DEFAULT_COLOR,
  onMarkerEnter,
  onMarkerLeave,
  onMarkerClick,
}: {
  events: ReadonlyArray<SpeedEditMarkerEvent>;
  xScale: (ms: number) => number;
  dataMinX: number;
  dataMaxX: number;
  /** y of the plot top (icon sits just above this). */
  topY: number;
  /** y of the plot bottom (tick line ends here). */
  bottomY: number;
  /** Operator-configurable marker color (Config → Chart colors →
   *  events.edit_speed). Defaults to the blue-400 hex when no override. */
  color?: string;
  /** Hover handler: chart owns the hovered-state; tooltip renders
   *  outside the SVG. Receives the event + viewport coords. */
  onMarkerEnter?: (
    event: SpeedEditMarkerEvent,
    e: React.MouseEvent<SVGGElement>,
  ) => void;
  onMarkerLeave?: () => void;
  onMarkerClick?: (
    event: SpeedEditMarkerEvent,
    e: React.MouseEvent<SVGGElement>,
  ) => void;
}) {
  return (
    <>
      {events
        .filter((e) => e.occurred_at >= dataMinX && e.occurred_at <= dataMaxX)
        .map((e) => {
          const x = xScale(e.occurred_at);
          return (
            <g
              key={`spd-${e.id}`}
              onMouseEnter={(ev) => onMarkerEnter?.(e, ev)}
              onMouseLeave={onMarkerLeave}
              onClick={(ev) => onMarkerClick?.(e, ev)}
              style={{ cursor: onMarkerClick ? 'pointer' : 'help' }}
            >
              <line
                x1={x}
                x2={x}
                y1={topY + 8}
                y2={bottomY}
                stroke={color}
                strokeWidth="1"
                strokeDasharray="2 3"
                opacity="0.4"
                pointerEvents="none"
              />
              {/* Transparent hit area around the icon (matches the
                  IP-change / pool-block markers' click-anchor pattern). */}
              <rect x={x - 9} y={topY - 13} width={18} height={18} fill="transparent" />
              {/* Lucide `gauge` - same glyph as the price chart's
                  EDIT_SPEED marker so the two charts read identically. */}
              <svg
                x={x - 7}
                y={topY - 11}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.9"
                pointerEvents="none"
              >
                <path d="m12 14 4-4" />
                <path d="M3.34 19a10 10 0 1 1 17.32 0" />
              </svg>
            </g>
          );
        })}
    </>
  );
}

/**
 * Floating tooltip rendered when an operator hovers / clicks a
 * speed-edit marker. Same visual pattern as IpChangeTooltip /
 * PoolBlockTooltip / RetargetTooltip - bg-slate-950 panel with a
 * blue-toned uppercase header. Shows the new speed limit and the
 * controller's reason string (which carries the old→new change).
 */
export function SpeedEditTooltip({
  tip,
  onClose,
  pinnedDomId,
}: {
  tip: SpeedEditTooltipState;
  onClose: () => void;
  pinnedDomId?: string;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const { event, pinned } = tip;
  const ref = useRef<HTMLDivElement | null>(null);
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
  }, [tip.x, tip.y, event.id]);

  return (
    <div
      ref={ref}
      id={pinned ? pinnedDomId : undefined}
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="font-semibold uppercase tracking-wider text-blue-300">
          <Trans>edit speed</Trans>
        </span>
        {pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-200 mt-1 font-mono">
        <Trans>new speed</Trans>:{' '}
        {event.speed_limit_ph !== null ? `${event.speed_limit_ph} PH/s` : '—'}
      </div>
      {event.reason && (
        <div className="text-slate-400 mt-1 max-w-[260px] whitespace-normal">
          {event.reason}
        </div>
      )}
      <div className="text-slate-500 text-[11px] mt-1">
        {fmt.timestamp(event.occurred_at)}
        <span className="text-slate-600 ml-2">· {formatAgeMinutes(event.occurred_at)}</span>
      </div>
    </div>
  );
}
