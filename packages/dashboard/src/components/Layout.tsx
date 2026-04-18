import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../lib/api';
import { clearPassword } from '../lib/auth';
import { useDenomination } from '../lib/denomination';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';
import { ModeBadge } from './ModeBadge';
import { SatSymbol } from './SatSymbol';

const NAV_ITEMS: Array<{ label: string; to: string }> = [
  { label: 'Status', to: '/' },
  { label: 'Decisions', to: '/decisions' },
  { label: 'Config', to: '/config' },
];

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  // Status powers the global header (mode badge + balance) on every
  // page. 30 s mirrors the Status-page polling cadence — header
  // figures don't need to be fresher than the page below them.
  const status = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 30_000,
  });

  const logout = () => {
    clearPassword();
    navigate('/login');
  };

  const primaryBalance = status.data?.balances?.[0];

  return (
    <div className="min-h-full flex flex-col">
      {/* Top bar: brand on the left, nav tabs in the middle, run-mode +
          balance + locale + sign-out on the right. Replaces the old
          left sidebar — the dashboard is dense enough that giving up
          ~14 rem of permanent left chrome to widen the work area
          makes a real difference, especially for the new vertical
          Money panel. */}
      <header className="bg-slate-900 border-b border-slate-800 sticky top-0 z-20 backdrop-blur">
        <div className="px-4 sm:px-6 flex flex-wrap items-center gap-x-6 gap-y-2 py-2">
          <div className="flex items-center gap-3 mr-4">
            <div className="text-amber-400 font-semibold leading-tight">Braiins</div>
            <div className="text-[11px] text-slate-500 leading-tight">Hashrate&nbsp;Autopilot</div>
          </div>

          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
              const active =
                item.to === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={
                    'px-3 py-1.5 text-sm rounded-md transition ' +
                    (active
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-300 hover:bg-slate-800/60')
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3 ml-auto text-xs">
            <DenominationToggle />

            {/* Number/date format picker moved to Config → Display
                so it's a one-time preference, not a piece of permanent
                header chrome. The "Nederlands" label dropping out of
                an English UI was misleading anyway — i18n proper is
                #1, not done yet. */}
            <button
              onClick={logout}
              className="px-2 py-1 text-[11px] text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
            >
              sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto">
        {/* Use the full viewport width — the operator runs this
            full-screen on a desktop and earlier max-w-[1600px] left a
            visible empty bar on the right on wider monitors. Side
            padding only. */}
        <div className="p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
      <footer className="text-center text-[10px] text-slate-600 py-1">
        build {__BUILD_NUMBER__} · {__BUILD_HASH__}
      </footer>
    </div>
  );
}

/**
 * Segmented "sats | USD" toggle. Hidden when btcPrice is null (source
 * is 'none' or API down) — when there's no price, the toggle makes no
 * sense and showing it would be misleading.
 */
function DenominationToggle() {
  const { mode, toggle, btcPrice } = useDenomination();
  if (btcPrice === null) return null;

  return (
    <button
      onClick={toggle}
      className="inline-flex items-center border border-slate-700 rounded-md overflow-hidden text-[11px] leading-none"
      title={`BTC/USD: $${btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })} — click to toggle denomination`}
    >
      <span
        className={
          'px-2 py-1 transition ' +
          (mode === 'sats'
            ? 'bg-amber-400 text-slate-900 font-medium'
            : 'text-slate-400 hover:bg-slate-800')
        }
      >
        <SatSymbol /> sats
      </span>
      <span
        className={
          'px-2 py-1 transition ' +
          (mode === 'usd'
            ? 'bg-amber-400 text-slate-900 font-medium'
            : 'text-slate-400 hover:bg-slate-800')
        }
      >
        USD
      </span>
    </button>
  );
}
