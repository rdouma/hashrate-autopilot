/**
 * Price chart: our primary bid (amber solid) vs the depth-aware fillable
 * ask (orange dashed). Bid events are rendered as markers anchored to the
 * primary-price line. Sized and padded to match `HashrateChart` so the
 * X-axis aligns visually when stacked.
 */

import { useLayoutEffect, useRef, useState } from 'react';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  pickTimeTickInterval,
} from '@braiins-hashrate/shared';

import type { BidEventView, MetricPoint } from '../lib/api';
import { formatNumber, formatTimestamp, formatTimestampUtc } from '../lib/format';
import { useLocale } from '../lib/locale';

const WIDTH = 880;
const HEIGHT = 200;
// Match HashrateChart's padding exactly so the two charts stack with a
// pixel-perfect X-axis alignment. Y labels are on the left; right
// padding only needs to keep the last X-axis timestamp from clipping.
const PADDING = { top: 16, right: 16, bottom: 24, left: 64 };

const COLOR_PRICE = '#fbbf24';
const COLOR_FILLABLE = '#f97316';
const COLOR_CREATE = '#34d399';
const COLOR_EDIT = '#fbbf24';
const COLOR_EDIT_SPEED = '#60a5fa';
const COLOR_CANCEL = '#f87171';

interface HoveredTooltip {
  event: BidEventView;
  x: number;
  y: number;
}

interface PricePoint {
  t: number;
  v: number;
}

