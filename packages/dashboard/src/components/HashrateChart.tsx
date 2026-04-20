/**
 * Hashrate-only chart: Braiins-delivered hashrate as a filled area,
 * Datum-measured hashrate as a second line when the Datum integration
 * is active, and target + floor as dashed reference lines. The two
 * series let the operator eyeball the gap between what Braiins bills
 * for and what Datum actually sees arrive at the gateway. Pairs with
 * `PriceChart` rendered immediately below it so price moves can be
 * matched against fill events visually — both charts share the same
 * time-range filter and X-axis layout.
 */

import { memo, useMemo } from 'react';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  formatTimeTick,
  localAlignedTimeTicks,
  niceYTicks,
  pickTimeTickInterval,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { MetricPoint, OurBlockMarker } from '../lib/api';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';

const WIDTH = 880;
const HEIGHT = 200;
// Padding kept identical to PriceChart so the two charts can be stacked
// and the X-axis lines up tick-for-tick. Right padding is small now that
// the price-side Y-axis moved to the left — just enough to keep the
// rightmost timestamp from clipping the edge.
const PADDING = { top: 16, right: 16, bottom: 24, left: 80 };

const COLOR_DELIVERED = '#34d399';
const COLOR_DATUM = '#38bdf8';
const COLOR_TARGET = '#94a3b8';
const COLOR_FLOOR = '#64748b';
// Gold — distinct from every other chart colour, reads as "jackpot"
// against the dark background. Used for the rare "we found a block"
// markers Ocean credits to the operator's wallet.
const COLOR_OUR_BLOCK = '#fbbf24';

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export const HashrateChart = memo(function HashrateChart({
  points,
  range,
  onRangeChange,
  simMode = false,
  ourBlocks = [],
}: {
  points: readonly MetricPoint[];
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
  simMode?: boolean;
  /** Blocks Ocean credited to the operator's wallet, rendered as
   *  vertical gold markers when their timestamps fall inside the
   *  chart range. Sparse — typically zero; rare celebratory event. */
  ourBlocks?: readonly OurBlockMarker[];
}) {
  const { intlLocale } = useLocale();

  const chartData = useMemo(() => {
    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    const ys = points.map((p) => p.delivered_ph);
    const targets = points.map((p) => p.target_ph);
    const floors = points.map((p) => p.floor_ph);
    const datumYs = points.map((p) => p.datum_hashrate_ph);
    const datumMax = datumYs.reduce<number>(
      (acc, v) => (v !== null && v > acc ? v : acc),
      0,
    );
    const hasDatum = datumYs.some((v) => v !== null);

    const minX = xs[0]!;
    const maxX = xs[xs.length - 1]!;

    const yMaxData = Math.max(...ys, ...targets, ...floors, datumMax);

    const yTicks = niceYTicks(0, yMaxData > 0 ? yMaxData * 1.1 : 1, 5);
    const yMin = yTicks[0] ?? 0;
    const yMax = yTicks[yTicks.length - 1] ?? 1;

    const xScale = (x: number): number => {
      const usable = WIDTH - PADDING.left - PADDING.right;
      if (maxX === minX) return PADDING.left + usable / 2;
      return PADDING.left + ((x - minX) / (maxX - minX)) * usable;
    };
    const yScale = (y: number): number => {
      const usable = HEIGHT - PADDING.top - PADDING.bottom;
      return HEIGHT - PADDING.bottom - ((y - yMin) / (yMax - yMin)) * usable;
    };

    const hashratePath = (values: readonly number[]): string =>
      values
        .map((v, i) => {
          const cmd = i === 0 ? 'M' : 'L';
          return `${cmd}${xScale(xs[i]!).toFixed(1)},${yScale(v).toFixed(1)}`;
        })
        .join(' ');

    // Datum path: break into segments on null. Without this, SVG would
    // render a straight line across gaps (pre-migration data, poll
    // failures) and make those gaps look like real data.
    const datumPath = (() => {
      const segments: string[] = [];
      let current = '';
      for (let i = 0; i < datumYs.length; i += 1) {
        const v = datumYs[i];
        if (v === null || v === undefined) {
          if (current) {
            segments.push(current);
            current = '';
          }
          continue;
        }
        const x = xScale(xs[i]!).toFixed(1);
        const y = yScale(v).toFixed(1);
        current += `${current ? 'L' : 'M'}${x},${y} `;
      }
      if (current) segments.push(current);
      return segments.join(' ');
    })();

    const deliveredPath = hashratePath(ys);
    const targetPath = hashratePath(targets);
    const floorPath = hashratePath(floors);

    // X-axis: round local-time ticks (08:00, 09:00, ...) instead of the
    // arbitrary first/last timestamps. Same ticks shared with PriceChart.
    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    return {
      xs,
      minX,
      maxX,
      yMax,
      yMin,
      xScale,
      yScale,
      deliveredPath,
      datumPath,
      hasDatum,
      targetPath,
      floorPath,
      yTicks,
      xTickInterval,
      xTicks,
    };
  }, [points]);

  if (!chartData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-xs uppercase tracking-wider text-slate-100">
            Hashrate
          </h3>
        </div>
        <div className="mt-4 text-sm text-slate-500">
          Not enough data in this range yet.
        </div>
      </div>
    );
  }

  const { minX, maxX, xScale, yScale, deliveredPath, datumPath, hasDatum, targetPath, floorPath, yTicks, xTickInterval, xTicks } = chartData;

  return (
    <div className={`bg-slate-900 border rounded-lg p-4 ${simMode ? 'border-amber-800/40' : 'border-slate-800'}`}>
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">
          {simMode ? 'Simulated hashrate' : 'Hashrate'}
        </h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <Legend color={simMode ? '#fbbf24' : COLOR_DELIVERED} label={simMode ? 'simulated' : 'delivered (Braiins)'} />
          {!simMode && hasDatum && (
            <Legend color={COLOR_DATUM} label="received (Datum)" />
          )}
          <Legend color={COLOR_TARGET} label="target" dashed />
          <Legend color={COLOR_FLOOR} label="floor" dashed />
          {!simMode &&
            ourBlocks.some((b) => b.timestamp_ms >= chartData.minX && b.timestamp_ms <= chartData.maxX) && (
              <Legend color={COLOR_OUR_BLOCK} label="block found" dashed />
            )}
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
              {formatNumber(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, intlLocale)}
            </text>
          </g>
        ))}

        <path d={targetPath} stroke={COLOR_TARGET} strokeWidth="1.2" strokeDasharray="4 3" fill="none" opacity="0.6" />
        <path d={floorPath} stroke={COLOR_FLOOR} strokeWidth="1" strokeDasharray="2 3" fill="none" opacity="0.5" />

        <path
          d={`${deliveredPath} L${xScale(maxX).toFixed(1)},${yScale(0)} L${xScale(minX).toFixed(1)},${yScale(0)} Z`}
          fill={simMode ? 'url(#simFill)' : 'url(#deliveredFill)'}
          opacity="0.5"
        />
        <path d={deliveredPath} stroke={simMode ? '#fbbf24' : COLOR_DELIVERED} strokeWidth="1.8" fill="none" />
        {!simMode && hasDatum && (
          <path
            d={datumPath}
            stroke={COLOR_DATUM}
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {!simMode &&
          ourBlocks
            .filter((b) => b.timestamp_ms >= minX && b.timestamp_ms <= maxX)
            .map((b) => {
              const x = xScale(b.timestamp_ms);
              return (
                <g key={b.block_hash || b.height}>
                  <title>
                    {`Block #${b.height.toLocaleString()} — found ${new Date(b.timestamp_ms).toLocaleString()}\nreward ${b.total_reward_sat.toLocaleString()} sat\nworker ${b.worker || '—'}\nhash ${b.block_hash.slice(0, 16)}…`}
                  </title>
                  <line
                    x1={x}
                    x2={x}
                    y1={PADDING.top + 8}
                    y2={HEIGHT - PADDING.bottom}
                    stroke={COLOR_OUR_BLOCK}
                    strokeWidth="1.5"
                    strokeDasharray="4 2"
                    opacity="0.9"
                  />
                  {/* Small isometric cube, matching Ocean's block icon.
                      Three rhombus faces — top, front, right — stroked
                      in the block-marker colour. Centered on the line. */}
                  <g
                    transform={`translate(${x - 5}, ${PADDING.top - 9})`}
                    fill="none"
                    stroke={COLOR_OUR_BLOCK}
                    strokeWidth="1.1"
                    strokeLinejoin="round"
                  >
                    <path d="M5 0 L10 2.5 L5 5 L0 2.5 Z" fill={COLOR_OUR_BLOCK} fillOpacity="0.25" />
                    <path d="M0 2.5 L0 7.5 L5 10 L5 5 Z" fill={COLOR_OUR_BLOCK} fillOpacity="0.15" />
                    <path d="M5 5 L5 10 L10 7.5 L10 2.5 Z" fill={COLOR_OUR_BLOCK} fillOpacity="0.35" />
                  </g>
                </g>
              );
            })}

        <defs>
          <linearGradient id="deliveredFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_DELIVERED} stopOpacity="0.45" />
            <stop offset="100%" stopColor={COLOR_DELIVERED} stopOpacity="0" />
          </linearGradient>
          <linearGradient id="simFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </linearGradient>
        </defs>

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

        <text
          x={14}
          y={PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2}
          textAnchor="middle"
          fontSize="10"
          fill="#64748b"
          fontFamily="monospace"
          transform={`rotate(-90 14 ${PADDING.top + (HEIGHT - PADDING.top - PADDING.bottom) / 2})`}
        >
          PH/s
        </text>
      </svg>
    </div>
  );
});

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

function RangePicker({
  current,
  onChange,
}: {
  current: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
  return (
    <div className="flex gap-0.5 bg-slate-950/70 border border-slate-800 rounded-md p-0.5 pl-2 items-center">
      <span className="text-[10px] uppercase tracking-wider text-slate-500 pr-1">range</span>
      {CHART_RANGES.map((r) => {
        const active = r === current;
        return (
          <button
            key={r}
            onClick={() => onChange(r)}
            className={
              'px-2 py-1 text-[11px] rounded transition font-mono ' +
              (active
                ? 'bg-amber-400 text-slate-900 font-medium'
                : 'text-slate-300 hover:bg-slate-800')
            }
          >
            {CHART_RANGE_SPECS[r].label}
          </button>
        );
      })}
    </div>
  );
}
