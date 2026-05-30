import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { api, type AlertRow } from '../lib/api';
import { clearPassword } from '../lib/auth';
import { useBlockFoundSound } from '../lib/block-found-sound';
import { useDenomination } from '../lib/denomination';
import { formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';
import { LanguagePicker } from './LanguagePicker';
import { BtcSymbol } from './BtcSymbol';
import { ModeBadge } from './ModeBadge';
import { SatSymbol } from './SatSymbol';
import { ToastStack } from './ToastStack';

const TOAST_LAST_SEEN_KEY = 'hashrate-autopilot.alertsLastToastId';

// Nav items are translated at render time. Using `t\`...\`` inside the
// component (rather than at module load) so the active locale wins -
// otherwise the first-render snapshot would freeze in whatever locale
// was active when the module was imported.
function useNavItems() {
  const { i18n } = useLingui();
  // i18n is referenced so the hook re-runs on locale change; the
  // template tag picks up the active catalog implicitly.
  void i18n;
  return [
    { label: t`Status`, to: '/' },
    { label: t`Alerts`, to: '/alerts' },
    { label: t`Config`, to: '/config' },
  ];
}

export function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const navItems = useNavItems();

  // Status powers the global header (mode badge + balance) on every
  // page. 30 s mirrors the Status-page polling cadence - header
  // figures don't need to be fresher than the page below them.
  const status = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 30_000,
  });

  // #100 + #142: dual-purpose query. The badge count comes from the
  // server-computed `unacknowledged_high_severity_count` (independent
  // of any filter), and the freshly-fetched `alerts[]` list feeds the
  // toast-stack detector below. We drop the unack-only filter and
  // bump limit so a burst of arrivals between polls (rare, but
  // possible) all surface as toasts.
  const alertsHead = useQuery({
    queryKey: ['alerts-head'],
    queryFn: () => api.alertsList({ limit: 10 }),
    refetchInterval: 30_000,
  });
  const unreadCount = alertsHead.data?.unacknowledged_high_severity_count ?? 0;

  // #142: in-dashboard toast stack. Tracks the max alert id we've
  // already shown a toast for via localStorage so a page reload doesn't
  // replay every recent alert as a fresh toast. The very first
  // successful poll baselines without firing any toast.
  const [toasts, setToasts] = useState<AlertRow[]>([]);
  const lastSeenIdRef = useRef<number | null>(null);
  useEffect(() => {
    const stored = window.localStorage.getItem(TOAST_LAST_SEEN_KEY);
    lastSeenIdRef.current = stored !== null ? Number.parseInt(stored, 10) : null;
  }, []);
  useEffect(() => {
    const alerts = alertsHead.data?.alerts;
    if (!alerts || alerts.length === 0) return;
    const maxId = alerts.reduce((acc, a) => (a.id > acc ? a.id : acc), 0);
    if (lastSeenIdRef.current === null) {
      // First mount baseline: capture the watermark, no toasts.
      lastSeenIdRef.current = maxId;
      window.localStorage.setItem(TOAST_LAST_SEEN_KEY, String(maxId));
      return;
    }
    if (maxId <= lastSeenIdRef.current) return;
    const cutoff = lastSeenIdRef.current;
    // Push newest-last so the stack grows from the top, matching
    // ToastStack's bottom-aligned visual order.
    const fresh = alerts
      .filter((a) => a.id > cutoff)
      .sort((a, b) => a.id - b.id);
    if (fresh.length === 0) return;
    setToasts((prev) => [...prev, ...fresh]);
    lastSeenIdRef.current = maxId;
    window.localStorage.setItem(TOAST_LAST_SEEN_KEY, String(maxId));
  }, [alertsHead.data]);

  const dismissToast = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));
  const activateToast = (id: number) => {
    dismissToast(id);
    navigate('/alerts');
  };

  // #103: poll the daemon's running build number and surface a
  // banner when the dashboard's embedded copy lags behind. Without
  // this an open tab keeps running stale code forever after deploy
  // because client-side routing never re-fetches the HTML shell.
  const buildInfo = useQuery({
    queryKey: ['build-info'],
    queryFn: api.build,
    refetchInterval: 60_000,
  });
  const newBuildAvailable =
    buildInfo.data && buildInfo.data.build > __BUILD_NUMBER__;

  // Audible block-found cue (#88). Reads the operator's choice from
  // the live config; pollster lives inside the hook.
  const config = useQuery({
    queryKey: ['config'],
    queryFn: api.config,
  });
  useBlockFoundSound(config.data?.config.block_found_sound);

  const logout = () => {
    clearPassword();
    navigate('/login');
  };

  const primaryBalance = status.data?.balances?.[0];

  return (
    <div className="min-h-full flex flex-col">
      {/* Sticky cluster: upgrade banner + top nav. Wrapped together so
          both stay pinned at the top of the viewport on scroll. The
          banner only renders when a newer build is available; in that
          case the header sits below it within the same sticky region.
          Without the wrapper, the banner would scroll away while the
          header stayed pinned - operator misses the upgrade prompt as
          soon as they scroll into the charts. */}
      <div className="sticky top-0 z-30">
        {newBuildAvailable && buildInfo.data && (
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-amber-400 text-slate-900 text-sm py-2 px-4 text-center hover:bg-amber-300 transition cursor-pointer flex items-center justify-center gap-2"
          >
            <span>
              <Trans>
                New version available (build {__BUILD_NUMBER__} → {buildInfo.data.build}).
              </Trans>
            </span>
            <span className="font-semibold underline">
              <Trans>Refresh</Trans>
            </span>
          </button>
        )}
        {/* Top bar: brand on the left, nav tabs in the middle, run-mode +
            balance + locale + sign-out on the right. Replaces the old
            left sidebar - the dashboard is dense enough that giving up
            ~14 rem of permanent left chrome to widen the work area
            makes a real difference, especially for the new vertical
            Money panel. */}
        <header className="bg-slate-900 border-b border-slate-800 backdrop-blur">
        <div className="px-4 sm:px-6 flex flex-wrap items-center gap-x-6 gap-y-2 py-2">
          <div className="flex items-center gap-3 mr-4">
            <div className="text-amber-400 font-semibold leading-tight">Hashrate Autopilot</div>
          </div>

          <nav className="flex items-center gap-1">
            {navItems.map((item) => {
              const active =
                item.to === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.to);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={
                    'px-3 py-1.5 text-sm rounded-md transition relative ' +
                    (active
                      ? 'bg-slate-800 text-amber-400'
                      : 'text-slate-300 hover:bg-slate-800/60')
                  }
                >
                  {item.label}
                  {item.to === '/alerts' && unreadCount > 0 && (
                    <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 text-[10px] font-medium rounded-full bg-red-500 text-white align-middle">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/* Inline cluster on >= sm screens. Below that it overflows
              the viewport; the hamburger picks up the same controls
              from a dropdown so the top bar stays single-row on
              mobile with only Status/Alerts/Config visible. */}
          <div className="hidden sm:flex items-center gap-3 ml-auto text-xs">
            <HashrateUnitToggle />
            <DenominationToggle />
            <LanguagePicker />
            <button
              onClick={logout}
              className="px-2 py-1 text-[11px] text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
            >
              <Trans>sign out</Trans>
            </button>
          </div>

          <div className="sm:hidden ml-auto">
            <MobileMenu onSignOut={logout} />
          </div>
        </div>
        </header>
      </div>

      <main className="flex-1 overflow-auto">
        {/* Use the full viewport width - the operator runs this
            full-screen on a desktop and earlier max-w-[1600px] left a
            visible empty bar on the right on wider monitors. Side
            padding only. */}
        <div className="p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
      <footer className="text-center text-[10px] text-slate-600 py-1">
        v{__APP_VERSION__} · build {__BUILD_NUMBER__} · {__BUILD_HASH__} ·{' '}
        <a
          href="https://github.com/rdouma/hashrate-autopilot/blob/main/CHANGELOG.md"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted hover:text-slate-400"
        >
          <Trans>changelog</Trans>
        </a>
      </footer>
      <ToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        onActivate={activateToast}
      />
    </div>
  );
}

/**
 * Mobile-only hamburger that holds the unit/currency/language/sign-out
 * cluster. The desktop header has these inline; on viewports below
 * `sm` the inline cluster overflows the right edge (the operator
 * caught it on iPhone Safari), so they collapse into a popover here.
 *
 * Click-outside dismisses the popover; opening it does not block
 * scroll, since the page underneath stays useful.
 */
function MobileMenu({ onSignOut }: { onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t`menu`}
        aria-expanded={open}
        className="px-2 py-1.5 text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
      >
        {/* Three-bar hamburger icon. Rendered as SVG so it scales
            with the surrounding font-size and respects currentColor. */}
        <svg
          width="18"
          height="14"
          viewBox="0 0 18 14"
          aria-hidden="true"
          className="block"
        >
          <rect width="18" height="2" rx="1" fill="currentColor" />
          <rect y="6" width="18" height="2" rx="1" fill="currentColor" />
          <rect y="12" width="18" height="2" rx="1" fill="currentColor" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-lg shadow-lg p-3 z-30 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              <Trans>hashrate unit</Trans>
            </div>
            <HashrateUnitToggle />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              <Trans>denomination</Trans>
            </div>
            <DenominationToggle />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              <Trans>language</Trans>
            </div>
            <LanguagePicker />
          </div>
          <button
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="w-full px-2 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
          >
            <Trans>sign out</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Segmented "sats | BTC | USD" toggle. USD slot is hidden when
 * btcPrice is null (source is 'none' or API down) - showing it
 * without an oracle would be misleading. BTC <-> sat is a static
 * conversion so it stays available regardless.
 */
function DenominationToggle() {
  const { mode, setMode, btcPrice } = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const priceStr = btcPrice
    ? btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : null;
  const titleText = priceStr
    ? t`BTC/USD: $${priceStr} - select display currency`
    : t`Select display currency`;

  return (
    <div
      className="inline-flex items-center border border-slate-700 rounded-md overflow-hidden text-[11px] leading-none"
      title={titleText}
    >
      <button
        onClick={() => setMode('sats')}
        className={
          'px-2 py-1 transition ' +
          (mode === 'sats'
            ? 'bg-amber-400 text-slate-900 font-medium'
            : 'text-slate-400 hover:bg-slate-800')
        }
      >
        <SatSymbol /> <Trans>sats</Trans>
      </button>
      <button
        onClick={() => setMode('btc')}
        className={
          'px-2 py-1 transition border-l border-slate-700 ' +
          (mode === 'btc'
            ? 'bg-amber-400 text-slate-900 font-medium'
            : 'text-slate-400 hover:bg-slate-800')
        }
      >
        <BtcSymbol /> BTC
      </button>
      {btcPrice !== null && (
        <button
          onClick={() => setMode('usd')}
          className={
            'px-2 py-1 transition border-l border-slate-700 ' +
            (mode === 'usd'
              ? 'bg-amber-400 text-slate-900 font-medium'
              : 'text-slate-400 hover:bg-slate-800')
          }
        >
          USD
        </button>
      )}
    </div>
  );
}

/**
 * Segmented "TH | PH | EH" toggle for the hashrate unit. Affects every
 * hashrate display and per-hashrate-per-day rate across the dashboard.
 * Internal storage stays in PH/s (canonical schema unit); this toggle
 * is presentation-only.
 */
function HashrateUnitToggle() {
  const { hashrateUnit, setHashrateUnit } = useDenomination();
  const { i18n } = useLingui();
  void i18n;
  const titleText = t`Select hashrate unit (1 EH = 1,000 PH = 1,000,000 TH)`;
  const options: Array<'TH' | 'PH' | 'EH'> = ['TH', 'PH', 'EH'];
  return (
    <div
      className="inline-flex items-center border border-slate-700 rounded-md overflow-hidden text-[11px] leading-none"
      title={titleText}
    >
      {options.map((u, i) => (
        <button
          key={u}
          onClick={() => setHashrateUnit(u)}
          className={
            'px-2 py-1 transition ' +
            (i > 0 ? 'border-l border-slate-700 ' : '') +
            (hashrateUnit === u
              ? 'bg-amber-400 text-slate-900 font-medium'
              : 'text-slate-400 hover:bg-slate-800')
          }
        >
          {u}
        </button>
      ))}
    </div>
  );
}
