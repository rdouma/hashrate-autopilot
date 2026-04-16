import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { HashrateChart } from '../components/HashrateChart';
import { ModeBadge } from '../components/ModeBadge';
import {
  api,
  UnauthorizedError,
  type PayoutsResponse,
  type ProposalView,
  type StatusResponse,
} from '../lib/api';
import {
  formatAge,
  formatHashratePH,
  formatNumber,
  formatSatPerPH,
  formatSats,
  formatTimestamp,
  formatTimestampUtc,
} from '../lib/format';
import { actionModeLabel, bidStatusClass, bidStatusLabel } from '../lib/labels';
import { useLocale } from '../lib/locale';

const RUN_MODES = ['DRY_RUN', 'LIVE', 'PAUSED'] as const;

export function Status() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();

  const query = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 5000,
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

  const bumpMutation = useMutation({
    mutationFn: () => api.bumpPrice(),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['status'] });
      qc.invalidateQueries({ queryKey: ['decisions'] });
    },
  });

  const metricsQuery = useQuery({
    queryKey: ['metrics', '6h'],
    queryFn: () => api.metrics(Date.now() - 6 * 60 * 60 * 1000),
    refetchInterval: 15_000,
  });

  const payoutsQuery = useQuery({
    queryKey: ['payouts'],
    queryFn: api.payouts,
    refetchInterval: 60_000,
  });

  const scanPayoutsMutation = useMutation({
    mutationFn: () => api.scanPayouts(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['payouts'] }),
  });

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
    <div className="space-y-5 max-w-6xl">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="text-2xl text-slate-100">Status</h2>
          <div className="text-xs text-slate-500">
            last tick: {formatTimestamp(s.tick_at)} ({formatAge(s.tick_at)})
          </div>
        </div>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <OperationsCard
          s={s}
          onRunMode={(m) => runModeMutation.mutate(m)}
          runModePending={runModeMutation.isPending}
        />
        <div className="lg:col-span-2">
          <NextActionCard
            s={s}
            onTickNow={() => tickNowMutation.mutate()}
            tickPending={tickNowMutation.isPending}
            tickResult={tickNowMutation.data}
            onBump={() => bumpMutation.mutate()}
            bumpPending={bumpMutation.isPending}
            bumpResult={bumpMutation.data}
            escalationStepSatPerPh={s.config_summary.fill_escalation_step_sat_per_ph_day}
          />
        </div>
      </section>

      {metricsQuery.data && metricsQuery.data.points.length > 0 && (
        <HashrateChart points={metricsQuery.data.points} />
      )}

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <Card title="Hashrate & market">
          <Row k="delivered" v={formatHashratePH(s.actual_hashrate_ph)} />
          <Row k="target" v={formatHashratePH(s.config_summary.target_hashrate_ph)} />
          <Row k="floor" v={formatHashratePH(s.config_summary.minimum_floor_hashrate_ph)} />
          {s.below_floor_since && (
            <div className="text-xs text-amber-400 mt-1">
              below floor since {formatAge(s.below_floor_since)}
            </div>
          )}
          <div className="border-t border-slate-800 mt-2 pt-2">
            <Row k="best bid" v={formatSatPerPH(s.market?.best_bid_sat_per_ph_day ?? null)} />
            <Row k="best ask" v={formatSatPerPH(s.market?.best_ask_sat_per_ph_day ?? null)} />
          </div>
        </Card>
        <Card title="Braiins balance">
          {s.balances.length === 0 ? (
            <div className="text-slate-500 text-sm">—</div>
          ) : (
            s.balances.map((b) => (
              <div key={b.subaccount}>
                <Row k="available" v={formatSats(b.available_balance_sat)} />
                <Row k="blocked" v={formatSats(b.blocked_balance_sat)} />
                <Row k="total" v={formatSats(b.total_balance_sat)} />
              </div>
            ))
          )}
        </Card>
        <CollectedBtcCard
          data={payoutsQuery.data}
          onRescan={() => scanPayoutsMutation.mutate()}
          rescanPending={scanPayoutsMutation.isPending}
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <PoolCard
          url={s.config_summary.pool_url}
          reachable={s.pool.reachable}
          consecutiveFailures={s.pool.consecutive_failures}
          lastOkAt={s.pool.last_ok_at}
        />
        <Card title="Caps">
          <Row k="normal" v={formatSatPerPH(s.config_summary.max_price_sat_per_ph_day)} />
          <Row k="emergency" v={formatSatPerPH(s.config_summary.emergency_max_price_sat_per_ph_day)} />
          <Row k="budget" v={formatSats(s.config_summary.bid_budget_sat)} />
        </Card>
      </section>

      <section>
        <h3 className="text-sm text-slate-400 mb-2">Bids</h3>
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
                    <td className="py-2 px-3 font-mono text-xs">
                      {b.braiins_order_id.slice(0, 10)}…
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
                    <td className="py-2 px-3 text-right">
                      {formatSatPerPH(b.price_sat_per_ph_day)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatHashratePH(b.avg_speed_ph)}
                      <span className="text-xs text-slate-500">
                        {' '}
                        / {b.speed_limit_ph ? formatHashratePH(b.speed_limit_ph) : '∞'}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">
                      {formatNumber(b.amount_sat, {}, intlLocale)}
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

      {s.last_proposals.length > 0 && (
        <section>
          <h3 className="text-sm text-slate-400 mb-2">Last tick proposals</h3>
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

function OperationsCard({
  s,
  onRunMode,
  runModePending,
}: {
  s: StatusResponse;
  onRunMode: (m: (typeof RUN_MODES)[number]) => void;
  runModePending: boolean;
}) {
  const heroColors: Record<StatusResponse['run_mode'], string> = {
    DRY_RUN: 'from-sky-900/60 to-sky-950/40 border-sky-700/40',
    LIVE: 'from-emerald-900/60 to-emerald-950/40 border-emerald-700/40',
    PAUSED: 'from-amber-900/60 to-amber-950/40 border-amber-700/40',
  };
  const heroLabels: Record<StatusResponse['run_mode'], string> = {
    DRY_RUN: 'DRY RUN',
    LIVE: 'LIVE',
    PAUSED: 'PAUSED',
  };
  const heroTextColors: Record<StatusResponse['run_mode'], string> = {
    DRY_RUN: 'text-sky-200',
    LIVE: 'text-emerald-200',
    PAUSED: 'text-amber-200',
  };

  const actionVisible = s.action_mode !== 'NORMAL';

  return (
    <section
      className={`bg-gradient-to-br ${heroColors[s.run_mode]} border rounded-xl p-5 h-full flex flex-col justify-center`}
    >
      <div className={`text-4xl font-semibold tracking-wide ${heroTextColors[s.run_mode]}`}>
        {heroLabels[s.run_mode]}
      </div>
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

function NextActionCard({
  s,
  onTickNow,
  tickPending,
  tickResult,
  onBump,
  bumpPending,
  bumpResult,
  escalationStepSatPerPh,
}: {
  s: StatusResponse;
  onTickNow: () => void;
  tickPending: boolean;
  tickResult: { ok: boolean; error?: string; proposals?: number } | undefined;
  onBump: () => void;
  bumpPending: boolean;
  bumpResult:
    | { ok: boolean; error?: string; new_price_sat_per_eh_day?: number }
    | undefined;
  escalationStepSatPerPh: number;
}) {
  const secondsUntilTick = s.next_tick_at
    ? Math.max(0, Math.round((s.next_tick_at - Date.now()) / 1000))
    : null;

  const canBump = s.run_mode === 'LIVE' && s.bids.some((b) => b.is_owned);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <h3 className="text-xs uppercase tracking-wider text-slate-400 mb-1">Next action</h3>
          <div className="text-slate-100">{s.next_action.summary}</div>
          {s.next_action.detail && (
            <div className="text-xs text-slate-400 mt-1">{s.next_action.detail}</div>
          )}
        </div>
        <div className="text-right text-xs">
          <div className="text-slate-500">last tick</div>
          <div className="text-slate-300">{formatTimestamp(s.tick_at)}</div>
          <div className="text-[11px] text-slate-500">{formatTimestampUtc(s.tick_at)}</div>
          <div className="text-slate-500 mt-1">
            next in ≤ {secondsUntilTick !== null ? secondsUntilTick : '?'}s
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={onTickNow}
          disabled={tickPending}
          className="px-3 py-1.5 text-xs rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
        >
          {tickPending ? 'ticking…' : 'Run decision now'}
        </button>
        <button
          onClick={onBump}
          disabled={bumpPending || !canBump}
          title={
            canBump
              ? 'Raise our bid price by one escalation step'
              : 'Requires LIVE mode with an owned bid'
          }
          className="px-3 py-1.5 text-xs rounded border border-amber-800 text-amber-200 hover:bg-amber-900/40 disabled:opacity-50"
        >
          {bumpPending
            ? 'bumping…'
            : `Bump price +${formatNumber(escalationStepSatPerPh)} sat/PH/day`}
        </button>
        <span className="text-xs text-slate-500 self-center">
          Manual overrides — use when you want action sooner than the tick cadence.
        </span>
      </div>

      {tickResult && (
        <div
          className={
            'mt-2 text-xs ' + (tickResult.ok ? 'text-emerald-300' : 'text-red-400')
          }
        >
          {tickResult.ok
            ? `tick ok — ${tickResult.proposals ?? 0} proposals`
            : `tick failed: ${tickResult.error}`}
        </div>
      )}
      {bumpResult && (
        <div
          className={
            'mt-2 text-xs ' + (bumpResult.ok ? 'text-emerald-300' : 'text-red-400')
          }
        >
          {bumpResult.ok
            ? `price bumped to ${Math.round(
                (bumpResult.new_price_sat_per_eh_day ?? 0) / 1000,
              ).toLocaleString()} sat/PH/day`
            : `bump failed: ${bumpResult.error}`}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function CollectedBtcCard({
  data,
  onRescan,
  rescanPending,
}: {
  data: PayoutsResponse | undefined;
  onRescan: () => void;
  rescanPending: boolean;
}) {
  const hasScan = data?.checked_at !== null && data?.checked_at !== undefined;
  const hasError = !!data?.last_error;
  const amountSat = data?.total_unspent_sat;
  const source = data?.source;

  return (
    <Card title="Collected BTC (on-chain)">
      <div className="text-2xl font-mono text-emerald-300">
        {amountSat !== null && amountSat !== undefined ? formatSats(amountSat) : '—'}
      </div>
      <div className="text-xs text-slate-500 mt-1">
        {hasScan ? (
          <>
            {source === 'electrs' ? (
              <span className="text-sky-400">via Electrs</span>
            ) : source === 'bitcoind' ? (
              <span className="text-amber-400">via bitcoind</span>
            ) : null}
            {source && ' · '}
            checked {formatAge(data.checked_at)}
            {source === 'bitcoind' && data.scanned_block_height !== null && (
              <> · block {data.scanned_block_height}</>
            )}
          </>
        ) : (
          'waiting for first scan…'
        )}
      </div>
      {hasError && (
        <div className="text-xs text-amber-400 mt-1">
          last scan issue: {data.last_error}
        </div>
      )}
      <button
        onClick={onRescan}
        disabled={rescanPending}
        className="mt-2 px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
      >
        {rescanPending ? 'scanning…' : 'rescan now'}
      </button>
    </Card>
  );
}

function PoolCard({
  url,
  reachable,
  consecutiveFailures,
  lastOkAt,
}: {
  url: string;
  reachable: boolean;
  consecutiveFailures: number;
  lastOkAt: number | null;
}) {
  const [copied, setCopied] = useState(false);
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
    <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">Pool</div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className={
            'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ' +
            (reachable
              ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
              : 'border-red-700 bg-red-900/30 text-red-300')
          }
        >
          <span
            className={
              'w-1.5 h-1.5 rounded-full ' + (reachable ? 'bg-emerald-400' : 'bg-red-400')
            }
          />
          {reachable ? 'reachable' : `DOWN (${consecutiveFailures} consecutive)`}
        </span>
        <span className="text-xs text-slate-500">last ok: {formatAge(lastOkAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-sm text-slate-300 font-mono break-all flex-1">{url}</div>
        <button
          onClick={copy}
          title="Copy pool URL to clipboard"
          className="shrink-0 px-2 py-1 text-xs rounded border border-slate-700 text-slate-300 hover:bg-slate-800"
        >
          {copied ? '✓ copied' : 'copy'}
        </button>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-400 mb-2">{title}</div>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-slate-400">{k}</span>
      <span className="text-slate-100 font-mono">{v}</span>
    </div>
  );
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
    <div className="flex gap-1 bg-slate-950/70 border border-slate-800 rounded-lg p-1 mt-3">
      {RUN_MODES.map((m) => {
        const active = m === current;
        return (
          <button
            key={m}
            disabled={disabled || active}
            onClick={() => onChange(m)}
            className={
              'px-3 py-1.5 text-xs rounded transition ' +
              (active
                ? 'bg-amber-400 text-slate-900 font-medium'
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
