import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  CHART_RANGE_SPECS,
  type ChartRange,
} from '@braiins-hashrate/shared';

import { api, type SimulateResponse } from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';

const EH_PER_PH = 1000;

const RANGES: ChartRange[] = ['6h', '12h', '24h', '1w', '1m', '1y', 'all'];

interface ParamSlider {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  ehToPh?: boolean;
}

const SLIDERS: ParamSlider[] = [
  { key: 'overpay_sat_per_eh_day', label: 'Overpay', min: 0, max: 2_000_000, step: 50_000, unit: 'sat/PH/day', ehToPh: true },
  { key: 'max_bid_sat_per_eh_day', label: 'Max bid', min: 10_000_000, max: 100_000_000, step: 1_000_000, unit: 'sat/PH/day', ehToPh: true },
  { key: 'fill_escalation_step_sat_per_eh_day', label: 'Escalation step', min: 50_000, max: 2_000_000, step: 50_000, unit: 'sat/PH/day', ehToPh: true },
  { key: 'fill_escalation_after_minutes', label: 'Escalation window', min: 1, max: 60, step: 1, unit: 'min' },
  { key: 'lower_patience_minutes', label: 'Wait before lowering', min: 0, max: 60, step: 1, unit: 'min' },
  { key: 'min_lower_delta_sat_per_eh_day', label: 'Min lower delta', min: 0, max: 2_000_000, step: 50_000, unit: 'sat/PH/day', ehToPh: true },
];

type ParamState = Record<string, number>;

export function Simulate() {
  const [range, setRange] = useState<ChartRange>('24h');

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 60_000,
  });

  const config = configQuery.data?.config;

  const [params, setParams] = useState<ParamState | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (config && !params) {
      setParams({
        overpay_sat_per_eh_day: config.overpay_sat_per_eh_day,
        max_bid_sat_per_eh_day: config.max_bid_sat_per_eh_day,
        fill_escalation_step_sat_per_eh_day: config.fill_escalation_step_sat_per_eh_day,
        fill_escalation_after_minutes: config.fill_escalation_after_minutes,
        lower_patience_minutes: config.lower_patience_minutes,
        min_lower_delta_sat_per_eh_day: config.min_lower_delta_sat_per_eh_day,
      });
    }
  }, [config, params]);

  const [debouncedParams, setDebouncedParams] = useState<ParamState | null>(null);
  useEffect(() => {
    if (!params) return;
    const t = setTimeout(() => setDebouncedParams(params), 400);
    return () => clearTimeout(t);
  }, [params]);

  const simQuery = useQuery({
    queryKey: ['simulate', range, debouncedParams],
    queryFn: () => api.simulate({
      range,
      overpay_sat_per_eh_day: debouncedParams!.overpay_sat_per_eh_day!,
      max_bid_sat_per_eh_day: debouncedParams!.max_bid_sat_per_eh_day!,
      fill_escalation_step_sat_per_eh_day: debouncedParams!.fill_escalation_step_sat_per_eh_day!,
      fill_escalation_after_minutes: debouncedParams!.fill_escalation_after_minutes!,
      lower_patience_minutes: debouncedParams!.lower_patience_minutes!,
      min_lower_delta_sat_per_eh_day: debouncedParams!.min_lower_delta_sat_per_eh_day!,
    }),
    enabled: !!debouncedParams,
    staleTime: 30_000,
  });

  const setParam = useCallback((key: string, value: number) => {
    setParams((prev) => prev ? { ...prev, [key]: value } : prev);
    setDirty(true);
  }, []);

  const resetToConfig = useCallback(() => {
    if (!config) return;
    setParams({
      overpay_sat_per_eh_day: config.overpay_sat_per_eh_day,
      max_bid_sat_per_eh_day: config.max_bid_sat_per_eh_day,
      fill_escalation_step_sat_per_eh_day: config.fill_escalation_step_sat_per_eh_day,
      fill_escalation_after_minutes: config.fill_escalation_after_minutes,
      lower_patience_minutes: config.lower_patience_minutes,
      min_lower_delta_sat_per_eh_day: config.min_lower_delta_sat_per_eh_day,
    });
    setDirty(false);
  }, [config]);

  if (!config || !params) {
    return (
      <div className="p-6 text-slate-400">Loading configuration...</div>
    );
  }

  return (
    <div className="space-y-4 p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-lg font-semibold text-slate-100">What-if simulator</h2>
        <div className="flex items-center gap-2">
          <RangePicker range={range} onChange={setRange} />
          {dirty && (
            <button
              onClick={resetToConfig}
              className="text-xs px-3 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700"
            >
              Reset to current config
            </button>
          )}
        </div>
      </div>

      <p className="text-sm text-slate-400">
        Replay historical market data with different parameters. Shows what uptime and cost would have been.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          {SLIDERS.map((s) => (
            <Slider
              key={s.key}
              slider={s}
              value={params[s.key]!}
              defaultValue={configValue(config, s.key)}
              onChange={(v) => setParam(s.key, v)}
            />
          ))}
        </div>

        <div className="space-y-3">
          <ComparisonCard
            result={simQuery.data ?? null}
            loading={simQuery.isFetching}
          />
        </div>
      </div>
    </div>
  );
}

function configValue(config: object, key: string): number {
  return (config as unknown as Record<string, number>)[key] ?? 0;
}

