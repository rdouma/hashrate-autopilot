import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, UnauthorizedError, type DecisionDetail, type DecisionSummary } from '../lib/api';
import {
  formatAge,
  formatHashratePH,
  formatSatPerPH,
  formatSats,
  formatTimestamp,
} from '../lib/format';

type ModeFilter = 'ALL' | 'LIVE' | 'DRY_RUN' | 'PAUSED';

export function Decisions() {
  const navigate = useNavigate();
  const [showEmpty, setShowEmpty] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [modeFilter, setModeFilter] = useState<ModeFilter>('ALL');

  const list = useQuery({
    queryKey: ['decisions', modeFilter],
    queryFn: () =>
      api.decisions(2000, modeFilter === 'ALL' ? undefined : modeFilter),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: ['decision', selectedId],
    queryFn: () => api.decision(selectedId!),
    enabled: selectedId !== null,
  });

  const filtered = useMemo(() => {
    if (!list.data) return [];
    return showEmpty ? list.data : list.data.filter((r) => r.proposal_count > 0);
  }, [list.data, showEmpty]);

  // Auto-select the most recent non-empty tick once data arrives.
  const firstMatchId = filtered[0]?.id ?? null;
  if (selectedId === null && firstMatchId !== null) {
    setSelectedId(firstMatchId);
  }

  if (list.isError && list.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl text-slate-100">Decisions</h2>
        <div className="flex items-center gap-4">
          <div className="flex gap-1 bg-slate-900 border border-slate-800 rounded p-1 text-xs">
            {(['ALL', 'LIVE', 'DRY_RUN', 'PAUSED'] as const).map((m) => {
              const active = m === modeFilter;
              return (
                <button
                  key={m}
                  onClick={() => {
                    setSelectedId(null);
                    setModeFilter(m);
                  }}
                  className={
                    'px-2.5 py-1 rounded ' +
                    (active
                      ? 'bg-amber-400 text-slate-900 font-medium'
                      : 'text-slate-300 hover:bg-slate-800')
                  }
                >
                  {m === 'DRY_RUN' ? 'Dry run' : m.charAt(0) + m.slice(1).toLowerCase()}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
              className="accent-amber-400"
            />
            show empty ticks
          </label>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4 min-h-0">
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden max-h-[70vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 bg-slate-900 sticky top-0 z-10">
              <tr>
                <th className="text-left py-2 px-3">tick</th>
                <th className="text-left py-2 px-3">mode</th>
                <th className="text-right py-2 px-3">#</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  className={
                    'border-t border-slate-800 cursor-pointer ' +
                    (selectedId === row.id ? 'bg-slate-800/80' : 'hover:bg-slate-800/40')
                  }
                >
                  <td className="py-1.5 px-3">
                    <div className="text-slate-200">{formatTimestamp(row.tick_at)}</div>
                    <div className="text-xs text-slate-500">{formatAge(row.tick_at)}</div>
                  </td>
                  <td className="py-1.5 px-3 text-xs">
                    {row.run_mode}/{row.action_mode}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono">
                    {row.proposal_count === 0 ? (
                      <span className="text-slate-600">–</span>
                    ) : (
                      <span className="text-amber-400">{row.proposal_count}</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-6 text-center text-slate-500">
                    {showEmpty ? 'no decisions recorded yet' : 'no ticks with proposals yet'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 min-h-[60vh] overflow-auto">
          {selectedId === null || detail.isLoading ? (
            <div className="text-slate-500 text-sm">select a tick on the left</div>
          ) : !detail.data ? (
            <div className="text-red-400 text-sm">failed to load</div>
          ) : (
            <DecisionDetailView d={detail.data} listRow={filtered.find((r) => r.id === selectedId)} />
          )}
        </div>
      </div>
    </div>
  );
}

type ProposedEntry =
  | { kind: 'CREATE_BID'; price_sat: number; amount_sat: number; speed_limit_ph: number; reason: string }
  | { kind: 'EDIT_PRICE'; braiins_order_id: string; old_price_sat: number; new_price_sat: number; reason: string }
  | { kind: 'CANCEL_BID'; braiins_order_id: string; reason: string }
  | { kind: 'PAUSE'; reason: string };

type GatedEntry = {
  proposal: ProposedEntry;
  allowed: boolean;
  reason?: string;
};

type ExecutedEntry = {
  proposal: ProposedEntry;
  outcome: 'DRY_RUN' | 'EXECUTED' | 'BLOCKED' | 'FAILED';
  note?: string;
  reason?: string;
  error?: string;
};

const EH_PER_PH = 1000;

function DecisionDetailView({ d, listRow }: { d: DecisionDetail; listRow?: DecisionSummary }) {
  const proposed = (d.proposed as ProposedEntry[]) ?? [];
  const gated = (d.gated as GatedEntry[]) ?? [];
  const executed = (d.executed as ExecutedEntry[]) ?? [];
  const observed = (d.observed as {
    market?: { best_bid_sat: number | null; best_ask_sat: number | null };
    actual_hashrate?: { total_ph: number };
    config?: { max_bid_sat_per_eh_day: number };
  }) ?? {};

  return (
    <div className="space-y-4">
      <header>
        <div className="text-slate-100 text-lg">
          tick #{d.id} · {formatTimestamp(d.tick_at)}
        </div>
        <div className="text-xs text-slate-500">
          {d.run_mode}/{d.action_mode} · {listRow?.proposal_count ?? proposed.length} proposals ·{' '}
          <span className="ml-1">{formatAge(d.tick_at)}</span>
        </div>
      </header>

      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-500 mb-2">Market snapshot</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
          <Stat
            k="best bid"
            v={formatSatPerPH(observed.market?.best_bid_sat ? observed.market.best_bid_sat / EH_PER_PH : null)}
          />
          <Stat
            k="best ask"
            v={formatSatPerPH(observed.market?.best_ask_sat ? observed.market.best_ask_sat / EH_PER_PH : null)}
          />
          <Stat
            k="actual hashrate"
            v={
              observed.actual_hashrate
                ? formatHashratePH(observed.actual_hashrate.total_ph)
                : '—'
            }
          />
        </div>
      </section>

      {proposed.length === 0 ? (
        <section className="text-slate-500 text-sm">No proposals on this tick.</section>
      ) : (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-slate-500 mb-2">
            Proposals ({proposed.length})
          </h3>
          <ul className="space-y-2">
            {proposed.map((p, i) => (
              <li key={i} className="bg-slate-950 border border-slate-800 rounded p-3">
                <ProposalRow proposal={p} gated={gated[i]} executed={executed[i]} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
          raw JSON (debug)
        </summary>
        <pre className="mt-2 text-slate-400 whitespace-pre-wrap break-words">
          {JSON.stringify(d, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ProposalRow({
  proposal,
  gated,
  executed,
}: {
  proposal: ProposedEntry;
  gated?: GatedEntry;
  executed?: ExecutedEntry;
}) {
  const outcome = executed?.outcome ?? 'DRY_RUN';
  const badgeColor =
    outcome === 'EXECUTED'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
      : outcome === 'DRY_RUN'
        ? 'bg-sky-900/40 text-sky-300 border-sky-800'
        : outcome === 'BLOCKED'
          ? 'bg-red-900/40 text-red-300 border-red-800'
          : 'bg-amber-900/40 text-amber-300 border-amber-800';

  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <span className={`text-xs font-mono uppercase border rounded px-1.5 py-0.5 ${badgeColor}`}>
          {outcome}
        </span>
        <span className="text-slate-200 font-medium">{proposal.kind.replace('_', ' ')}</span>
      </div>
      <div className="text-sm text-slate-300">{describeProposal(proposal)}</div>
      <div className="text-xs text-slate-500">reason: {proposal.reason}</div>
      {gated && !gated.allowed && (
        <div className="text-xs text-red-400">blocked by gate: {gated.reason}</div>
      )}
      {executed?.note && <div className="text-xs text-slate-400">→ {executed.note}</div>}
      {executed?.error && <div className="text-xs text-red-400">error: {executed.error}</div>}
    </div>
  );
}

function describeProposal(p: ProposedEntry): string {
  switch (p.kind) {
    case 'CREATE_BID':
      return `CREATE bid at ${formatSatPerPH(p.price_sat / EH_PER_PH)}, speed ${p.speed_limit_ph} PH/s, ${formatSats(p.amount_sat)} budget`;
    case 'EDIT_PRICE':
      return `EDIT ${p.braiins_order_id.slice(0, 8)}… price ${formatSatPerPH(p.old_price_sat / EH_PER_PH)} → ${formatSatPerPH(p.new_price_sat / EH_PER_PH)}`;
    case 'CANCEL_BID':
      return `CANCEL ${p.braiins_order_id.slice(0, 8)}…`;
    case 'PAUSE':
      return `PAUSE the autopilot`;
  }
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{k}</div>
      <div className="text-slate-100 font-mono text-sm">{v}</div>
    </div>
  );
}
