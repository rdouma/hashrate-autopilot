// #250: shared SVG marker layer for public-IP change events, drawn on
// both the hashrate and price charts. Each event is a vertical dashed
// tick plus a Lucide `router` glyph above the plot. Hover/click opens
// the styled IpChangeTooltip (matching the pool-block and retarget
// tooltip patterns). Always rendered (IP changes are rare and
// high-signal); not gated by the right-axis selector.
//
// Must be used INSIDE an <svg>. The caller passes its own x-scale, the
// plot's top / bottom y, and a pair of (enter / leave / click)
// handlers - the tooltip lives outside the SVG so the chart owns the
// hovered-state machinery.

import { useLayoutEffect, useRef, useState } from 'react';

import { t } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';

import { useFormatters } from '../lib/locale';

export interface IpChangeMarkerEvent {
  readonly id: number;
  readonly occurred_at: number;
  readonly old_ip: string | null;
  readonly new_ip: string;
}

export interface IpChangeTooltipState {
  event: IpChangeMarkerEvent;
  /** Viewport x (page-relative), used to position the floating panel. */
  x: number;
  y: number;
  pinned: boolean;
}

const DEFAULT_COLOR = '#38bdf8'; // sky-400: distinct from retarget purple / block gold

export function IpChangeMarkers({
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
  events: ReadonlyArray<IpChangeMarkerEvent>;
  xScale: (ms: number) => number;
  dataMinX: number;
  dataMaxX: number;
  /** y of the plot top (icon sits just above this). */
  topY: number;
  /** y of the plot bottom (tick line ends here). */
  bottomY: number;
  /** Operator-configurable marker color (Config → Chart colors →
   *  marker.ip_change). Defaults to the sky-400 hex when no override. */
  color?: string;
  /** Hover handler: chart owns the hovered-state; tooltip renders
   *  outside the SVG. Receives the event + viewport coords. */
  onMarkerEnter?: (
    event: IpChangeMarkerEvent,
    e: React.MouseEvent<SVGGElement>,
  ) => void;
  onMarkerLeave?: () => void;
  onMarkerClick?: (
    event: IpChangeMarkerEvent,
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
              key={`ipc-${e.id}`}
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
                  pool-block markers' click-anchor pattern). */}
              <rect x={x - 9} y={topY - 13} width={18} height={18} fill="transparent" />
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
                <rect width="20" height="8" x="2" y="14" rx="2" />
                <path d="M6.01 18H6" />
                <path d="M10.01 18H10" />
                <path d="M15 10v4" />
                <path d="M17.84 7.17a4 4 0 0 0-5.66 0" />
                <path d="M20.66 4.34a8 8 0 0 0-11.31 0" />
              </svg>
            </g>
          );
        })}
    </>
  );
}

/**
 * Floating tooltip rendered when an operator hovers / clicks an
 * IP-change marker. Same visual pattern as PoolBlockTooltip and
 * RetargetTooltip - bg-slate-950 panel with sky-toned uppercase
 * header. Uses the formatter from `useFormatters()` so the date and
 * time follow the operator's configured locale + dateLayout (no more
 * hard-coded `6/4/2026, 3:22:17 AM` from the default `toLocaleString`).
 */
export function IpChangeTooltip({
  tip,
  onClose,
  pinnedDomId,
}: {
  tip: IpChangeTooltipState;
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
        <span className="font-semibold uppercase tracking-wider text-sky-300">
          <Trans>IP changed</Trans>
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
        {event.old_ip ?? '—'}
        <span className="text-slate-500 mx-1.5">→</span>
        {event.new_ip}
      </div>
      <div className="text-slate-500 text-[11px] mt-1">
        {fmt.timestamp(event.occurred_at)}
      </div>
    </div>
  );
}
