/**
 * Price chart: our primary bid (amber solid) vs the depth-aware fillable
 * ask (orange dashed). Bid events are rendered as markers anchored to the
 * primary-price line. Sized and padded to match `HashrateChart` so the
 * X-axis aligns visually when stacked.
 */

import { useQuery } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
} from '@braiins-hashrate/shared';

import { api, type BidEventView, type DecisionDetail, type DecisionSummary, type MetricPoint } from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { formatNumber, formatTimestamp, formatTimestampHuman, formatTimestampUtc } from '../lib/format';
import { useLocale } from '../lib/locale';

const WIDTH = 880;
const HEIGHT = 200;
// Match HashrateChart's padding exactly so the two charts stack with a
// pixel-perfect X-axis alignment. Y labels are on the left; right
// padding only needs to keep the last X-axis timestamp from clipping.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };

const COLOR_PRICE = '#fbbf24';
const COLOR_FILLABLE = '#f97316';
const COLOR_CREATE = '#34d399';
const COLOR_EDIT = '#fbbf24';
const COLOR_EDIT_SPEED = '#60a5fa';
const COLOR_CANCEL = '#f87171';

interface TooltipState {
  event: BidEventView;
  x: number;
  y: number;
  pinned: boolean;
}

interface PricePoint {
  t: number;
  v: number;
}

const COLOR_HASHPRICE = '#a78bfa'; // violet-400
const COLOR_MAXBID = '#f87171'; // red-400

