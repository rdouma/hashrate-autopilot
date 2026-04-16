import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../lib/api';
import { clearPassword } from '../lib/auth';
import { formatNumber } from '../lib/format';
import { LOCALE_PRESETS, useLocale } from '../lib/locale';
import { ModeBadge } from './ModeBadge';

const NAV_ITEMS: Array<{ label: string; to: string }> = [
  { label: 'Status', to: '/' },
  { label: 'Decisions', to: '/decisions' },
  { label: 'Config', to: '/config' },
];

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { selected, setSelected, intlLocale } = useLocale();

  // Status query powers the global header (mode badge + balance). Polls
  // every 5s on every page, including Config and Decisions.
  const status = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 5000,
  });

  const logout = () => {
    clearPassword();
    navigate('/login');
  };

  const primaryBalance = status.data?.balances?.[0];

  return (
    <div className="min-h-full flex">
      <aside className="w-56 bg-slate-900 border-r border-slate-800 flex flex-col">
        <div className="px-4 py-5 border-b border-slate-800">
          <div className="text-amber-400 font-semibold">Braiins</div>
          <div className="text-xs text-slate-400">Hashrate Autopilot</div>
        </div>
        <nav className="flex-1 py-3">
          {NAV_ITEMS.map((item) => {
            const active = item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={
                  'block px-4 py-2 text-sm ' +
                  (active
                    ? 'bg-slate-800 text-amber-400 border-l-2 border-amber-400'
                    : 'text-slate-300 hover:bg-slate-800/60')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-3 pb-2">
          <label className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            display locale
          </label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded text-xs text-slate-100 px-2 py-1"
          >
            {LOCALE_PRESETS.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={logout}
          className="m-3 px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
        >
          sign out
        </button>
      </aside>
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-slate-800 bg-slate-950/80 backdrop-blur px-6 py-3">
          <div className="flex items-center gap-3">
            {status.data ? (
              <ModeBadge runMode={status.data.run_mode} />
            ) : (
              <span className="text-xs text-slate-500">loading…</span>
            )}
            {status.data && (
              <span className="text-xs text-slate-500">
                action: <span className="text-slate-300">{status.data.action_mode}</span>
              </span>
            )}
          </div>
          <div className="text-right text-xs">
            {primaryBalance ? (
              <>
                <div className="text-slate-400">
                  available{' '}
                  <span className="text-slate-100 font-mono">
                    {formatNumber(primaryBalance.available_balance_sat, {}, intlLocale)}
                  </span>{' '}
                  sat
                </div>
                <div className="text-slate-500">
                  blocked{' '}
                  {formatNumber(primaryBalance.blocked_balance_sat, {}, intlLocale)} · total{' '}
                  {formatNumber(primaryBalance.total_balance_sat, {}, intlLocale)}
                </div>
              </>
            ) : (
              <span className="text-slate-500">—</span>
            )}
          </div>
        </header>
        <div className="flex-1 p-6 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