function Slider({
  slider,
  value,
  defaultValue,
  onChange,
}: {
  slider: ParamSlider;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  const displayValue = slider.ehToPh ? Math.round(value / EH_PER_PH) : value;
  const displayDefault = slider.ehToPh ? Math.round(defaultValue / EH_PER_PH) : defaultValue;
  const changed = value !== defaultValue;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs uppercase tracking-wider text-slate-400">{slider.label}</label>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-mono tabular-nums ${changed ? 'text-amber-300' : 'text-slate-100'}`}>
            {formatNumber(displayValue)} {slider.unit}
          </span>
          {changed && (
            <span className="text-[10px] text-slate-500">
              (was {formatNumber(displayDefault)})
            </span>
          )}
        </div>
      </div>
      <input
        type="range"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-amber-400 h-1.5 cursor-pointer"
      />
    </div>
  );
}

function ComparisonCard({
  result,
  loading,
}: {
  result: SimulateResponse | null;
  loading: boolean;
}) {
  const { intlLocale } = useLocale();

  if (!result) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-center text-slate-500 text-sm">
        {loading ? 'Simulating...' : 'Adjust parameters to simulate.'}
      </div>
    );
  }

  const { actual, simulated, tick_count } = result;

  if (tick_count < 2) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-center text-slate-500 text-sm">
        Not enough data in this range.
      </div>
    );
  }

  const uptimeDelta = simulated.uptime_pct !== null && actual.uptime_pct !== null
    ? simulated.uptime_pct - actual.uptime_pct
    : null;
  const costDelta = simulated.avg_cost_sat_per_eh_day !== null && actual.avg_cost_sat_per_eh_day !== null
    ? (simulated.avg_cost_sat_per_eh_day - actual.avg_cost_sat_per_eh_day) / EH_PER_PH
    : null;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 space-y-4">
      <div className="text-xs uppercase tracking-wider text-slate-400 flex items-center justify-between">
        <span>Results</span>
        {loading && <span className="text-amber-400 animate-pulse">updating...</span>}
      </div>

      <MetricRow
        label="Uptime"
        actual={actual.uptime_pct !== null ? `${actual.uptime_pct.toFixed(1)}%` : '\u2014'}
        simulated={simulated.uptime_pct !== null ? `${simulated.uptime_pct.toFixed(1)}%` : '\u2014'}
        delta={uptimeDelta !== null ? `${uptimeDelta >= 0 ? '+' : ''}${uptimeDelta.toFixed(1)}pp` : null}
        deltaPositive={uptimeDelta !== null ? uptimeDelta >= 0 : null}
      />
      <MetricRow
        label="Avg cost"
        actual={actual.avg_cost_sat_per_eh_day !== null
          ? `${formatNumber(Math.round(actual.avg_cost_sat_per_eh_day / EH_PER_PH), {}, intlLocale)}`
          : '\u2014'}
        simulated={simulated.avg_cost_sat_per_eh_day !== null
          ? `${formatNumber(Math.round(simulated.avg_cost_sat_per_eh_day / EH_PER_PH), {}, intlLocale)}`
          : '\u2014'}
        delta={costDelta !== null ? `${costDelta >= 0 ? '+' : ''}${formatNumber(Math.round(costDelta), {}, intlLocale)}` : null}
        deltaPositive={costDelta !== null ? costDelta <= 0 : null}
        unit="sat/PH/day"
      />
      <MetricRow
        label="Gaps"
        actual={`${actual.gap_count} (${actual.gap_minutes} min)`}
        simulated={`${simulated.gap_count} (${simulated.gap_minutes} min)`}
        delta={simulated.gap_count !== actual.gap_count
          ? `${simulated.gap_count - actual.gap_count >= 0 ? '+' : ''}${simulated.gap_count - actual.gap_count}`
          : null}
        deltaPositive={simulated.gap_count <= actual.gap_count}
      />

      <div className="border-t border-slate-800 pt-3 text-xs text-slate-500 text-center">
        {tick_count.toLocaleString()} ticks analyzed
      </div>
    </div>
  );
}

function MetricRow({
  label,
  actual,
  simulated,
  delta,
  deltaPositive,
  unit,
}: {
  label: string;
  actual: string;
  simulated: string;
  delta: string | null;
  deltaPositive: boolean | null;
  unit?: string;
}) {
  return (
    <div>
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className="grid grid-cols-2 gap-2 text-sm font-mono tabular-nums">
        <div>
          <span className="text-[10px] text-slate-500 block mb-0.5">actual</span>
          <span className="text-slate-300">{actual}</span>
          {unit && <span className="text-slate-600 text-xs ml-1">{unit}</span>}
        </div>
        <div>
          <span className="text-[10px] text-slate-500 block mb-0.5">simulated</span>
          <span className="text-slate-100">{simulated}</span>
          {unit && <span className="text-slate-600 text-xs ml-1">{unit}</span>}
          {delta && (
            <span className={`text-xs ml-1.5 ${deltaPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {delta}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function RangePicker({ range, onChange }: { range: ChartRange; onChange: (r: ChartRange) => void }) {
  return (
    <div className="flex gap-1">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`text-xs px-2 py-1 rounded ${
            r === range
              ? 'bg-emerald-700 text-emerald-100'
              : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
          }`}
        >
          {r === 'all' ? 'All' : r}
        </button>
      ))}
    </div>
  );
}
