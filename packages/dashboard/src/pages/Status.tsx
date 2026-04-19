import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  type ChartRange,
} from '@braiins-hashrate/shared';

import { HashrateChart } from '../components/HashrateChart';
import { PriceChart } from '../components/PriceChart';
import { ModeBadge } from '../components/ModeBadge';
import { SatSymbol } from '../components/SatSymbol';
import { Tooltip } from '../components/Tooltip';
import {
  api,
  UnauthorizedError,
  type BidEventView,
  type FinanceResponse,
  type MetricPoint,
  type NextActionView,
  type OceanResponse,
  type ProposalView,
  type SimStatsSummary,
  type SimulateResponse,
  type StatsResponse,
  type TickNowResponse,
  type StatusResponse,
} from '../lib/api';
import {
  formatAge,
  formatAgePrecise,
  formatCountdownPrecise,
  formatHashratePH,
  formatNumber,
  formatSatPerPH,
  formatSats,
  formatTimestamp,
  formatTimestampUtc,
} from '../lib/format';
import { useDenomination } from '../lib/denomination';
import { actionModeLabel, bidStatusClass, bidStatusLabel } from '../lib/labels';
import { useLocale } from '../lib/locale';

const RUN_MODES = ['DRY_RUN', 'LIVE', 'PAUSED'] as const;
const CHART_RANGE_STORAGE_KEY = 'hashrate-chart-range';

function readStoredChartRange(): ChartRange {
  if (typeof window === 'undefined') return DEFAULT_CHART_RANGE;
  return parseChartRange(window.localStorage.getItem(CHART_RANGE_STORAGE_KEY)) ?? DEFAULT_CHART_RANGE;
}