export const PriceChart = memo(function PriceChart({
  points,
  events = [],
  showEvents,
  simMode = false,
  maxOverpayVsHashpriceSatPerPhDay = null,
  maxBidSatPerPhDay = null,
  overpaySatPerPhDay = null,
}: {
  points: readonly MetricPoint[];
  events?: readonly BidEventView[];
  showEvents: boolean;
  simMode?: boolean;
  /**
   * Current config's dynamic-cap allowance. When set, the cap line is
   * computed per-tick as `min(max_bid, hashprice + this)` rather than
   * the flat `max_bid` — matches what decide() actually uses each
   * tick. Null → fall back to max_bid. Applied as a constant across
   * the history (we don't store historical config per tick), so past
   * effective caps are approximate if the operator changed this
   * value.
   */
  maxOverpayVsHashpriceSatPerPhDay?: number | null;
  /**
   * Override for the fixed `max_bid` component of the effective-cap
   * line. In real-time mode (null) the chart uses the historical
   * `max_bid_sat_per_ph_day` column from `tick_metrics` — what the
   * autopilot was actually configured to use at each tick. In
   * simulation mode, pass the simulated `max_bid` so the cap line
   * (and the shaded "excluded zone" above it) reflects the parameter
   * under test, not the historical config. The effective cap is
   * still `min(this, hashprice + maxOverpayVsHashprice)` when the
   * dynamic cap is set; this just replaces the fixed-cap input.
   */
  maxBidSatPerPhDay?: number | null;
  /**
   * The overpay allowance active when the event ran — live config
   * value in real-time mode, simulation param in sim mode. Shown on
   * the pinned-event tooltip so the operator can sanity-check
   * fillable + overpay against the resulting bid without digging
   * through raw JSON.
   */
  overpaySatPerPhDay?: number | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  const chartData = useMemo(() => {
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

    const hashpricePoints: PricePoint[] = points
      .filter((p) => Number.isFinite(p.hashprice_sat_per_ph_day))
      .map((p) => ({ t: p.tick_at, v: p.hashprice_sat_per_ph_day as number }));

    // The line the operator actually cares about: the effective cap
    // that decide() uses each tick, which is the tighter of the fixed
    // max_bid and the dynamic hashprice+max_overpay. When the dynamic
    // cap isn't configured, this collapses to max_bid and the line
    // looks exactly like the previous "max bid" line.
    const capPoints: PricePoint[] = points
      .filter((p) =>
        maxBidSatPerPhDay !== null
          ? true
          : Number.isFinite(p.max_bid_sat_per_ph_day),
      )
      .map((p) => {
        const fixed =
          maxBidSatPerPhDay !== null
            ? maxBidSatPerPhDay
            : (p.max_bid_sat_per_ph_day as number);
        const hashprice = Number.isFinite(p.hashprice_sat_per_ph_day)
          ? (p.hashprice_sat_per_ph_day as number)
          : null;
        const dynamic =
          maxOverpayVsHashpriceSatPerPhDay !== null && hashprice !== null
            ? hashprice + maxOverpayVsHashpriceSatPerPhDay
            : null;
        const v = dynamic !== null ? Math.min(fixed, dynamic) : fixed;
        return { t: p.tick_at, v };
      });

    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    const minX = xs[0]!;
    const maxX = xs[xs.length - 1]!;

    const eventPrices = events
      .flatMap((e) => [e.old_price_sat_per_ph_day, e.new_price_sat_per_ph_day])
      .filter((p): p is number => p !== null && Number.isFinite(p));
    const priceSample = [
      ...pricePoints.map((p) => p.v),
      ...fillablePoints.map((p) => p.v),
      ...hashpricePoints.map((p) => p.v),
      ...capPoints.map((p) => p.v),
      ...eventPrices,
    ];
    const hasPrice = priceSample.length > 0;
    const priceMinRaw = hasPrice ? Math.min(...priceSample) : 0;
    const priceMaxRaw = hasPrice ? Math.max(...priceSample) : 1;
    const priceSpan = Math.max(1, priceMaxRaw - priceMinRaw);

    const yTicks = niceYTicks(
      Math.max(0, priceMinRaw - priceSpan * 0.1),
      priceMaxRaw + priceSpan * 0.15,
      5,
    );
    const priceMin = yTicks[0] ?? 0;
    const priceMax = yTicks[yTicks.length - 1] ?? 1;

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

    const hashpricePath = hashpricePoints
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
      .join(' ');

    const capPath = capPoints
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
      .join(' ');

    // Polygon tracing the "excluded" region above the cap — the chart
    // top edge along the top, then the cap curve in reverse along the
    // bottom. Filled with a red-to-transparent linear gradient so the
    // operator sees at a glance that anything above the line is off-
    // limits. Only rendered when we actually have cap points; empty
    // when the column was backfilled as null for pre-migration ticks.
    const capExclusionPolygon =
      capPoints.length > 0
        ? (() => {
            const top = PADDING.top;
            const leftEdgeX = xScale(capPoints[0]!.t).toFixed(1);
            const rightEdgeX = xScale(capPoints[capPoints.length - 1]!.t).toFixed(1);
            const capTrace = capPoints
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`)
              .join(' ');
            // Start at the first cap point (already M), go up to the
            // chart top, across to the right edge, and close back down
            // to the last cap point — that seals the polygon above
            // the cap curve.
            const close = ` L${rightEdgeX},${top} L${leftEdgeX},${top} Z`;
            return capTrace + close;
          })()
        : null;

    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    const visibleEvents = showEvents
      ? events.filter((e) => e.occurred_at >= minX && e.occurred_at <= maxX)
      : [];

    return { pricePoints, fillablePoints, minX, maxX, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, fillablePath, hashpricePath, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents };
  }, [points, events, showEvents]);

  const eventPriceAt = useCallback((e: BidEventView): number | null => {
    const pricePoints = chartData?.pricePoints ?? [];
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
  }, [chartData?.pricePoints]);

  // Tooltip lives in a portal-style fixed-position node so it's free of
  // the chart container's overflow/clip and can flip near the viewport
  // edges. Coords stored are viewport-absolute (e.clientX/Y).
  //
  // Hover opens a transient tooltip; clicking a marker pins it — pinned
  // tooltips stay until the × is clicked, another marker is clicked, or
  // the user clicks outside. Pinned also exposes a "copy JSON" button.
  const onMarkerEnter = useCallback((event: BidEventView) => (e: React.MouseEvent) => {
    setTooltip((prev) => {
      if (prev?.pinned) return prev;
      return { event, x: e.clientX, y: e.clientY, pinned: false };
    });
  }, []);
  const onMarkerLeave = useCallback(() => {
    setTooltip((prev) => (prev?.pinned ? prev : null));
  }, []);
  const onMarkerClick = useCallback((event: BidEventView) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setTooltip({ event, x: e.clientX, y: e.clientY, pinned: true });
  }, []);
  const closeTooltip = useCallback(() => setTooltip(null), []);

  useEffect(() => {
    if (!tooltip?.pinned) return;
    const onDocClick = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (target && document.getElementById('price-chart-pinned-tooltip')?.contains(target)) {
        return;
      }
      setTooltip(null);
    };
    // Defer so the click that opened the pin doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener('click', onDocClick), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onDocClick);
    };
  }, [tooltip?.pinned]);

  if (!chartData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">Price</h3>
        <div className="mt-4 text-sm text-slate-500">
          Not enough data in this range yet.
        </div>
      </div>
    );
  }

  const { pricePoints, fillablePoints, hasPrice, priceMin, priceMax, xScale, yScale, pricePath, fillablePath, hashpricePath, capPath, capExclusionPolygon, yTicks, xTickInterval, xTicks, visibleEvents } = chartData;

  // Format Y-axis tick values: in USD mode convert sat/PH/day to $/PH/day
  const priceFmt = (v: number): string => {
    if (denomination.mode === 'usd' && denomination.btcPrice !== null) {
      const usd = (v / 100_000_000) * denomination.btcPrice;
      return new Intl.NumberFormat(intlLocale, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: usd >= 1 ? 2 : 4,
        maximumFractionDigits: usd >= 1 ? 2 : 4,
      }).format(usd);
    }
    return formatNumber(Math.round(v), {}, intlLocale);
  };

  return (
    <div ref={containerRef} className={`bg-slate-900 border rounded-lg p-4 relative ${simMode ? 'border-amber-800/40' : 'border-slate-800'}`}>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">{simMode ? 'Simulated price' : 'Price'}</h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <Legend color={simMode ? '#fbbf24' : COLOR_PRICE} label={simMode ? 'simulated bid' : 'our bid'} />
          <Legend color={COLOR_FILLABLE} label="fillable" dashed />
          <Legend color={COLOR_HASHPRICE} label="hashprice" dashed />
          <Legend color={COLOR_MAXBID} label="max bid" dashed />
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

        {/* Hashprice break-even line — now a time series, not a static
            horizontal line. Moves with difficulty adjustments + block
            reward fluctuations. Below = profitable, above = unprofitable. */}
        {hashpricePath && (
          <path
            d={hashpricePath}
            stroke={COLOR_HASHPRICE}
            strokeWidth="1.2"
            strokeDasharray="6 4"
            fill="none"
            opacity="0.7"
          />
        )}
        {/* Effective cap — the tighter of fixed max_bid and the
            dynamic hashprice+max_overpay cap. Anything above this
            line is the "off-limits" region, shaded with a red
            gradient that fades down to transparent at the cap curve
            so the operator reads it as "walled off" without obscuring
            detail near the cap. */}
        {capExclusionPolygon && (
          <>
            <defs>
              <linearGradient id="capExclusion" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLOR_MAXBID} stopOpacity="0.28" />
                <stop offset="100%" stopColor={COLOR_MAXBID} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={capExclusionPolygon} fill="url(#capExclusion)" stroke="none" />
          </>
        )}
        {capPath && (
          <path
            d={capPath}
            stroke={COLOR_MAXBID}
            strokeWidth="1.4"
            fill="none"
            opacity="0.85"
          />
        )}
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
          <path d={pricePath} stroke={simMode ? '#fbbf24' : COLOR_PRICE} strokeWidth="1.8" fill="none" opacity="0.95" />
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
            onClick: onMarkerClick(e),
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
            // Speed-edit marker: hollow blue diamond on the price line at
            // the event time. Earlier I parked it at chart-top reasoning
            // that a speed change has no inherent price coordinate — but
            // operator pointed out (correctly) that anchoring it to the
            // price line is what makes it readable: you see *at what
            // price* the capacity got resized, lined up with the rest of
            // the events.
            const r = 4.5;
            return (
              <g key={e.id} {...common}>
                <polygon
                  points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
                  fill="none"
                  stroke={COLOR_EDIT_SPEED}
                  strokeWidth="1.6"
                />
                <rect x={cx - 8} y={cy - 8} width="16" height="16" fill="transparent" />
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
            {denomination.mode === 'usd' ? '$/PH/day' : 'sat/PH/day'}
          </text>
        )}
      </svg>

      {tooltip && (
        <EventTooltip
          tip={tooltip}
          onClose={closeTooltip}
          simMode={simMode}
          points={points}
          overpaySatPerPhDay={overpaySatPerPhDay}
          maxOverpayVsHashpriceSatPerPhDay={maxOverpayVsHashpriceSatPerPhDay}
        />
      )}
    </div>
  );
});

// Walk a plain-data object and, for any numeric field whose name ends
// in `_at`, inject a sibling `<field>_hr` with a locale-aware human
// string including the timezone. Non-destructive — returns a new
// object. Used to enrich the copy-JSON payload so raw unix-ms fields
// are readable without mental math.
function withHumanTimestamps<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => withHumanTimestamps(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = withHumanTimestamps(v);
    if (/_at$/.test(k) && typeof v === 'number' && Number.isFinite(v) && v > 1_000_000_000_000) {
      out[`${k}_hr`] = formatTimestampHuman(v);
    }
  }
  return out as T;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function EventTooltip({
  tip,
  onClose,
  simMode = false,
  points = [],
  overpaySatPerPhDay = null,
  maxOverpayVsHashpriceSatPerPhDay = null,
}: {
  tip: TooltipState;
  onClose: () => void;
  simMode?: boolean;
  points?: readonly MetricPoint[];
  overpaySatPerPhDay?: number | null;
  maxOverpayVsHashpriceSatPerPhDay?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // Find the tick_metrics row for the event's timestamp so the
  // tooltip can surface fillable / hashprice / max_bid at that
  // moment in sat/PH/day — the numbers the operator needs to
  // sanity-check "did the escalation make sense" without digging
  // into the JSON payload.
  const marketAtEvent = useMemo(() => {
    if (!tip.pinned) return null;
    const target = tip.event.occurred_at;
    let best: MetricPoint | null = null;
    let bestDiff = Infinity;
    for (const p of points) {
      const diff = Math.abs(p.tick_at - target);
      // Within ±2 min of the event is close enough — tick_metrics
      // is stored per tick (60s cadence), so the nearest row is
      // always the right one.
      if (diff > 2 * 60_000) continue;
      if (diff < bestDiff) {
        best = p;
        bestDiff = diff;
      }
    }
    return best;
  }, [tip.pinned, tip.event.occurred_at, points]);

  const effectiveCapAtEvent = useMemo(() => {
    if (!marketAtEvent || marketAtEvent.max_bid_sat_per_ph_day === null) return null;
    const fixed = marketAtEvent.max_bid_sat_per_ph_day;
    const hashprice = marketAtEvent.hashprice_sat_per_ph_day;
    const dyn =
      maxOverpayVsHashpriceSatPerPhDay !== null && hashprice !== null
        ? hashprice + maxOverpayVsHashpriceSatPerPhDay
        : null;
    return dyn !== null ? Math.min(fixed, dyn) : fixed;
  }, [marketAtEvent, maxOverpayVsHashpriceSatPerPhDay]);

  // Prefetch recent decisions + the specific matched detail so the copy
  // payload reflects the rich context the operator saw in the old
  // Decisions tab. Only runs once pinned — hover-only tooltips don't
  // need the extra round-trips. Skipped in simulation mode where
  // events are synthesised and have no backing decision record.
  const decisionsList = useQuery({
    queryKey: ['decisions-for-chart'],
    queryFn: () => api.decisions(500),
    enabled: tip.pinned && !simMode,
    staleTime: 60_000,
  });

  const matchedDecisionId = useMemo<number | null>(() => {
    if (!tip.pinned || !decisionsList.data) return null;
    // Autopilot bid events are emitted from the same tick that produced
    // the decision record, so `tick_at` should be the closest <= event
    // timestamp. Cap the match window so operator bumps don't silently
    // latch onto an unrelated earlier tick.
    const target = tip.event.occurred_at;
    const WINDOW_MS = 5 * 60 * 1000;
    let best: DecisionSummary | null = null;
    let bestDiff = Infinity;
    for (const d of decisionsList.data) {
      const diff = target - d.tick_at;
      if (diff < -30_000 || diff > WINDOW_MS) continue;
      if (Math.abs(diff) < bestDiff) {
        best = d;
        bestDiff = Math.abs(diff);
      }
    }
    return best?.id ?? null;
  }, [tip.pinned, tip.event.occurred_at, decisionsList.data]);

  const decisionDetailQuery = useQuery({
    queryKey: ['decision-detail', matchedDecisionId],
    queryFn: () => api.decision(matchedDecisionId!),
    enabled: matchedDecisionId !== null && !simMode,
    staleTime: 5 * 60_000,
  });
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
  const sourceLabel = simMode
    ? 'simulated'
    : e.source === 'OPERATOR'
      ? 'manual'
      : 'automatic';
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

  const copyJson = async () => {
    const detail: DecisionDetail | null = decisionDetailQuery.data ?? null;
    const payload = {
      // Top-level flag so the JSON is unambiguously a simulation
      // artefact vs a real historical decision — the nested
      // decision.run_mode is an actual historical value and can
      // legitimately read LIVE even on a synthesised event.
      simulated: simMode,
      event: withHumanTimestamps(e),
      market_at_event: marketAtEvent
        ? {
            tick_at: marketAtEvent.tick_at,
            fillable_ask_sat_per_ph_day: marketAtEvent.fillable_ask_sat_per_ph_day,
            hashprice_sat_per_ph_day: marketAtEvent.hashprice_sat_per_ph_day,
            max_bid_sat_per_ph_day: marketAtEvent.max_bid_sat_per_ph_day,
            effective_cap_sat_per_ph_day: effectiveCapAtEvent,
            overpay_allowance_sat_per_ph_day: overpaySatPerPhDay,
            max_overpay_vs_hashprice_sat_per_ph_day: maxOverpayVsHashpriceSatPerPhDay,
            our_primary_price_sat_per_ph_day: marketAtEvent.our_primary_price_sat_per_ph_day,
          }
        : null,
      // Decision is null for operator-initiated events (bumps) that
      // weren't produced by an autopilot tick, when the match window
      // missed, or when we're in simulation mode (events are
      // synthesised, no backing decision exists).
      decision: detail && !simMode ? withHumanTimestamps(detail) : null,
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers / insecure contexts — fall back to a selection.
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  const detailLoading =
    tip.pinned && matchedDecisionId !== null && decisionDetailQuery.isLoading;

  return (
    <div
      ref={ref}
      id={tip.pinned ? 'price-chart-pinned-tooltip' : undefined}
      // `fixed` so positioning is purely viewport-relative — no chart
      // container clip / scroll math. `whitespace-nowrap` on the body
      // means data lines (price/delta/budget/id) never wrap; the reason
      // line opts back into wrapping below.
      //
      // When pinned the tooltip is interactive (close/copy buttons), so
      // pointer-events are enabled only then. Hover tooltips stay
      // pointer-events-none to avoid blocking the marker underneath.
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${tip.pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className={`font-semibold uppercase tracking-wider ${headerColor}`}>
            {kindLabel} · {sourceLabel}
          </span>
          {simMode && (
            <span className="px-1.5 py-0.5 rounded border border-amber-700 bg-amber-900/40 text-amber-300 text-[10px] uppercase tracking-wider">
              sim
            </span>
          )}
        </div>
        {tip.pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
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

      {tip.pinned && marketAtEvent && (
        <div className="mt-2 pt-2 border-t border-slate-800 space-y-0.5 text-slate-300">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">
            market at this tick
          </div>
          {marketAtEvent.fillable_ask_sat_per_ph_day !== null && (
            <Row
              label="fillable"
              value={`${formatNumber(Math.round(marketAtEvent.fillable_ask_sat_per_ph_day))} sat/PH/day`}
            />
          )}
          {overpaySatPerPhDay !== null && (
            <Row
              label="overpay allowance"
              value={`${formatNumber(Math.round(overpaySatPerPhDay))} sat/PH/day`}
            />
          )}
          {marketAtEvent.fillable_ask_sat_per_ph_day !== null && overpaySatPerPhDay !== null && (
            <Row
              label="fillable + overpay"
              value={`${formatNumber(Math.round(marketAtEvent.fillable_ask_sat_per_ph_day + overpaySatPerPhDay))} sat/PH/day`}
            />
          )}
          {marketAtEvent.hashprice_sat_per_ph_day !== null ? (
            <Row
              label="hashprice"
              value={`${formatNumber(Math.round(marketAtEvent.hashprice_sat_per_ph_day))} sat/PH/day`}
            />
          ) : (
            <Row label="hashprice" value="— (not recorded this tick)" />
          )}
          {maxOverpayVsHashpriceSatPerPhDay !== null && (
            <Row
              label="max overpay vs hashprice"
              value={`${formatNumber(Math.round(maxOverpayVsHashpriceSatPerPhDay))} sat/PH/day`}
            />
          )}
          {maxOverpayVsHashpriceSatPerPhDay !== null &&
            marketAtEvent.hashprice_sat_per_ph_day !== null && (
              <Row
                label="hashprice + max overpay"
                value={`${formatNumber(
                  Math.round(
                    marketAtEvent.hashprice_sat_per_ph_day + maxOverpayVsHashpriceSatPerPhDay,
                  ),
                )} sat/PH/day`}
              />
            )}
          {marketAtEvent.max_bid_sat_per_ph_day !== null && (
            <Row
              label="max bid"
              value={`${formatNumber(Math.round(marketAtEvent.max_bid_sat_per_ph_day))} sat/PH/day`}
            />
          )}
          {effectiveCapAtEvent !== null && (
            <Row
              label="effective cap"
              value={`${formatNumber(Math.round(effectiveCapAtEvent))} sat/PH/day`}
            />
          )}
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
      {tip.pinned && (
        <div className="mt-3 pt-2 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="text-[10px] text-slate-500">
            {detailLoading ? 'loading decision…' : 'click outside to close'}
          </span>
          <button
            type="button"
            onClick={copyJson}
            aria-label={copied ? 'copied JSON' : 'copy JSON'}
            title={copied ? 'copied JSON' : 'copy JSON'}
            className={`px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 inline-flex items-center gap-1.5 text-[11px] ${copied ? 'text-emerald-300' : 'text-slate-200'}`}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span>JSON</span>
          </button>
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
        edit price
      </span>
      <span className="flex items-center gap-1">
        <svg width="10" height="10">
          <polygon
            points="5,1 9,5 5,9 1,5"
            fill="none"
            stroke={COLOR_EDIT_SPEED}
            strokeWidth="1.4"
          />
        </svg>
        edit speed
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
