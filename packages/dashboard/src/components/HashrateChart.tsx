/**
 * Hashrate-only chart: delivered (filled green area) with target + floor as
 * dashed reference lines. Pairs with `PriceChart` rendered immediately
 * below it so price moves can be matched up against fill events visually
 * — both charts share the same time-range filter and X-axis layout.
 */

import { memo, useMemo } from 'react';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  formatTimeTick,
  localAlignedTimeTicks,
  pickTimeTickInterval,
  type ChartRange,
} from '@braiins-hashrate/shared';

import type { MetricPoint } from '../lib/api';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';

const WIDTH = 880;
const HEIGHT = 200;
// Padding kept identical to PriceChart so the two charts can be stacked
// and the X-axis lines up tick-for-tick. Right padding is small now that
// the price-side Y-axis moved to the left — just enough to keep the
// rightmost timestamp from clipping the edge.
const PADDING = { top: 16, right: 16, bottom: 24, left: 64 };

const COLOR_DELIVERED = '#34d399';
const COLOR_TARGET = '#94a3b8';
const COLOR_FLOOR = '#64748b';

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
}: {
  points: readonly MetricPoint[];
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
}) {
  const { intlLocale } = useLocale();

  const chartData = useMemo(() => {
    if (points.length < 2) return null;

    const xs = points.map((p) => p.tick_at);
    const ys = points.map((p) => p.delivered_ph);
    const targets = points.map((p) => p.target_ph);
    const floors = points.map((p) => p.floor_ph);

    const minX = xs[0]!;
    const maxX = xs[xs.length - 1]!;

    const yMaxData = Math.max(...ys, ...targets, ...floors);
    const yMax = yMaxData > 0 ? yMaxData * 1.15 : 1;
    const yMin = 0;

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

    const deliveredPath = hashratePath(ys);
    const targetPath = hashratePath(targets);
    const floorPath = hashratePath(floors);

    const ticks = 4;
    const yTicks: number[] = [];
    for (let i = 0; i <= ticks; i++) {
      yTicks.push(yMin + ((yMax - yMin) / ticks) * i);
    }

    // X-axis: round local-time ticks (08:00, 09:00, ...) instead of the
    // arbitrary first/last timestamps. Same ticks shared with PriceChart.
    const xTickInterval = pickTimeTickInterval(maxX - minX);
    const xTicks = localAlignedTimeTicks(minX, maxX, xTickInterval);

    return { xs, minX, maxX, yMax, yMin, xScale, yScale, deliveredPath, targetPath, floorPath, yTicks, xTickInterval, xTicks };
  }, [points]);

  if (!chartData) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="text-xs uppercase tracking-wider text-slate-100">
            Delivered hashrate
          </h3>
          <RangePicker current={range} onChange={onRangeChange} />
        </div>
        <div className="mt-4 text-sm text-slate-500">
          Not enough data in this range yet.
        </div>
      </div>
    );
  }

  const { minX, maxX, xScale, yScale, deliveredPath, targetPath, floorPath, yTicks, xTickInterval, xTicks } = chartData;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
        <h3 className="text-xs uppercase tracking-wider text-slate-100">
          Delivered hashrate (last {formatDuration(maxX - minX)})
        </h3>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <Legend color={COLOR_DELIVERED} label="delivered" />
          <Legend color={COLOR_TARGET} label="target" dashed />
          <Legend color={COLOR_FLOOR} label="floor" dashed />
          <RangePicker current={range} onChange={onRangeChange} />
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
          fill="url(#deliveredFill)"
          opacity="0.5"
        />
        <path d={deliveredPath} stroke={COLOR_DELIVERED} strokeWidth="1.8" fill="none" />

        <defs>
          <linearGradient id="deliveredFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLOR_DELIVERED} stopOpacity="0.45" />
            <stop offset="100%" stopColor={COLOR_DELIVERED} stopOpacity="0" />
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
