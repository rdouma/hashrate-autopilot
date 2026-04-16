/**
 * Minimal dependency-free SVG line chart for delivered hashrate.
 *
 * Draws the `delivered_ph` series over time with reference lines for the
 * target and floor. Hand-rolled SVG keeps the bundle lean — no chart
 * library, no extra 100 KB. Dark-theme coloured to match the rest of
 * the dashboard.
 */

import type { MetricPoint } from '../lib/api';
import { formatTimestamp } from '../lib/format';

const WIDTH = 880;
const HEIGHT = 220;
const PADDING = { top: 12, right: 16, bottom: 24, left: 44 };

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function HashrateChart({ points }: { points: readonly MetricPoint[] }) {
  if (points.length < 2) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-sm text-slate-500">
        Not enough data yet — chart appears after a couple of ticks.
      </div>
    );
  }

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

  const path = (values: readonly number[]): string =>
    values
      .map((v, i) => {
        const cmd = i === 0 ? 'M' : 'L';
        return `${cmd}${xScale(xs[i]!).toFixed(1)},${yScale(v).toFixed(1)}`;
      })
      .join(' ');

  const deliveredPath = path(ys);
  const targetPath = path(targets);
  const floorPath = path(floors);

  // Y-axis grid + labels.
  const ticks = 4;
  const yTicks: number[] = [];
  for (let i = 0; i <= ticks; i++) {
    yTicks.push(yMin + ((yMax - yMin) / ticks) * i);
  }

  // X-axis: start + end labels only.
  const firstTs = formatTimestamp(minX);
  const lastTs = formatTimestamp(maxX);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-slate-400">
          Delivered hashrate (last {formatDuration(maxX - minX)})
        </h3>
        <div className="flex gap-3 text-xs">
          <Legend color="#34d399" label="delivered" />
          <Legend color="#fbbf24" label="target" dashed />
          <Legend color="#94a3b8" label="floor" dashed />
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-auto"
      >
        {/* Grid lines + y labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
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
              {v.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Target & floor reference lines (dashed) */}
        <path d={targetPath} stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="4 3" fill="none" opacity="0.7" />
        <path d={floorPath} stroke="#94a3b8" strokeWidth="1.2" strokeDasharray="2 3" fill="none" opacity="0.5" />

        {/* Delivered series (solid, with soft fill below) */}
        <path
          d={`${deliveredPath} L${xScale(maxX).toFixed(1)},${yScale(0)} L${xScale(minX).toFixed(1)},${yScale(0)} Z`}
          fill="url(#deliveredFill)"
          opacity="0.5"
        />
        <path d={deliveredPath} stroke="#34d399" strokeWidth="1.8" fill="none" />

        <defs>
          <linearGradient id="deliveredFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* X axis baseline */}
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={HEIGHT - PADDING.bottom}
          y2={HEIGHT - PADDING.bottom}
          stroke="#334155"
          strokeWidth="1"
        />

        {/* X labels */}
        <text
          x={PADDING.left}
          y={HEIGHT - 6}
          fontSize="10"
          fill="#64748b"
          fontFamily="monospace"
        >
          {firstTs}
        </text>
        <text
          x={WIDTH - PADDING.right}
          y={HEIGHT - 6}
          textAnchor="end"
          fontSize="10"
          fill="#64748b"
          fontFamily="monospace"
        >
          {lastTs}
        </text>

        {/* Y-axis unit label — rotated along the axis to avoid overlapping tick numbers */}
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