export function Status() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  const [chartRange, setChartRangeState] = useState<ChartRange>(() => readStoredChartRange());
  useEffect(() => {
    window.localStorage.setItem(CHART_RANGE_STORAGE_KEY, chartRange);
  }, [chartRange]);
  const setChartRange = (r: ChartRange) => setChartRangeState(r);

  const query = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    // Status is the headline data (price, delivered, next-action). 30s
    // is fast enough for an autopilot that ticks once per minute and
    // slow enough that the operator's tab isn't constantly thrashing.
    // Per-second timers (NextActionFooter, NextActionProgress) tick
    // client-side so they keep moving between polls.
    refetchInterval: 30_000,
  });

  const runModeMutation = useMutation({
    mutationFn: (run_mode: (typeof RUN_MODES)[number]) => api.setRunMode(run_mode),
    onMutate: async (newRunMode) => {
      await qc.cancelQueries({ queryKey: ['status'] });
      const previous = qc.getQueryData<StatusResponse>(['status']);
      if (previous) {
        qc.setQueryData<StatusResponse>(['status'], { ...previous, run_mode: newRunMode });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['status'], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const tickNowMutation = useMutation({
    mutationFn: () => api.tickNow(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const metricsQuery = useQuery({
    queryKey: ['metrics', chartRange],
    queryFn: () => api.metrics(chartRange),
    // Charts span hours-to-months — a 60s refresh is plenty.
    refetchInterval: 60_000,
  });

  const bidEventsQuery = useQuery({
    queryKey: ['bid-events', chartRange],
    queryFn: () => api.bidEvents(chartRange),
    refetchInterval: 60_000,
  });

  const statsQuery = useQuery({
    queryKey: ['stats', chartRange],
    queryFn: () => api.stats(chartRange),
    // Cached 60s server-side; poll every 60s client-side to match.
    refetchInterval: 60_000,
  });

  // Shared query instance for the Ocean panel AND the hashrate chart
  // marker overlay. React-query dedupes by queryKey so the Ocean card
  // and the chart use the same network call.
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 5 * 60_000,
  });

  const financeQuery = useQuery({
    queryKey: ['finance'],
    queryFn: api.finance,
    // Money is a slow-moving summary — earnings per day, lifetime
    // figures, ocean stats. Hourly refresh is plenty; the operator can
    // hit the refresh button on the panel for an immediate pull.
    refetchInterval: 3_600_000,
  });

  // ---- Simulation mode ----
  const [simMode, setSimMode] = useState(false);
  const [simParams, setSimParams] = useState<Record<string, number> | null>(null);
  const [simParamsDebounced, setSimParamsDebounced] = useState<Record<string, number> | null>(null);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 60_000,
    enabled: simMode,
  });

  // Seed sim params from config on first activation
  useEffect(() => {
    if (simMode && configQuery.data && !simParams) {
      const c = configQuery.data.config;
      setSimParams({
        overpay_sat_per_eh_day: c.overpay_sat_per_eh_day,
        max_bid_sat_per_eh_day: c.max_bid_sat_per_eh_day,
        // Inherits the live config — simulator now uses the same
        // dynamic cap (hashprice + allowance) as decide(). Stored as
        // 0 when disabled (null in config) so simParams stays a plain
        // Record<string, number>; 0 is coerced back to null server-
        // side via the Zod preprocess on the request body.
        max_overpay_vs_hashprice_sat_per_eh_day:
          c.max_overpay_vs_hashprice_sat_per_eh_day ?? 0,
        fill_escalation_step_sat_per_eh_day: c.fill_escalation_step_sat_per_eh_day,
        fill_escalation_after_minutes: c.fill_escalation_after_minutes,
        lower_patience_minutes: c.lower_patience_minutes,
        min_lower_delta_sat_per_eh_day: c.min_lower_delta_sat_per_eh_day,
        escalation_mode: c.escalation_mode === 'market' ? 1 : 0,
      });
    }
  }, [simMode, configQuery.data, simParams]);

  useEffect(() => {
    if (!simParams) return;
    const t = setTimeout(() => setSimParamsDebounced(simParams), 400);
    return () => clearTimeout(t);
  }, [simParams]);

  const simQuery = useQuery({
    queryKey: ['simulate', chartRange, simParamsDebounced],
    queryFn: () => api.simulate({
      range: chartRange,
      overpay_sat_per_eh_day: simParamsDebounced!.overpay_sat_per_eh_day!,
      max_bid_sat_per_eh_day: simParamsDebounced!.max_bid_sat_per_eh_day!,
      // Inherit the live config's dynamic-cap allowance so simulated
      // escalations can't cross a ceiling the real controller would
      // refuse. Not a sim tuning knob yet — just passed through.
      max_overpay_vs_hashprice_sat_per_eh_day:
        (simParamsDebounced!.max_overpay_vs_hashprice_sat_per_eh_day ?? 0) > 0
          ? simParamsDebounced!.max_overpay_vs_hashprice_sat_per_eh_day!
          : null,
      fill_escalation_step_sat_per_eh_day: simParamsDebounced!.fill_escalation_step_sat_per_eh_day!,
      fill_escalation_after_minutes: simParamsDebounced!.fill_escalation_after_minutes!,
      lower_patience_minutes: simParamsDebounced!.lower_patience_minutes!,
      min_lower_delta_sat_per_eh_day: simParamsDebounced!.min_lower_delta_sat_per_eh_day!,
      escalation_mode: simParamsDebounced!.escalation_mode ? 'market' : 'dampened',
    }),
    enabled: simMode && !!simParamsDebounced,
    staleTime: 30_000,
  });

  const setSimParam = useCallback((key: string, value: number) => {
    setSimParams((prev) => prev ? { ...prev, [key]: value } : prev);
  }, []);

  // Build simulated MetricPoints by overlaying simulated price/hashrate
  // on the real metric points.
  const simMetricPoints: MetricPoint[] | null = useMemo(() => {
    const ticks = simQuery.data?.ticks;
    const realPoints = metricsQuery.data?.points;
    if (!ticks || !realPoints || ticks.length === 0) return null;

    const simByTime = new Map(ticks.map((t) => [t.tick_at, t]));
    return realPoints.map((p) => {
      const sim = simByTime.get(p.tick_at);
      if (!sim) return p;
      return {
        ...p,
        our_primary_price_sat_per_ph_day: sim.simulated_price_sat_per_ph_day,
        delivered_ph: sim.delivered_ph,
      };
    });
  }, [simQuery.data, metricsQuery.data]);

  // Generate synthetic bid events from simulated price trace
  const simEvents: BidEventView[] = useMemo(() => {
    const ticks = simQuery.data?.ticks;
    if (!ticks || ticks.length === 0) return [];
    const events: BidEventView[] = [];
    let prevPrice: number | null = null;
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i]!;
      const price = Math.round(t.simulated_price_sat_per_ph_day);
      if (prevPrice === null && price > 0) {
        events.push({
          id: -(i + 1),
          occurred_at: t.tick_at,
          source: 'AUTOPILOT',
          kind: 'CREATE_BID',
          braiins_order_id: null,
          old_price_sat_per_ph_day: null,
          new_price_sat_per_ph_day: price,
          speed_limit_ph: null,
          amount_sat: null,
          reason: 'simulated create',
        });
      } else if (prevPrice !== null && price !== prevPrice && price > 0) {
        events.push({
          id: -(i + 1),
          occurred_at: t.tick_at,
          source: 'AUTOPILOT',
          kind: 'EDIT_PRICE',
          braiins_order_id: null,
          old_price_sat_per_ph_day: prevPrice,
          new_price_sat_per_ph_day: price,
          speed_limit_ph: null,
          amount_sat: null,
          reason: price > prevPrice ? 'simulated escalation' : 'simulated lower',
        });
      }
      if (price > 0) prevPrice = price;
    }
    return events;
  }, [simQuery.data]);

  // Convert sim stats to StatsResponse shape
  const simStatsData: StatsResponse | undefined = useMemo(() => {
    const sim = simQuery.data?.simulated;
    if (!sim) return undefined;
    return {
      uptime_pct: sim.uptime_pct,
      avg_hashrate_ph: sim.avg_hashrate_ph,
      // Simulation doesn't model Datum — the replay has no way to
      // synthesize what Datum would have reported.
      avg_datum_hashrate_ph: null,
      total_ph_hours: sim.total_ph_hours,
      avg_cost_per_ph_sat_per_ph_day: sim.avg_cost_per_ph_sat_per_ph_day,
      avg_overpay_sat_per_ph_day: sim.avg_overpay_sat_per_ph_day,
      avg_overpay_vs_hashprice_sat_per_ph_day: sim.avg_overpay_vs_hashprice_sat_per_ph_day,
      avg_time_to_fill_ms: null,
      // Simulation doesn't have a bid-events stream — there are no
      // real mutations in a replay. Zero is honest.
      mutation_count: 0,
      range: chartRange,
      tick_count: simQuery.data?.tick_count ?? 0,
    };
  }, [simQuery.data, chartRange]);

  // Operator availability removed from the UI (API bids bypass 2FA;
  // see research.md §0.9). Backend field remains in case Braiins
  // changes policy. The endpoint still exists for future use.

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (query.isLoading) return <div className="text-slate-400">loading…</div>;
  if (!query.data) {
    return <div className="text-red-400">failed to load: {(query.error as Error)?.message}</div>;
  }

  const s: StatusResponse = query.data;

  return (
    <div className="space-y-5">
      {/* No "Status" h2 header — the top nav already announces the
          page, and last-tick info is duplicated in the
          NextActionCard's footer. Saved a chunk of vertical real
          estate above the fold. */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 h-full">
          <OperationsCard
            s={s}
            onRunMode={(m) => runModeMutation.mutate(m)}
            runModePending={runModeMutation.isPending}
          />
        </div>
        <div className="lg:col-span-3 h-full">
          <NextActionCard
            s={s}
            onTickNow={() => tickNowMutation.mutate()}
            tickPending={tickNowMutation.isPending}
            tickResult={tickNowMutation.data}
          />
        </div>
      </section>

      <FilterBar
        range={chartRange}
        onRangeChange={setChartRange}
        simMode={simMode}
        onSimModeChange={setSimMode}
      />

      {simMode && simParams && configQuery.data && (
        <SimParamBar
          params={simParams}
          config={configQuery.data.config}
          onChange={setSimParam}
          onReset={() => {
            const c = configQuery.data!.config;
            setSimParams({
              overpay_sat_per_eh_day: c.overpay_sat_per_eh_day,
              max_bid_sat_per_eh_day: c.max_bid_sat_per_eh_day,
              max_overpay_vs_hashprice_sat_per_eh_day:
                c.max_overpay_vs_hashprice_sat_per_eh_day ?? 0,
              fill_escalation_step_sat_per_eh_day: c.fill_escalation_step_sat_per_eh_day,
              fill_escalation_after_minutes: c.fill_escalation_after_minutes,
              lower_patience_minutes: c.lower_patience_minutes,
              min_lower_delta_sat_per_eh_day: c.min_lower_delta_sat_per_eh_day,
              escalation_mode: c.escalation_mode === 'market' ? 1 : 0,
            });
          }}
          onApply={async () => {
            if (!simParams || !configQuery.data) return;
            const { escalation_mode: escNum, ...numericParams } = simParams;
            const updated = {
              ...configQuery.data.config,
              ...numericParams,
              escalation_mode: escNum ? 'market' as const : 'dampened' as const,
            };
            await api.updateConfig(updated);
            qc.invalidateQueries({ queryKey: ['config'] });
            qc.invalidateQueries({ queryKey: ['status'] });
          }}
          loading={simQuery.isFetching}
          dirty={simParams !== null && configQuery.data !== undefined && Object.keys(simParams).some(
            (k) => simParams[k] !== (configQuery.data!.config as unknown as Record<string, number>)[k],
          )}
        />
      )}

      <StatsBar statsData={simMode ? simStatsData : statsQuery.data} />

      <HashrateChart
        points={(simMode && simMetricPoints ? simMetricPoints : metricsQuery.data?.points) ?? []}
        range={chartRange}
        onRangeChange={setChartRange}
        simMode={simMode}
        ourBlocks={oceanQuery.data?.our_recent_blocks ?? []}
      />
      <PriceChart
        points={(simMode && simMetricPoints ? simMetricPoints : metricsQuery.data?.points) ?? []}
        events={simMode ? simEvents : (bidEventsQuery.data?.events ?? [])}
        showEvents={simMode || CHART_RANGE_SPECS[chartRange].showEvents}
        simMode={simMode}
        /*
         * The simulator now respects the dynamic hashprice+max_overpay
         * cap (matching decide()), so the chart can use the same
         * effective-cap line in both real-time and simulation modes.
         * Pulls from config_summary so the line is always in sync with
         * whatever the operator's live setting is.
         */
        maxOverpayVsHashpriceSatPerPhDay={
          s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day
        }
      />

      {/*
       * Pipeline order: Braiins → Datum → Ocean (a share travels
       * Braiins-marketplace → Datum-gateway → Ocean-pool). Caps
       * live inside the Braiins card because they only describe
       * what we do in the marketplace. P&L sits below Bids as its
       * own full-width section; it's a financial summary of the
       * pipeline, not a pipeline step.
       */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card
          title="Braiins"
          nextRefreshAtMs={s.next_tick_at}
          badges={
            <ReachabilityBadge
              label="API reachable"
              reachable={s.market !== null}
              downLabel="API DOWN"
              title="Braiins marketplace API — reachable when the last observe() read market/orderbook/balance without error."
            />
          }
        >
          <Row k="delivered" v={formatHashratePH(s.actual_hashrate_ph)} />
          <Row
            k="target"
            v={
              s.config_summary.cheap_mode_active
                ? `${formatHashratePH(s.config_summary.effective_target_hashrate_ph)} (cheap mode)`
                : formatHashratePH(s.config_summary.target_hashrate_ph)
            }
          />
          <Row k="floor" v={formatHashratePH(s.config_summary.minimum_floor_hashrate_ph)} />
          {s.below_floor_since && (
            <div className="text-xs text-amber-400 mt-1">
              below floor since {formatAge(s.below_floor_since)}
            </div>
          )}
          {/*
           * Market + pricing block — ordered by how often the operator
           * looks at each line. Hashprice (break-even revenue) is the
           * most-referenced number when reasoning about whether a bid
           * is even worth placing, so it leads. Fillable-at-target
           * follows (what we'd actually pay). Then max-bid (+ its
           * dynamic sibling) because they're the ceiling. Best bid /
           * best ask are market color at the bottom — peripheral once
           * the operator has a bid in flight.
           */}
          <div className="border-t border-slate-800 mt-2 pt-2">
            {financeQuery.data?.ocean?.hashprice_sat_per_ph_day != null && (
              <Row
                k="hashprice"
                v={denomination.formatSatPerPhDay(financeQuery.data.ocean.hashprice_sat_per_ph_day, intlLocale)}
              />
            )}
            <Row
              k={`fillable @ ${formatHashratePH(s.config_summary.effective_target_hashrate_ph)}`}
              v={
                s.market?.fillable_ask_sat_per_ph_day != null
                  ? denomination.formatSatPerPhDay(s.market.fillable_ask_sat_per_ph_day, intlLocale) +
                    (s.market.fillable_thin ? ' (thin)' : '')
                  : '\u2014'
              }
            />
            <Row
              k={`max bid${s.config_summary.binding_cap === 'fixed' ? ' (binding)' : ''}`}
              v={denomination.formatSatPerPhDay(s.config_summary.max_bid_sat_per_ph_day, intlLocale)}
            />
            {s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day !== null && (
              <>
                <Row
                  k="max over hashprice"
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day,
                    intlLocale,
                  )}
                />
                <Row
                  k={`effective cap${s.config_summary.binding_cap === 'dynamic' ? ' (binding)' : ''}`}
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.effective_cap_sat_per_ph_day,
                    intlLocale,
                  )}
                />
              </>
            )}
            <Row k="best bid" v={denomination.formatSatPerPhDay(s.market?.best_bid_sat_per_ph_day ?? null, intlLocale)} />
            <Row k="best ask" v={denomination.formatSatPerPhDay(s.market?.best_ask_sat_per_ph_day ?? null, intlLocale)} />
          </div>
          <div className="border-t border-slate-800 mt-2 pt-2">
            {s.balances.length === 0 ? (
              <div className="text-slate-500 text-sm">{'\u2014'}</div>
            ) : (
              s.balances.map((b) => (
                <div key={b.subaccount}>
                  <Row k="available" v={denomination.formatSat(b.available_balance_sat, intlLocale)} />
                  <Row k="blocked" v={denomination.formatSat(b.blocked_balance_sat, intlLocale)} />
                  <Row k="total" v={denomination.formatSat(b.total_balance_sat, intlLocale)} />
                </div>
              ))
            )}
          </div>
        </Card>
        <DatumPanel
          url={s.config_summary.pool_url}
          reachable={s.pool.reachable}
          consecutiveFailures={s.pool.consecutive_failures}
          datum={s.datum}
          nextTickAt={s.next_tick_at}
        />
        <OceanPanel />
      </section>

      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">Bids</h3>
        {s.bids.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-slate-500 text-sm">
            no bids on this account
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 bg-slate-900/50">
                <tr>
                  <th className="text-left py-2 px-3">id</th>
                  <th className="text-left py-2 px-3">owner</th>
                  <th className="text-left py-2 px-3">created</th>
                  <th className="text-right py-2 px-3">price</th>
                  <th className="text-right py-2 px-3">delivered / cap</th>
                  <th className="text-right py-2 px-3">budget</th>
                  <th className="text-left py-2 px-3 w-32">progress</th>
                  <th className="text-left py-2 px-3">status</th>
                </tr>
              </thead>
              <tbody>
                {s.bids.map((b) => (
                  <tr key={b.braiins_order_id} className="border-t border-slate-800">
                    <td className="py-2 px-3 font-mono text-xs break-all">
                      {b.braiins_order_id}
                    </td>
                    <td className="py-2 px-3">
                      {b.is_owned ? (
                        <span className="text-emerald-400">autopilot</span>
                      ) : (
                        <span className="text-amber-400">unknown</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {b.created_at_ms ? (
                        <>
                          <div className="text-slate-300">{formatTimestamp(b.created_at_ms)}</div>
                          <div className="text-[11px] text-slate-500">
                            {formatTimestampUtc(b.created_at_ms)}
                          </div>
                        </>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <FormattedValue v={denomination.formatSatPerPhDay(b.price_sat_per_ph_day, intlLocale)} />
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatHashratePH(b.avg_speed_ph)}
                      <span className="text-xs text-slate-500">
                        {' '}
                        / {b.speed_limit_ph ? formatHashratePH(b.speed_limit_ph) : '∞'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      <FormattedValue v={denomination.formatSat(b.amount_sat, intlLocale)} />
                    </td>
                    <td className="py-2 px-3">
                      <BidProgress pct={b.progress_pct} />
                    </td>
                    <td className={`py-2 px-3 text-xs ${bidStatusClass(b.status)}`}>
                      {bidStatusLabel(b.status)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <FinancePanel
          data={financeQuery.data}
          status={s}
          onRefresh={() => qc.invalidateQueries({ queryKey: ['finance'] })}
          refreshing={financeQuery.isFetching}
        />
      </section>

      {s.last_proposals.length > 0 && (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">Last tick proposals</h3>
          <ul className="space-y-1">
            {s.last_proposals.map((p, i) => (
              <li key={i}>
                <ProposalLine p={p} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero operations card — run mode, action mode, operator avail, quiet hours.
// ---------------------------------------------------------------------------

const heroColors: Record<StatusResponse['run_mode'], string> = {
  DRY_RUN: 'from-sky-900/60 to-sky-950/40 border-sky-700/40',
  LIVE: 'from-emerald-900/60 to-emerald-950/40 border-emerald-700/40',
  PAUSED: 'from-amber-900/60 to-amber-950/40 border-amber-700/40',
};

function OperationsCard({
  s,
  onRunMode,
  runModePending,
}: {
  s: StatusResponse;
  onRunMode: (m: (typeof RUN_MODES)[number]) => void;
  runModePending: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  const actionVisible = s.action_mode !== 'NORMAL';

  // Effective rate across all owned active bids, weighted by delivered
  // hashrate (avg_speed_ph). That's the true "what am I paying right now"
  // number when more than one bid is open. Falls back to a simple price
  // average if nothing is being delivered yet (all bids freshly created).
  const activeOwned = s.bids.filter(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const totalDelivered = activeOwned.reduce((sum, b) => sum + b.avg_speed_ph, 0);
  let currentPricePH: number | null = null;
  if (activeOwned.length > 0) {
    if (totalDelivered > 0) {
      currentPricePH =
        activeOwned.reduce((sum, b) => sum + b.price_sat_per_ph_day * b.avg_speed_ph, 0) /
        totalDelivered;
    } else {
      currentPricePH =
        activeOwned.reduce((sum, b) => sum + b.price_sat_per_ph_day, 0) / activeOwned.length;
    }
  }

  const deliveredColor =
    s.actual_hashrate_ph < s.config_summary.minimum_floor_hashrate_ph
      ? 'text-red-400'
      : s.actual_hashrate_ph < s.config_summary.target_hashrate_ph
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <section
      className={`bg-gradient-to-br ${heroColors[s.run_mode]} border rounded-xl p-5 h-full flex flex-col justify-center items-center text-center`}
    >
      {currentPricePH !== null ? (
        <div className="grid grid-cols-2 gap-6 w-full">
          <div className="flex flex-col items-center">
            <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1">price</div>
            {/* relative wrapper so the ±delta can be position:absolute
                outside the flow — that way the big number stays centered
                regardless of how wide the badge gets (e.g. "+9" vs "+126"). */}
            <div className="relative leading-none">
              <span className="text-4xl font-mono font-semibold text-slate-100 tabular-nums">
                {denomination.mode === 'usd' && denomination.btcPrice !== null
                  ? new Intl.NumberFormat(intlLocale, {
                      style: 'currency',
                      currency: 'USD',
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    }).format((Math.round(currentPricePH) / 100_000_000) * denomination.btcPrice)
                  : formatNumber(Math.round(currentPricePH), {}, intlLocale)}
              </span>
              <span className="absolute left-full top-1/2 -translate-y-1/2 ml-1.5 whitespace-nowrap">
                <PriceDeltaVsFillable
                  currentPH={currentPricePH}
                  fillablePH={s.market?.fillable_ask_sat_per_ph_day ?? null}
                  intlLocale={intlLocale}
                />
              </span>
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {denomination.mode === 'usd' ? 'USD' : <><SatSymbol /></>}/PH/day
              {activeOwned.length > 1 ? ` · avg/${activeOwned.length}` : ''}
            </div>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1">delivered</div>
            <div className={`text-4xl font-mono font-semibold tabular-nums leading-none ${deliveredColor}`}>
              {formatNumber(s.actual_hashrate_ph, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }, intlLocale)}
            </div>
            <div className="text-xs text-slate-400 mt-1">PH/s</div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="text-3xl font-mono text-slate-500">—</div>
          <div className="text-xs text-slate-400 mt-0.5">no active bid</div>
        </div>
      )}
      <RunModeToggle current={s.run_mode} onChange={onRunMode} disabled={runModePending} />
      {actionVisible && (
        <div className="mt-2 text-sm text-amber-200">
          ⚠ {actionModeLabel(s.action_mode)}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Next action card
// ---------------------------------------------------------------------------

const TICK_RESULT_STALE_MS = 30_000;

const TICK_RESULT_KIND_LABELS: Record<string, string> = {
  CREATE_BID: 'Create bid',
  EDIT_PRICE: 'Edit price',
  EDIT_SPEED: 'Edit speed',
  CANCEL_BID: 'Cancel bid',
  PAUSE: 'Pause',
};

const TICK_RESULT_OUTCOME_STYLES: Record<string, string> = {
  EXECUTED: 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
  DRY_RUN: 'bg-slate-800 text-slate-300 border-slate-700',
  BLOCKED: 'bg-amber-900/40 text-amber-300 border-amber-700',
  FAILED: 'bg-red-900/40 text-red-300 border-red-700',
};

const TICK_RESULT_REASON_LABELS: Record<string, string> = {
  RUN_MODE_NOT_LIVE: 'not in LIVE mode',
  RUN_MODE_PAUSED: 'paused',
  ACTION_MODE_BLOCKS_CREATE_OR_EDIT: 'action mode blocks this',
  PRICE_DECREASE_COOLDOWN: 'Braiins 10-min cooldown',
};

function NextActionCard({
  s,
  onTickNow,
  tickPending,
  tickResult,
}: {
  s: StatusResponse;
  onTickNow: () => void;
  tickPending: boolean;
  tickResult: TickNowResponse | undefined;
}) {
  // Auto-fade the tick-result banner after a short window. Without
  // this the "Edit price: executed" line sits there long after the
  // decision ran and confuses "what just happened" with "what's
  // currently happening".
  const [tickResultStale, setTickResultStale] = useState(false);
  useEffect(() => {
    if (!tickResult) {
      setTickResultStale(false);
      return;
    }
    setTickResultStale(false);
    const id = setTimeout(() => setTickResultStale(true), TICK_RESULT_STALE_MS);
    return () => clearTimeout(id);
  }, [tickResult]);
  const showTickResult = tickResult && !tickResultStale;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-full flex flex-col">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-1">Next action</h3>
        <JustExecutedBanner last={s.next_action.last_executed} />
        <div className="text-slate-100">{s.next_action.summary}</div>
        {s.next_action.detail && (
          <div className="text-xs text-slate-400 mt-1">{s.next_action.detail}</div>
        )}
        <NextActionProgress next={s.next_action} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onTickNow}
          disabled={tickPending}
          title="Run the pending decision immediately — clears the post-edit lock and bypasses the patience/escalation timers so a waiting-to-settle EDIT_PRICE fires on this tick instead of after the full window."
          className="px-3 py-1.5 text-xs rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {tickPending ? 'ticking…' : 'Run decision now'}
        </button>
      </div>

      {showTickResult && tickResult && (
        <div className="mt-2 text-xs">
          {tickResult.ok
            ? (() => {
                const executed = tickResult.executed ?? [];
                if (executed.length === 0) {
                  return (
                    <span className="text-slate-400">No action needed this tick.</span>
                  );
                }
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {executed.map((e, i) => {
                      const label = TICK_RESULT_KIND_LABELS[e.kind] ?? e.kind;
                      const pillClass =
                        TICK_RESULT_OUTCOME_STYLES[e.outcome] ??
                        'bg-slate-800 text-slate-300 border-slate-700';
                      const outcomeLabel = e.outcome.toLowerCase();
                      const reasonLabel = e.reason
                        ? TICK_RESULT_REASON_LABELS[e.reason] ?? e.reason
                        : null;
                      return (
                        <span key={i} className="inline-flex items-center gap-1.5">
                          <span className="text-slate-300">{label}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${pillClass}`}
                          >
                            {outcomeLabel}
                          </span>
                          {reasonLabel && (
                            <span className="text-slate-500 text-[11px]">
                              — {reasonLabel}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })()
            : (
              <span className="text-red-400">tick failed: {tickResult.error}</span>
            )}
        </div>
      )}

      <NextActionFooter
        tickAt={s.tick_at}
        nextTickAt={s.next_tick_at}
        tickIntervalMs={s.tick_interval_ms}
      />
    </section>
  );
}

/**
 * Single-line footer on the Next-Action card: left = "last tick" with
 * absolute timestamp + relative age, right = live-ticking countdown to
 * the next blip. The countdown ticks once per second client-side
 * (server poll only refreshes `next_tick_at` every 5s, which would
 * otherwise produce a step-jumping number).
 */
function NextActionFooter({
  tickAt,
  nextTickAt,
  tickIntervalMs,
}: {
  tickAt: number | null;
  nextTickAt: number | null;
  tickIntervalMs: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the server hasn't told us when the next tick is, fall back to
  // tick_at + interval so the countdown still has something to show.
  const eta =
    nextTickAt ?? (tickAt !== null ? tickAt + tickIntervalMs : null);
  const remainingSec =
    eta !== null ? Math.max(0, Math.ceil((eta - now) / 1000)) : null;

  return (
    <div className="mt-3 pt-2 border-t border-slate-800 flex items-baseline justify-between gap-3 text-[11px] text-slate-500 font-mono">
      <span title={tickAt !== null ? formatTimestampUtc(tickAt) : ''}>
        last tick:{' '}
        <span className="text-slate-400">
          {tickAt !== null ? formatTimestamp(tickAt) : '—'}
        </span>
        {tickAt !== null && (
          <span className="ml-1 text-slate-600">({formatAge(tickAt)})</span>
        )}
      </span>
      <span>
        {remainingSec === null
          ? '—'
          : remainingSec > 0 ? (
              <>
                next in{' '}
                <span className="text-slate-300 tabular-nums">{remainingSec}s</span>
              </>
            )
          : <span className="text-slate-400">refreshing…</span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Price-vs-fillable delta indicator (hero card)
// ---------------------------------------------------------------------------

/**
 * Stock-ticker style ±delta vs the depth-aware fillable ask, rendered
 * inline next to the big price number. Hover for the full explanation.
 */
function PriceDeltaVsFillable({
  currentPH,
  fillablePH,
  intlLocale,
}: {
  currentPH: number;
  fillablePH: number | null;
  intlLocale: string | undefined;
}) {
  const denomination = useDenomination();
  if (fillablePH === null) return null;
  const delta = Math.round(currentPH - fillablePH);
  const fillablePretty = denomination.formatSatPerPhDay(Math.round(fillablePH));

  if (delta === 0) {
    return (
      <span
        className="text-xs font-mono text-slate-400 cursor-help"
        title={`Paying exactly the fillable ask (${fillablePretty}) — the cheapest price at which the full target hashrate is available.`}
      >
        ±0
      </span>
    );
  }

  const sign = delta > 0 ? '+' : '−';
  const color = delta > 0 ? 'text-red-300' : 'text-emerald-300';
  const verb = delta > 0 ? 'over' : 'under';
  const deltaFormatted = denomination.formatSatPerPhDay(Math.abs(delta));
  const tooltip =
    `Currently paying ${sign}${deltaFormatted} ` +
    `${verb} the fillable ask (${fillablePretty}) — the cheapest price at which ` +
    `your full target hashrate is available in the orderbook.`;

  return (
    <Tooltip text={tooltip}>
      <span className={`text-xs font-mono ${color} cursor-help`}>
        {sign}{denomination.mode === 'usd' && denomination.btcPrice
          ? denomination.formatSatPerPhDay(Math.abs(delta)).replace(/\/PH\/day$/, '')
          : formatNumber(Math.abs(delta), {}, intlLocale)}
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// "Just executed" breadcrumb on the Next-Action card
// ---------------------------------------------------------------------------

const JUST_EXECUTED_VISIBLE_MS = 90_000;

/**
 * Briefly surfaces the most recent autopilot mutation so the operator
 * sees explicit confirmation when a tick fires — instead of the panel
 * silently jumping from "Will lower …" to "On target". Auto-fades
 * after ~90s. Re-renders every 5s so the relative-age text refreshes.
 */
function JustExecutedBanner({ last }: { last: NextActionView['last_executed'] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!last) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [last]);

  if (!last) return null;
  const age = now - last.executed_at_ms;
  if (age > JUST_EXECUTED_VISIBLE_MS) return null;

  return (
    <div className="mb-2 flex items-baseline gap-2 text-xs">
      <span className="text-emerald-400">✓</span>
      <span className="text-emerald-200">{last.summary}</span>
      <span className="text-slate-500 text-[11px]">({formatAge(last.executed_at_ms)})</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next-action progress bar (issue #4)
// ---------------------------------------------------------------------------

const EVENT_LABELS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'Escalation in',
  lower_after_override: 'Override lock clears in',
  lower_after_cooldown: 'Cooldown clears in',
};

const EVENT_COLORS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'bg-amber-400',
  lower_after_override: 'bg-sky-400',
  lower_after_cooldown: 'bg-sky-400',
};

function NextActionProgress({ next }: { next: NextActionView }) {
  // Re-render every second so the bar visibly creeps even between the
  // 5s status polls. Hook is only useful when an event is queued; gate
  // the interval below to avoid burning a timer in steady state.
  const hasEvent =
    next.eta_ms !== null && next.event_started_ms !== null && next.event_kind !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasEvent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasEvent]);

  if (!hasEvent) return null;
  const start = next.event_started_ms!;
  const end = next.eta_ms!;
  const span = Math.max(1, end - start);
  const elapsed = Math.max(0, Math.min(span, now - start));
  const fraction = elapsed / span;
  const remainingMs = Math.max(0, end - now);
  const overdue = end < now;
  const label = EVENT_LABELS[next.event_kind!];
  const fillColor = overdue ? 'bg-red-400' : EVENT_COLORS[next.event_kind!];

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-[11px] text-slate-400 mb-1 font-mono">
        <span>{label}</span>
        <span className={overdue ? 'text-red-300' : ''}>
          {overdue ? `overdue ${formatRemaining(now - end)}` : formatRemaining(remainingMs)}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded overflow-hidden">
        <div
          className={`h-full ${fillColor} transition-[width] duration-1000 ease-linear`}
          style={{ width: `${(fraction * 100).toFixed(2)}%` }}
        />
      </div>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tuning stats bar (between charts and cards)
// ---------------------------------------------------------------------------

const EH_PER_PH = 1000;

const SIM_NUMBER_FIELDS = [
  { key: 'overpay_sat_per_eh_day', label: 'Overpay', step: 50_000, ehToPh: true, unit: 'sat/PH/day' },
  { key: 'max_bid_sat_per_eh_day', label: 'Max bid', step: 1_000_000, ehToPh: true, unit: 'sat/PH/day' },
  { key: 'fill_escalation_step_sat_per_eh_day', label: 'Esc. step', step: 50_000, ehToPh: true, unit: 'sat/PH/day' },
  { key: 'fill_escalation_after_minutes', label: 'Esc. window', step: 1, ehToPh: false, unit: 'min' },
  { key: 'lower_patience_minutes', label: 'Wait to lower', step: 1, ehToPh: false, unit: 'min' },
  { key: 'min_lower_delta_sat_per_eh_day', label: 'Min lower delta', step: 50_000, ehToPh: true, unit: 'sat/PH/day' },
] as const;

function FilterBar({
  range,
  onRangeChange,
  simMode,
  onSimModeChange,
}: {
  range: ChartRange;
  onRangeChange: (r: ChartRange) => void;
  simMode: boolean;
  onSimModeChange: (v: boolean) => void;
}) {
  return (
    <section className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex rounded overflow-hidden border border-slate-700 text-xs">
        <button
          onClick={() => onSimModeChange(false)}
          className={`px-3 py-1.5 ${!simMode ? 'bg-emerald-700 text-emerald-100' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
        >
          Real-time
        </button>
        <button
          onClick={() => onSimModeChange(true)}
          className={`px-3 py-1.5 ${simMode ? 'bg-amber-700 text-amber-100' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
        >
          Simulation
        </button>
      </div>
      <div className="flex gap-1">
        {(['6h', '12h', '24h', '1w', '1m', '1y', 'all'] as ChartRange[]).map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
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
    </section>
  );
}

function SimParamBar({
  params,
  config,
  onChange,
  onReset,
  onApply,
  loading,
  dirty,
}: {
  params: Record<string, number>;
  config: object;
  onChange: (key: string, value: number) => void;
  onReset: () => void;
  onApply: () => void;
  loading: boolean;
  dirty: boolean;
}) {
  return (
    <section className="bg-slate-900/50 border border-amber-800/30 rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-wider text-amber-300">Simulation parameters</span>
          {loading && <span className="text-xs text-amber-400 animate-pulse">simulating...</span>}
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <>
              <button
                onClick={onReset}
                className="text-[10px] px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:bg-slate-700"
              >
                Reset
              </button>
              <button
                onClick={onApply}
                className="text-[10px] px-2 py-1 rounded bg-amber-800/60 border border-amber-700/50 text-amber-200 hover:bg-amber-700/60"
              >
                Apply to config
              </button>
            </>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {SIM_NUMBER_FIELDS.map((f) => {
          const rawValue = params[f.key] ?? 0;
          const configVal = (config as unknown as Record<string, number>)[f.key] ?? 0;
          const displayValue = f.ehToPh ? Math.round(rawValue / EH_PER_PH) : rawValue;
          const changed = rawValue !== configVal;
          return (
            <div key={f.key}>
              <label className="text-[10px] text-slate-500 block mb-0.5">{f.label}</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={displayValue}
                  step={f.ehToPh ? Math.round(f.step / EH_PER_PH) : f.step}
                  min={0}
                  onChange={(e) => {
                    const v = Number(e.target.value) || 0;
                    onChange(f.key, f.ehToPh ? v * EH_PER_PH : v);
                  }}
                  className={`w-full bg-slate-800 border rounded px-2 py-1 text-xs font-mono tabular-nums text-right ${
                    changed ? 'border-amber-600 text-amber-300' : 'border-slate-700 text-slate-300'
                  }`}
                />
                <span className="text-[9px] text-slate-600 whitespace-nowrap"><SatUnit unit={f.unit} /></span>
              </div>
            </div>
          );
        })}
        <div>
          <label className="text-[10px] text-slate-500 block mb-0.5">Esc. mode</label>
          <div className="flex rounded overflow-hidden border border-slate-700 text-[10px] h-[26px]">
            <button
              onClick={() => onChange('escalation_mode', 0)}
              className={`flex-1 px-1.5 ${!params.escalation_mode ? 'bg-amber-800/60 text-amber-200' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
            >
              Dampened
            </button>
            <button
              onClick={() => onChange('escalation_mode', 1)}
              className={`flex-1 px-1.5 ${params.escalation_mode ? 'bg-amber-800/60 text-amber-200' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
            >
              Market
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Four KPIs from the server-side `/api/stats` endpoint. The server
 * computes duration-weighted averages from the raw tick_metrics table
 * using SQL LEAD() window function, so each tick is weighted by its
 * actual duration — not an equal-weight approximation that distorts
 * on pre-aggregated chart buckets (1w/1m).
 *
 * Responds to the chart range filter (same query param) so the
 * operator can compare stats across 6h/24h/1w etc.
 */
function StatsBar({ statsData }: { statsData: StatsResponse | undefined }) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  if (!statsData) {
    return (
      <section className="grid grid-cols-2 lg:grid-cols-7 gap-3">
        {['uptime', 'avg hashrate', 'total PH·h', 'mutations', 'avg cost / PH delivered', 'avg overpay vs fillable', 'avg overpay vs hashprice'].map((label) => (
          <StatCard key={label} label={label} value="—" tooltip="Loading or daemon restart required." />
        ))}
      </section>
    );
  }

  if (statsData.tick_count < 2) return null;

  const { uptime_pct, avg_hashrate_ph, avg_datum_hashrate_ph, avg_overpay_sat_per_ph_day, avg_cost_per_ph_sat_per_ph_day, avg_overpay_vs_hashprice_sat_per_ph_day, mutation_count } = statsData;
  // total_ph_hours is intentionally unread — the Total PH·h card was
  // hidden to make the stat bar fit on one row. Server still emits it
  // so the metric is available if we bring the card back.
  void statsData.total_ph_hours;

  // Show "2.56/2.12" when Datum is reporting, plain "2.56" otherwise.
  // A sustained gap between the two is the operator's "am I getting
  // what Braiins is billing me for" signal. Unit stays attached to the
  // right-hand number so it reads as "Braiins/Datum PH/s" as a pair.
  // Slash has no surrounding spaces — the card is already narrow and
  // the pair belongs tight together visually.
  const avgHashrateText =
    avg_hashrate_ph === null
      ? '\u2014'
      : avg_datum_hashrate_ph !== null
        ? `${avg_hashrate_ph.toFixed(2)}/${avg_datum_hashrate_ph.toFixed(2)} PH/s`
        : `${avg_hashrate_ph.toFixed(2)} PH/s`;
  const avgHashrateTooltip =
    avg_datum_hashrate_ph !== null
      ? 'Left: duration-weighted average hashrate Braiins reports delivering (delivered_ph). Right: average hashrate Datum measures at the gateway (datum_hashrate_ph). A sustained gap means Braiins is billing for hashrate the gateway never saw.'
      : 'Duration-weighted average hashrate across the selected range, including downtime (where delivered = 0). Reflects real throughput — not just the moments you were hashing.';

  return (
    <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <StatCard
        label="uptime"
        value={uptime_pct !== null ? `${uptime_pct.toFixed(1)}%` : '\u2014'}
        tooltip="Duration-weighted % of time with delivered hashrate > 0. Each tick is weighted by its actual duration (time until the next tick) so gaps after restarts count proportionally."
        color={
          uptime_pct === null
            ? 'text-slate-400'
            : uptime_pct >= 90
              ? 'text-emerald-300'
              : uptime_pct >= 50
                ? 'text-amber-300'
                : 'text-red-300'
        }
      />
      <StatCard
        label="avg hashrate"
        value={avgHashrateText}
        tooltip={avgHashrateTooltip}
      />
      <StatCard
        label="mutations"
        value={mutation_count.toString()}
        tooltip="Number of successful bid mutations (create / edit price / edit speed / cancel) executed in this range. Read from the bid_events log — DRY_RUN and blocked proposals are excluded. High = autopilot is churning; low = market is quiet or it's stuck."
      />
      <StatCard
        label="avg cost / PH delivered"
        value={avg_cost_per_ph_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_cost_per_ph_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip="Duration-weighted average price per PH delivered: sum(price × delivered × duration) / sum(delivered × duration). The efficiency metric."
      />
      <StatCard
        label="avg overpay vs fillable"
        value={avg_overpay_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_overpay_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip="Duration-weighted average of (our price − fillable ask). Each tick weighted by its actual duration. High = overpay too generous or lowering too slow."
      />
      <StatCard
        label="avg overpay vs hashprice"
        value={avg_overpay_vs_hashprice_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_overpay_vs_hashprice_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip="Duration-weighted average of (our price − hashprice). Shows how much above break-even you pay on average. High = you're paying well above what mining would cost at current difficulty."
      />
    </section>
  );
}

function StatCard({
  label,
  value,
  tooltip,
  color = 'text-slate-100',
}: {
  label: string;
  value: string;
  tooltip: string;
  color?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 cursor-help text-center">
        {/* Reserve two lines for the label so single-line cards
            ("uptime") line up with two-line cards ("avg cost / PH
            delivered") — otherwise the big numbers underneath
            don't share a baseline. */}
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2 min-h-8 leading-4 flex items-start justify-center">
          <span>{label}</span>
        </div>
        <div className={`text-2xl font-mono tabular-nums ${color}`}>
          {split ? split.num : value}
        </div>
        {split && (
          <div className="text-xs text-slate-500 mt-0.5"><SatUnit unit={split.unit} /></div>
        )}
      </div>
    </Tooltip>
  );
}

function formatFillTime(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m`;
}

// ---------------------------------------------------------------------------

/**
 * Self-ticking "updated X ago" label. Re-renders every 10 s so the
 * operator actually sees the age climb (previously it was pinned to
 * "0s ago" because `checked_at_ms` was Date.now() on every response).
 */
function TickingAge({ epochMs }: { epochMs: number | null | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return <span>updated {formatAgePrecise(epochMs)}</span>;
}

/**
 * Forward countdown — "refreshes in 42s", "refreshes in 2m 13s".
 * The panel decides when it will next fetch and hands us that
 * timestamp; we re-render once per second so the digits tick visibly.
 * Prefer this over {@link TickingAge} on panels that refresh on a
 * predictable cadence — operators want to know how long until new
 * data, not how old the current data is.
 */
function RefreshCountdown({ nextAtMs }: { nextAtMs: number | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  if (nextAtMs == null) return <span>—</span>;
  const msUntil = nextAtMs - now;
  // Once the countdown crosses zero we're waiting on either the
  // server's next tick (which runs on the interval timer) or the
  // dashboard's next react-query poll. Either way "now" stuck on
  // screen for 30 seconds reads as broken; "refreshing…" is honest
  // about what's happening.
  if (msUntil <= 0) return <span>refreshing…</span>;
  return <span>refreshes in {formatCountdownPrecise(msUntil)}</span>;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Pill-style status indicator used across Braiins / Datum / Ocean
 * panels to show reachability of the underlying external service.
 * Renders a coloured dot + label inside a bordered chip.
 */
function ReachabilityBadge({
  label,
  reachable,
  downLabel,
  title,
}: {
  label: string;
  reachable: boolean;
  /** Override for the text when !reachable (e.g. "DOWN (3 consecutive)"). */
  downLabel?: string;
  title?: string;
}) {
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ' +
        (reachable
          ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
          : 'border-red-700 bg-red-900/30 text-red-300')
      }
      title={title}
    >
      <span
        className={
          'w-1.5 h-1.5 rounded-full ' + (reachable ? 'bg-emerald-400' : 'bg-red-400')
        }
      />
      {reachable ? label : (downLabel ?? `${label} DOWN`)}
    </span>
  );
}

/**
 * Vertical money panel: cost on top, then the two income sources,
 * then net at the bottom. Reads naturally as a profit-and-loss page —
 * the two incomes obviously add up to "what we'll have", which is
 * then offset against "what we paid".
 *
 *   spent     — lifetime sat consumed across all autopilot-owned bids
 *   expected  — Ocean's "Unpaid Earnings" (pending next payout)
 *   collected — on-chain UTXOs at the configured payout address
 *   net       — collected + expected − spent (final result)
 *
 * Each input renders "—" when its source isn't reporting yet; net
 * stays "—" until both income halves have at least one observation.
 */
function OceanPanel() {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  // React-query dedupes by queryKey, so this shares the in-flight
  // fetch + cached response with the parent's own `['ocean']` query
  // (used for the hashrate-chart block markers).
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 5 * 60_000,
  });

  const o = oceanQuery.data;

  if (!o || !o.configured) {
    return (
      <Card title="Ocean">
        <div className="text-slate-500 text-sm">Not configured</div>
      </Card>
    );
  }

  // Ocean refreshes every 5 minutes client-side (and server caches for
  // the same). Countdown = last fetch + 5 min; reachable whenever the
  // last response carried data.
  const nextOceanRefreshMs =
    o.fetched_at_ms !== null ? o.fetched_at_ms + 5 * 60_000 : null;

  return (
    <Card
      title="Ocean"
      nextRefreshAtMs={nextOceanRefreshMs}
      badges={
        <ReachabilityBadge
          label="API reachable"
          reachable={o.fetched_at_ms !== null && o.pool !== null}
          downLabel="API DOWN"
          title="Ocean stats API — reachable when the last /api/ocean fetch returned a pool snapshot."
        />
      }
    >
      {o.last_block ? (
        <>
          <Row k="last block" v={`#${o.last_block.height.toLocaleString(intlLocale)}`} />
          <Row k="found" v={o.last_block.ago_text} />
          <Row k="reward" v={denomination.formatSat(o.last_block.total_reward_sat, intlLocale)} />
        </>
      ) : (
        <Row k="last block" v={'\u2014'} />
      )}
      <Row k="blocks 24h" v={String(o.blocks_24h)} />
      <Row k="blocks 7d" v={String(o.blocks_7d)} />
      <div className="border-t border-slate-800 mt-2 pt-2">
        {o.user && (
          <>
            <Row k="share log" v={o.user.share_log_pct !== null ? `${o.user.share_log_pct.toFixed(4)}%` : '\u2014'} />
            <Row k="unpaid" v={denomination.formatSat(o.user.unpaid_sat, intlLocale)} />
            <Row k="next block est." v={denomination.formatSat(o.user.next_block_sat, intlLocale)} />
            <Row k="income/day est." v={denomination.formatSat(o.user.daily_estimate_sat, intlLocale)} />
            {o.user.time_to_payout_text && (
              <Row
                k="next payout"
                v={formatNextPayout(o.user.time_to_payout_text)}
              />
            )}
          </>
        )}
      </div>
      {o.pool && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          {o.pool.active_users !== null && (
            <Row k="pool users" v={o.pool.active_users.toLocaleString(intlLocale)} />
          )}
          {o.pool.active_workers !== null && (
            <Row k="pool workers" v={o.pool.active_workers.toLocaleString(intlLocale)} />
          )}
        </div>
      )}
    </Card>
  );
}

function FinancePanel({
  data,
  status,
  onRefresh,
  refreshing,
}: {
  data: FinanceResponse | undefined;
  status: StatusResponse;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const qc = useQueryClient();
  const [rebuilding, setRebuilding] = useState(false);

  const handleRebuild = async () => {
    if (rebuilding) return;
    if (!window.confirm('Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh? This is safe but slower than a normal refresh.')) {
      return;
    }
    setRebuilding(true);
    try {
      await api.rebuildSpendCache();
      qc.invalidateQueries({ queryKey: ['finance'] });
    } finally {
      setRebuilding(false);
    }
  };

  // Run-rate view: what's this autopilot costing/earning *right now*,
  // per day? Distinct from the lifetime P&L above. Sum across active
  // owned bids of (price × delivered_hashrate) — Braiins only debits
  // Billing is capped at speed_limit_ph — Braiins won't charge for
  // more than the limit even if the rolling avg_speed_ph temporarily
  // overshoots (measurement artifact from burst-then-gap delivery).
  // Use min(avg_speed, speed_limit) for the spend estimate.
  //
  // Must be computed BEFORE the `!data` early return so hook count is
  // stable across the null → defined transition of `data` (React error
  // #310). The callback tolerates `data` being undefined.
  const { dailySpendSat, hasDailySpend, dailyIncomeSat, dailyNetSat, dailyNetColor } = useMemo(() => {
    const ownedActive = status.bids.filter(
      (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
    );
    const _dailySpendSat = ownedActive.reduce(
      (sum, b) => {
        const effectiveSpeed = b.speed_limit_ph !== null
          ? Math.min(b.avg_speed_ph, b.speed_limit_ph)
          : b.avg_speed_ph;
        return sum + b.price_sat_per_ph_day * effectiveSpeed;
      },
      0,
    );
    const _hasDailySpend = ownedActive.length > 0 && _dailySpendSat > 0;
    const _dailyIncomeSat = data?.ocean?.daily_estimate_sat ?? null;
    const _dailyNetSat =
      _hasDailySpend && _dailyIncomeSat !== null
        ? Math.round(_dailyIncomeSat - _dailySpendSat)
        : null;
    const _dailyNetColor =
      _dailyNetSat === null
        ? ''
        : _dailyNetSat >= 0
          ? 'text-emerald-300'
          : 'text-red-300';
    return {
      dailySpendSat: _dailySpendSat,
      hasDailySpend: _hasDailySpend,
      dailyIncomeSat: _dailyIncomeSat,
      dailyNetSat: _dailyNetSat,
      dailyNetColor: _dailyNetColor,
    };
  }, [status.bids, data?.ocean?.daily_estimate_sat]);

  if (!data) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2">Profit &amp; Loss</div>
        <div className="text-slate-500 text-sm">loading…</div>
      </section>
    );
  }

  const netColor =
    data.net_sat === null
      ? 'text-slate-400'
      : data.net_sat >= 0
        ? 'text-emerald-300'
        : 'text-red-300';

  const hasPerDay =
    dailyIncomeSat !== null ||
    hasDailySpend ||
    dailyNetSat !== null ||
    data.ocean?.hashprice_sat_per_ph_day != null ||
    data.ocean?.lifetime_sat != null ||
    !!data.ocean?.time_to_payout_text;

  // P&L refreshes hourly server-side. Dashboard countdown is derived
  // from checked_at_ms + 1h so the operator sees how long until fresh
  // numbers without guessing the cadence.
  const nextRefreshAtMs = data.checked_at_ms + 3_600_000;

  const headerControls = (
    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
      <RefreshCountdown nextAtMs={nextRefreshAtMs} />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
        title="Refresh the money panel now (normally updates hourly)."
      >
        {refreshing ? '…' : '↻'}
      </button>
      {data.spent_scope === 'account' && (
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
          title="Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh. Use if the 'spent (whole account)' figure looks wrong."
        >
          {rebuilding ? '…' : 'rebuild'}
        </button>
      )}
    </div>
  );

  // Two separate cards: per-day run-rate and lifetime totals. Same
  // data source, but visually distinct so the operator reads them as
  // two different questions — "am I burning money per day right now?"
  // vs "did I end up ahead over the whole run?".
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Left card — per-day run-rate */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            Profit &amp; Loss · per day
          </div>
          {headerControls}
        </div>
        {hasPerDay ? (
          // Per-day values are all projections / estimates (Ocean's
          // 3h-hashrate extrapolation for income, live bid price ×
          // delivered for spend). Label them "projected" so the
          // operator reads them as forecasts rather than facts. The
          // exceptions — hashprice (current market break-even) and
          // ocean lifetime (actual earnings) — keep their existing
          // plain labels.
          <div className="space-y-1.5 text-sm font-mono">
            {dailyIncomeSat !== null && (
              <FinanceFootnote
                label="projected income/day"
                value={denomination.formatSat(dailyIncomeSat, intlLocale)}
                tooltip="Projection. Ocean's estimated earnings per day at the address's 3-hour hashrate. Slides as that rate moves."
              />
            )}
            {hasDailySpend && (
              <FinanceFootnote
                label="projected spend/day"
                value={denomination.formatSat(Math.round(dailySpendSat), intlLocale)}
                tooltip="Projection. Cost per day at current bid price × delivered hashrate, summed across active owned bids. Braiins only debits for hashrate actually delivered, so this tracks reality (not the speed-limit cap)."
              />
            )}
            {dailyNetSat !== null && (
              <FinanceFootnote
                label="projected net/day"
                value={
                  denomination.mode === 'usd' && denomination.btcPrice !== null
                    ? `${dailyNetSat >= 0 ? '+' : ''}${denomination.formatSat(dailyNetSat, intlLocale)}`
                    : `${dailyNetSat >= 0 ? '+' : ''}${formatNumber(dailyNetSat, {}, intlLocale)} sat`
                }
                tooltip="Projection. Income/day − spend/day. Positive = the autopilot is profitable at current rates; negative = burning money per day. Don't confuse with the lifetime net on the other panel."
                valueClass={dailyNetColor}
              />
            )}
            {data.ocean?.hashprice_sat_per_ph_day != null && (
              <FinanceFootnote
                label="hashprice (break-even)"
                value={denomination.formatSatPerPhDay(data.ocean.hashprice_sat_per_ph_day, intlLocale)}
                tooltip="Current market break-even. Revenue per PH/s per day from mining at the current network difficulty + block reward. If you're paying ABOVE this for hashrate, you're spending more than mining earns. Below = profitable."
              />
            )}
            {data.ocean?.lifetime_sat != null && (
              <FinanceFootnote
                label="ocean lifetime"
                value={denomination.formatSat(data.ocean.lifetime_sat, intlLocale)}
                tooltip="Total earned at this address since first share, per Ocean."
              />
            )}
          </div>
        ) : (
          <div className="text-sm text-slate-600">no active bids</div>
        )}
      </div>

      {/* Right card — lifetime totals (the actual P&L ledger) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            Profit &amp; Loss · lifetime
          </div>
          {/* refresh/rebuild controls live on the per-day card only —
              they refresh the same data, no point duplicating them */}
        </div>
        {/* The panel reads as the arithmetic of the net line: an
            explicit leading sign tells the operator which side of the
            ledger each row sits on. Spent is the only subtraction;
            Ocean + on-chain are the additions; the bottom line is the
            sum. */}
        <FinanceRow
          sign="minus"
          label={data.spent_scope === 'account' ? 'spent (whole account)' : 'spent (autopilot)'}
          value={data.spent_sat}
          tooltip={
            data.spent_scope === 'account'
              ? 'Sum of counters_committed.amount_consumed_sat across every bid on /v1/spot/bid — covers active + historical bids, including any that existed before the autopilot was switched on. May lag the latest hour of active-bid consumption (Braiins only updates committed counters on each hourly settlement tick). Switch via Config → P&L panel.'
              : 'Lifetime sum of (amount_sat − amount_remaining_sat) across every bid the autopilot has tagged. Excludes any bids placed before the autopilot was switched on. Switch to "whole account" via Config → Money panel.'
          }
        />
        {data.spent_scope === 'account' &&
          data.spent_closed_sat !== null &&
          data.spent_active_sat !== null && (
            <>
              <FinanceSubRow
                label="closed bids"
                value={data.spent_closed_sat}
                tooltip="Sum across terminal bids — status CANCELED or FULFILLED (is_current=false). Money that has definitively left the account."
              />
              <FinanceSubRow
                label="active (in-flight)"
                value={data.spent_active_sat}
                tooltip="Sum across still-running bids — status ACTIVE / PAUSED / etc. (is_current=true). Live in-flight consumption; not yet settled in Braiins' hourly ledger."
              />
            </>
          )}
        <FinanceRow
          sign="plus"
          label="unpaid earnings (Ocean)"
          value={data.expected_sat}
          tooltip={
            data.ocean
              ? `Ocean's Unpaid Earnings — what will land on-chain at the next payout. Threshold: ${formatSats(data.ocean.payout_threshold_sat)} sat (~0.01 BTC).`
              : 'Ocean stats unavailable.'
          }
        />
        <FinanceRow
          sign="plus"
          label="collected (on-chain)"
          value={data.collected_sat}
          tooltip={
            data.collected_sat !== null
              ? 'UTXOs at the configured payout address. Read via Electrs (preferred, instant) or bitcoind RPC (slower).'
              : 'Not configured. Go to Config → On-chain payouts and select Electrs or Bitcoin Core RPC to track your on-chain balance. The net line treats missing collected as 0 so the arithmetic still reads — a blank row here is the hint that a piece of the income side isn\'t wired up.'
          }
        />

        <div className="mt-3 pt-3 border-t border-slate-800">
          <FinanceRow
            sign="equals"
            label="net"
            value={data.net_sat}
            // Only the bottom-line gets a sentiment color — green when
            // the autopilot has paid for itself, red when it's still
            // digging out of the initial deposit. Keeps the rest of
            // the panel calm so the eye lands on the conclusion.
            valueClass={netColor}
            tooltip="Collected on-chain + Ocean's unpaid earnings − spent on bids. Missing collected is treated as 0 (the on-chain row still shows — so the operator sees the gap). Negative = still recouping the initial deposit."
          />
        </div>
      </div>
    </section>
  );
}

/**
 * One row in the vertical money stack: label on the left, value on
 * the right (right-aligned, monospace, tabular-nums so the digits
 * line up across rows). `value=null` renders as "—".
 */
function FinanceRow({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-100',
  sign,
}: {
  label: string;
  value: number | null;
  tooltip: string;
  valueClass?: string;
  /** Leading arithmetic sign. Turns the panel into a readable sum
   *  rather than a dictionary of unrelated figures. */
  sign?: 'plus' | 'minus' | 'equals';
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  // Match the size + label-color of the standard <Row> used by the
  // sibling Hashrate-and-market and Braiins-balance cards so the three
  // panels read as a set. Only the value's *color* varies (caller can
  // override via valueClass — used for the green/red net bottom line).
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  const signChar = sign === 'plus' ? '+' : sign === 'minus' ? '−' : sign === 'equals' ? '=' : '';
  const signColor =
    sign === 'plus'
      ? 'text-emerald-400'
      : sign === 'minus'
        ? 'text-red-400'
        : 'text-slate-500';
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-sm py-0.5 gap-2">
        {sign && (
          <span
            className={`font-mono tabular-nums w-3 text-center ${signColor}`}
            aria-hidden="true"
          >
            {signChar}
          </span>
        )}
        <span className="text-slate-400 flex-1">{label}</span>
        <span className={`font-mono ${valueClass}`}>
          {value === null ? (
            '\u2014'
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Indented sub-line under a main FinanceRow. Used to break "spent
 * (whole account)" into its closed vs active halves without competing
 * for visual weight with the top-level additions and subtraction.
 * No arithmetic sign — it's a breakdown, not another operand.
 */
function FinanceSubRow({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: number | null;
  tooltip: string;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-[11px] py-0 pl-7 gap-2 text-slate-500">
        <span className="flex-1">{label}</span>
        <span className="font-mono">
          {value === null ? (
            '\u2014'
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-600 text-[10px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

function FinanceFootnote({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-300',
}: {
  label: string;
  value: string;
  tooltip: string;
  valueClass?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className={`text-right ${valueClass}`}>
          {split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            value
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Turn Ocean's "Estimated Time Until Minimum Payout" string ("11 days",
 * "5 hours", "Below threshold", etc.) into a footnote value that
 * includes both the raw text and a concrete date — easier to plan
 * around than counting days mentally.
 *
 * Falls back to the raw text if it can't be parsed (e.g. "Below
 * threshold" when the rate is so low Ocean refuses to estimate, or
 * any future format we haven't seen yet).
 */
function formatNextPayout(raw: string): string {
  const ms = parseDurationMs(raw);
  if (ms === null || ms <= 0) return raw;
  const eta = new Date(Date.now() + ms);
  const date = new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
  }).format(eta);
  return `${raw} · ~${date}`;
}

const DURATION_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

function parseDurationMs(raw: string): number | null {
  // Ocean uses friendly units: "11 days", "5 hours", "30 minutes",
  // "2 weeks". Single + plural; case-insensitive on the unit.
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const u = DURATION_UNIT_MS[m[2].toLowerCase()];
  return u ? n * u : null;
}

function DatumPanel({
  url,
  reachable,
  consecutiveFailures,
  datum,
  nextTickAt,
}: {
  url: string;
  reachable: boolean;
  consecutiveFailures: number;
  datum: StatusResponse['datum'];
  nextTickAt: number | null;
}) {
  const [copied, setCopied] = useState(false);

  // Split the pool URL into scheme / host / port so the card doesn't
  // wrap an unreadable 60-character string. Pool URLs on Ocean look
  // like stratum+tcp://alkimia.mynetgear.com:23334 — we care about
  // the host most, the scheme rarely, the port sometimes. Rendering
  // three aligned rows beats a wrapped monofont URL every time.
  const urlParts = splitPoolUrl(url);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API may be blocked in non-secure contexts */
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">Datum Gateway</div>
        <div className="text-[11px] text-slate-500 font-mono">
          <RefreshCountdown nextAtMs={nextTickAt} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ReachabilityBadge
          label="stratum reachable"
          reachable={reachable}
          downLabel={`stratum DOWN (${consecutiveFailures} consecutive)`}
          title="TCP probe of the Datum gateway's stratum port."
        />
        {datum && (
          <ReachabilityBadge
            label="stats reachable"
            reachable={datum.reachable}
            downLabel={`stats unreachable (${datum.consecutive_failures})`}
            title="Datum /umbrel-api HTTP poll."
          />
        )}
      </div>
      {datum ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400">datum hashrate</div>
          <div className="text-right font-mono text-slate-200">
            {datum.hashrate_ph !== null ? formatHashratePH(datum.hashrate_ph) : '—'}
          </div>
          <div className="text-slate-400">workers connected</div>
          <div className="text-right font-mono text-slate-200">
            {datum.connections ?? '—'}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          Datum stats not configured — set <span className="font-mono text-slate-400">datum_api_url</span>{' '}
          in Config to display connected workers and reported hashrate. See{' '}
          <span className="font-mono text-slate-400">docs/setup-datum-api.md</span>.
        </div>
      )}
      {/* Pool info lives at the bottom — stratum URL rarely changes
          after initial setup, so it deserves less visual weight than
          the live numbers above. Icon-only copy button keeps the
          footprint small. */}
      <div className="mt-3 pt-2 border-t border-slate-800">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">pool</div>
          <button
            onClick={copy}
            aria-label={copied ? 'copied URL' : 'copy URL'}
            title={copied ? 'copied URL' : 'copy URL'}
            className={
              'shrink-0 p-1 rounded border border-slate-700 hover:bg-slate-800 ' +
              (copied ? 'text-emerald-300' : 'text-slate-400')
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400">protocol</div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.scheme ?? '\u2014'}
          </div>
          <div className="text-slate-400">host</div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.host ?? '\u2014'}
          </div>
          <div className="text-slate-400">port</div>
          <div className="text-right font-mono text-slate-200">
            {urlParts.port ?? '\u2014'}
          </div>
        </div>
      </div>
    </div>
  );
}

function BidProgress({ pct }: { pct: number | null }) {
  if (pct === null || pct === undefined) return <span className="text-slate-600 text-xs">—</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs text-slate-400 font-mono tabular-nums w-9 text-right">
        {clamped.toFixed(0)}%
      </span>
    </div>
  );
}

/**
 * Parse a pool URL like `stratum+tcp://alkimia.example.com:23334`
 * into its three human-readable pieces. Any part that can't be
 * extracted comes back null (the component renders "—" for missing
 * pieces). This is cosmetic-only — the copy button still copies the
 * original unparsed string.
 */
function splitPoolUrl(url: string): {
  scheme: string | null;
  host: string | null;
  port: string | null;
} {
  if (!url) return { scheme: null, host: null, port: null };
  const schemeMatch = /^([a-zA-Z][\w+.-]*):\/\//.exec(url);
  const scheme = schemeMatch ? schemeMatch[1] : null;
  const rest = schemeMatch ? url.slice(schemeMatch[0].length) : url;
  const [hostPart, portPart] = rest.split(':', 2);
  return {
    scheme: scheme ?? null,
    host: hostPart || null,
    port: portPart ? portPart.split('/')[0] || null : null,
  };
}

function Card({
  title,
  nextRefreshAtMs,
  badges,
  children,
}: {
  title: string;
  /** When set, renders a "refreshes in X" countdown in the header. */
  nextRefreshAtMs?: number | null;
  /** Optional reachability pills rendered under the title. */
  badges?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">{title}</div>
        {nextRefreshAtMs != null && (
          <div className="text-[11px] text-slate-500 font-mono">
            <RefreshCountdown nextAtMs={nextRefreshAtMs} />
          </div>
        )}
      </div>
      {badges && <div className="flex items-center gap-2 mb-2 flex-wrap">{badges}</div>}
      {children}
    </div>
  );
}

/**
 * Renders a pre-formatted value string (e.g. "45,662 sat/PH/day")
 * with the unit muted and the "sat" word replaced by the icon.
 * Use this anywhere a denomination-formatted string is rendered
 * outside of Row/FinanceRow/StatCard (which do their own splitting).
 */
function FormattedValue({ v, className = '' }: { v: string; className?: string }) {
  const split = splitUnit(v);
  if (!split) return <span className={className}>{v}</span>;
  return (
    <span className={className}>
      {split.num}
      <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
    </span>
  );
}

/**
 * Renders a unit string with "sat" replaced by the ₿-style sat
 * symbol icon. Handles "sat", "sat/PH/day", "PH/s" (no replacement
 * for non-sat units). Only applies in sats mode — USD values like
 * "$4.75/PH/day" don't match splitUnit so they render as plain text.
 */
function SatUnit({ unit }: { unit: string }) {
  if (unit.startsWith('sat')) {
    return (
      <>
        <SatSymbol className="opacity-70" />
        {unit.slice(3)}
      </>
    );
  }
  return <>{unit}</>;
}

/**
 * Key-value row used across all info cards. Detects trailing unit
 * suffixes (sat, PH/s, sat/PH/day) and renders them in a muted
 * smaller style so the number pops and the unit recedes — matching
 * the aesthetic the Money panel's FinanceRow already uses.
 */
function Row({ k, v }: { k: string; v: string }) {
  const split = splitUnit(v);
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-slate-400">{k}</span>
      <span className="text-slate-100 font-mono">
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
          </>
        ) : (
          v
        )}
      </span>
    </div>
  );
}

/**
 * Split a pre-formatted display value like "45,662 sat/PH/day" into
 * `{ num: "45,662", unit: "sat/PH/day" }` so the caller can render
 * the unit in a muted style. Also handles USD-denominated strings
 * like "$4.75/PH/day" (splits at the /PH/day suffix) and "$1.28 sat"
 * equivalents. Returns null for values without a recognised unit suffix.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  // Order matters: longest match first so "sat/PH/day" isn't
  // partially matched as "sat".
  // Also match USD-denominated /PH/day suffix (e.g. "$4.75/PH/day").
  const m = v.match(/^(.+?)\s+(sat\/PH\/day|PH\/s|PH·h|sat)(\s*(?:\(.*\))?)$/);
  if (m?.[1] && m[2]) return { num: m[1], unit: m[2] + (m[3] ?? '') };
  // USD with /PH/day suffix: "$4.75/PH/day" → { num: "$4.75", unit: "/PH/day" }
  const usdPhDay = v.match(/^(.+?)(\/PH\/day)$/);
  if (usdPhDay?.[1] && usdPhDay[2]) return { num: usdPhDay[1], unit: usdPhDay[2] };
  return null;
}

function ProposalLine({ p }: { p: ProposalView }) {
  const badge =
    p.executed === 'EXECUTED'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
      : p.executed === 'DRY_RUN'
        ? 'bg-sky-900/40 text-sky-300 border-sky-800'
        : p.executed === 'BLOCKED'
          ? 'bg-red-900/40 text-red-300 border-red-800'
          : 'bg-amber-900/40 text-amber-300 border-amber-800';
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <span className={`inline-block font-mono text-xs uppercase mr-2 border rounded px-1.5 ${badge}`}>
        {p.executed.toLowerCase().replace('_', ' ')}
      </span>
      <span className="text-slate-100">{p.summary}</span>
      {p.gate_reason && <span className="text-xs text-red-400 ml-2">({p.gate_reason})</span>}
    </div>
  );
}

function RunModeToggle({
  current,
  onChange,
  disabled,
}: {
  current: StatusResponse['run_mode'];
  onChange: (m: (typeof RUN_MODES)[number]) => void;
  disabled: boolean;
}) {
  return (
    <div className="inline-flex gap-1.5 bg-slate-950/70 border border-slate-800 rounded-xl p-1.5 mt-5">
      {RUN_MODES.map((m) => {
        const active = m === current;
        return (
          <button
            key={m}
            disabled={disabled || active}
            onClick={() => onChange(m)}
            className={
              'px-5 py-2.5 text-sm rounded-lg transition font-medium tracking-wide ' +
              (active
                ? 'bg-amber-400 text-slate-900'
                : 'text-slate-300 hover:bg-slate-800 disabled:opacity-50')
            }
          >
            {m.replace('_', ' ')}
          </button>
        );
      })}
    </div>
  );
}

// Silence linter — ModeBadge is imported for consistency elsewhere in the app.
void ModeBadge;