export function PriceChart({
  points,
  events = [],
  showEvents,
}: {
  points: readonly MetricPoint[];
  events?: readonly BidEventView[];
  showEvents: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<HoveredTooltip | null>(null);
  const { intlLocale } = useLocale();

  // Older daemon builds may omit `fillable_ask_sat_per_ph_day` entirely
  // (i.e. the field is `undefined`, not `null`). Use Number.isFinite so we
  // don't generate bogus path coords when the column hasn't been
  // backfilled yet.
  const pricePoints: PricePoint[] = points
    .filter((p) => Number.isFinite(p.our_primary_price_sat_per_ph_day))
    .map((p) => ({ t: p.tick_at, v: p.our_primary_price_sat_per_ph_day as number }));

  const fillablePoints: PricePoint[] = points
    .filter((p) => Number.isFinite(p.fillable_ask_sat_per_ph_day))
    .map((p) => ({ t: p.tick_at, v: p.fillable_ask_sat_per_ph_day as number }));

  if (points.length < 2) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">Price</h3>
        <div className="mt-4 text-sm text-slate-500">
          Not enough data in this range yet.
        </div>
      </div>
    );
  }

  const xs = points.map((p) => p.tick_at);
  const minX = xs[0]!;
  const maxX = xs[xs.length - 1]!;

  const eventPrices = events
    .flatMap((e) => [e.old_price_sat_per_ph_day, e.new_price_sat_per_ph_day])
    .filter((p): p is number => p !== null && Number.isFinite(p));
  const priceSample = [
    ...pricePoints.map((p) => p.v),
    ...fillablePoints.map((p) => p.v),
    ...eventPrices,
  ];
  const hasPrice = priceSample.length > 0;
  const priceMinRaw = hasPrice ? Math.min(...priceSample) : 0;
  const priceMaxRaw = hasPrice ? Math.max(...priceSample) : 1;
  const priceSpan = Math.max(1, priceMaxRaw - priceMinRaw);
  const priceMin = Math.max(0, priceMinRaw - priceSpan * 0.1);
  const priceMax = priceMaxRaw + priceSpan * 0.15;

  const xScale = (x: number): number => {
    const usable = WIDTH - PADDING.left - PADDING.right;
    if (maxX === minX) return PADDING.left + usable / 2;
    return PADDING.left + ((x - minX) / (maxX - minX)) * usable;
  };
  const yScale = (v: number): number => {
    const usable = HEIGHT - PADDING.top - PADDING.bottom;
    if (priceMax === priceMin) return HEIGHT - PADDING.bottom - usable / 2;
    return HEIGHT - PADDING.bottom - ((v - priceMin) / (priceMax - priceMin)) * usable;
  };

  const pricePath = pricePoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
    .join(' ');
  const fillablePath = fillablePoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
    .join(' ');

  const ticks = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= ticks; i++) {
    yTicks.push(priceMin + ((priceMax - priceMin) / ticks) * i);
  }

  // Same X-axis ticks as the HashrateChart above so events on this
  // chart line up vertically with hashrate dips/spikes on that one.
  const xTickInterval = pickTimeTickInterval(maxX - minX);
  const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

  const visibleEvents = showEvents
    ? events.filter((e) => e.occurred_at >= minX && e.occurred_at <= maxX)
    : [];

  const eventPriceAt = (e: BidEventView): number | null => {
    if (e.new_price_sat_per_ph_day !== null) return e.new_price_sat_per_ph_day;
    if (e.old_price_sat_per_ph_day !== null) return e.old_price_sat_per_ph_day;
    if (pricePoints.length === 0) return null;
    let before: PricePoint | null = null;
    let after: PricePoint | null = null;
    for (const p of pricePoints) {
      if (p.t <= e.occurred_at) before = p;
      if (p.t >= e.occurred_at && after === null) after = p;
    }
    if (before && after && before.t !== after.t) {
      const ratio = (e.occurred_at - before.t) / (after.t - before.t);
      return before.v + (after.v - before.v) * ratio;
    }
    return before?.v ?? after?.v ?? null;
  };

  // Tooltip lives in a portal-style fixed-position node so it's free of
  // the chart container's overflow/clip and can flip near the viewport
  // edges. Coords stored are viewport-absolute (e.clientX/Y).
  const onMarkerEnter = (event: BidEventView) => (e: React.MouseEvent) => {
    setHovered({ event, x: e.clientX, y: e.clientY });
  };
  const onMarkerLeave = () => setHovered(null);

  const priceFmt = (v: number): string => formatNumber(Math.round(v), {}, intlLocale);

  return (
    <div ref={containerRef} className="bg-slate-900 border border-slate-800 rounded-lg p-4 relative">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">Price</h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <Legend color={COLOR_PRICE} label="our bid" />
          <Legend color={COLOR_FILLABLE} label="fillable" dashed />
          {showEvents && <EventLegend />}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
      >
        {yTicks.map((v, i) => (
          <g key={`y-${i}`}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={yScale(v)}
              y2={yScale(v)}
              stroke="#1e293b"
              strokeWidth="1"
            />
            <text
              x={PADDING.left - 6}
              y={yScale(v) + 4}
              textAnchor="end"
              fontSize="10"
              fill="#64748b"
              fontFamily="monospace"
            >
              {priceFmt(v)}
            </text>
          </g>
        ))}

        {fillablePath && (
          <path
            d={fillablePath}
            stroke={COLOR_FILLABLE}
            strokeWidth="1.4"
            strokeDasharray="4 3"
            fill="none"
            opacity="0.85"
          />
        )}
        {pricePath && pricePoints.length >= 2 && (
          <>
            {/* Soft gradient fill below the price line — mirrors the
                delivered-hashrate fill on the chart above. Anchors at the
                first/last actual price points (not chart edges) so gaps
                where the bid was inactive don't get a fake fill. */}
            <path
              d={`${pricePath} L${xScale(pricePoints[pricePoints.length - 1]!.t).toFixed(1)},${(HEIGHT - PADDING.bottom).toFixed(1)} L${xScale(pricePoints[0]!.t).toFixed(1)},${(HEIGHT - PADDING.bottom).toFixed(1)} Z`}
              fill="url(#priceFill)"
              opacity="0.5"
            />
          </>
        )}
        {pricePath && (
          <path d={pricePath} stroke={COLOR_PRICE} strokeWidth="1.8" fill="none" opacity="0.95" />
        )}

        <defs>
          <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_PRICE} stopOpacity="0.4" />
            <stop offset="100%" stopColor={COLOR_PRICE} stopOpacity="0" />
          </linearGradient>
        </defs>

        {visibleEvents.map((e) => {
          const cx = xScale(e.occurred_at);
          const priceAtEvent = eventPriceAt(e);
          const cy = priceAtEvent !== null ? yScale(priceAtEvent) : PADDING.top - 2;
          const common = {
            onMouseEnter: onMarkerEnter(e),
            onMouseLeave: onMarkerLeave,
            style: { cursor: 'pointer' },
          };
          if (e.kind === 'CREATE_BID') {
            return (
              <g key={e.id} {...common}>
                <line x1={cx - 5} x2={cx + 5} y1={cy} y2={cy} stroke={COLOR_CREATE} strokeWidth="2.2" />
                <line x1={cx} x2={cx} y1={cy - 5} y2={cy + 5} stroke={COLOR_CREATE} strokeWidth="2.2" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'EDIT_PRICE') {
            return (
              <g key={e.id} {...common}>
                <circle cx={cx} cy={cy} r="4.5" fill={COLOR_EDIT} stroke="#0f172a" strokeWidth="1.5" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'EDIT_SPEED') {
            // Speed-edit marker: a hollow blue diamond (rotated square) at
            // chart-top — speed changes have no inherent price coordinate
            // so anchoring to the price line would be misleading.
            const yTop = PADDING.top + 4;
            const r = 4.5;
            return (
              <g key={e.id} {...common}>
                <polygon
                  points={`${cx},${yTop - r} ${cx + r},${yTop} ${cx},${yTop + r} ${cx - r},${yTop}`}
                  fill="none"
                  stroke={COLOR_EDIT_SPEED}
                  strokeWidth="1.6"
                />
                <rect x={cx - 8} y={yTop - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          if (e.kind === 'CANCEL_BID') {
            return (
              <g key={e.id} {...common}>
                <line x1={cx - 5} x2={cx + 5} y1={cy - 5} y2={cy + 5} stroke={COLOR_CANCEL} strokeWidth="2.2" />
                <line x1={cx - 5} x2={cx + 5} y1={cy + 5} y2={cy - 5} stroke={COLOR_CANCEL} strokeWidth="2.2" />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
              </g>
            );
          }
          return null;
        })}

        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={HEIGHT - PADDING.bottom}
          y2={HEIGHT - PADDING.bottom}
          stroke="#334155"
          strokeWidth="1"
        />

        {xTicks.map((t) => {
          const x = xScale(t);
          return (
            <g key={`x-${t}`}>
              <line
                x1={x}
                x2={x}
                y1={HEIGHT - PADDING.bottom}
                y2={HEIGHT - PADDING.bottom + 3}
                stroke="#475569"
                strokeWidth="1"
              />
              <text
                x={x}
                y={HEIGHT - 8}
                textAnchor="middle"
                fontSize="10"
                fill="#64748b"
                fontFamily="monospace"
              >
                {formatTimeTick(t, xTickInterval, intlLocale)}
              </text>
            </g>
          );
        })}

        {hasPrice && (
          <text
            x={14}
            y={PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2}
            textAnchor="middle"
            fontSize="10"
            fill="#64748b"
            fontFamily="monospace"
            transform={`rotate(-90 14 ${PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2})`}
          >
            sat/PH/day
          </text>
        )}
      </svg>

      {hovered && <EventTooltip tip={hovered} />}
    </div>
  );
}

function EventTooltip({ tip }: { tip: HoveredTooltip }) {
  const ref = useRef<HTMLDivElement>(null);
  // Initial render at the cursor's natural offset (right + below).
  // useLayoutEffect then measures and flips horizontally / vertically
  // if the tooltip would clip the viewport. Hidden until ready so the
  // user never sees the wrong-position frame.
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: tip.x + 12,
    top: tip.y + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    const safeEdge = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = tip.x + margin;
    if (left + rect.width > vw - safeEdge) {
      // Flip to the left side of the cursor.
      left = tip.x - rect.width - margin;
    }
    if (left < safeEdge) left = safeEdge;

    let top = tip.y + margin;
    if (top + rect.height > vh - safeEdge) {
      // Flip above the cursor.
      top = tip.y - rect.height - margin;
    }
    if (top < safeEdge) top = safeEdge;

    setPos({ left, top, ready: true });
  }, [tip.x, tip.y, tip.event.id]);

  const e = tip.event;
  const sourceLabel = e.source === 'OPERATOR' ? 'manual' : 'automatic';
  const kindLabel =
    e.kind === 'CREATE_BID'
      ? 'CREATE'
      : e.kind === 'EDIT_PRICE'
        ? 'EDIT PRICE'
        : e.kind === 'EDIT_SPEED'
          ? 'EDIT SPEED'
          : 'CANCEL';
  const headerColor =
    e.kind === 'CREATE_BID'
      ? 'text-emerald-300'
      : e.kind === 'EDIT_PRICE'
        ? 'text-amber-300'
        : e.kind === 'EDIT_SPEED'
          ? 'text-sky-300'
          : 'text-red-300';

  return (
    <div
      ref={ref}
      // `fixed` so positioning is purely viewport-relative — no chart
      // container clip / scroll math. `whitespace-nowrap` on the body
      // means data lines (price/delta/budget/id) never wrap; the reason
      // line opts back into wrapping below.
      className={`fixed z-50 bg-slate-950 border border-slate-700 rounded-lg shadow-lg p-3 text-xs pointer-events-none whitespace-nowrap ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className={`font-semibold uppercase tracking-wider ${headerColor}`}>
        {kindLabel} · {sourceLabel}
      </div>
      <div className="text-slate-300 mt-1">{formatTimestamp(e.occurred_at)}</div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(e.occurred_at)}</div>

      {e.kind === 'CREATE_BID' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row label="price" value={`${formatNumber(Math.round(e.new_price_sat_per_ph_day ?? 0))} sat/PH/day`} />
          <Row label="speed" value={`${e.speed_limit_ph ?? '—'} PH/s`} />
          <Row label="budget" value={`${formatNumber(e.amount_sat ?? 0)} sat`} />
        </div>
      )}

      {e.kind === 'EDIT_PRICE' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row
            label="price"
            value={`${formatNumber(Math.round(e.old_price_sat_per_ph_day ?? 0))} → ${formatNumber(Math.round(e.new_price_sat_per_ph_day ?? 0))} sat/PH/day`}
          />
          {e.old_price_sat_per_ph_day !== null && e.new_price_sat_per_ph_day !== null && (
            <Row
              label="delta"
              value={`${e.new_price_sat_per_ph_day >= e.old_price_sat_per_ph_day ? '+' : ''}${formatNumber(
                Math.round(e.new_price_sat_per_ph_day - e.old_price_sat_per_ph_day),
              )} sat/PH/day`}
            />
          )}
        </div>
      )}

      {e.kind === 'EDIT_SPEED' && (
        <div className="mt-2 space-y-0.5 text-slate-300">
          <Row label="new speed" value={`${e.speed_limit_ph ?? '—'} PH/s`} />
        </div>
      )}

      {e.braiins_order_id && (
        <div className="mt-2 text-[10px] font-mono text-slate-500">
          id {e.braiins_order_id}
        </div>
      )}
      {e.reason && (
        // Reason is the only freeform string; allow it to wrap so a
        // long sentence doesn't blow the tooltip off-screen, but cap
        // the width so it stays readable.
        <div className="mt-2 text-[11px] text-slate-400 italic whitespace-normal max-w-[20rem]">
          {e.reason}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1 text-slate-400">
      <svg width="14" height="6">
        <line
          x1="0"
          y1="3"
          x2="14"
          y2="3"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '3 2' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

function EventLegend() {
  return (
    <span className="flex items-center gap-2 text-slate-400 pl-2 border-l border-slate-700">
      <span className="flex items-center gap-1">
        <svg width="10" height="10">
          <line x1="1" y1="5" x2="9" y2="5" stroke={COLOR_CREATE} strokeWidth="2" />
          <line x1="5" y1="1" x2="5" y2="9" stroke={COLOR_CREATE} strokeWidth="2" />
        </svg>
        create
      </span>
      <span className="flex items-center gap-1">
        <svg width="10" height="10">
          <circle cx="5" cy="5" r="3.5" fill={COLOR_EDIT} />
        </svg>
        edit
      </span>
      <span className="flex items-center gap-1">
        <svg width="10" height="10">
          <line x1="1" y1="1" x2="9" y2="9" stroke={COLOR_CANCEL} strokeWidth="2" />
          <line x1="9" y1="1" x2="1" y2="9" stroke={COLOR_CANCEL} strokeWidth="2" />
        </svg>
        cancel
      </span>
    </span>
  );
}
