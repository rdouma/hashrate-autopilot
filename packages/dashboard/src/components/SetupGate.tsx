/**
 * Wraps the entire app and routes based on the daemon's reported
 * mode (`/api/health`):
 *
 *   - `NEEDS_SETUP` → force redirect to `/setup` (the wizard handles
 *     polling for OPERATIONAL after submit).
 *   - `OPERATIONAL` → render children; the existing `RequireAuth`
 *     handles the login flow per page.
 *   - probe failed (daemon down) → render children optimistically;
 *     individual pages will surface their own load errors. We don't
 *     want a transient network blip to lock the user out of pages
 *     they could otherwise still see (e.g. the Login page).
 *
 * The probe re-runs on a slow interval as a safety net for the case
 * where a daemon-side `setup.ts` was run from CLI mid-session - the
 * dashboard discovers the operational status without the operator
 * having to refresh manually.
 */

import { Trans } from '@lingui/macro';
import { type ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { api } from '../lib/api';
import { clearPassword, getPassword } from '../lib/auth';

type ProbeState =
  | { kind: 'loading' }
  | { kind: 'mode'; mode: 'NEEDS_SETUP' | 'OPERATIONAL' }
  | { kind: 'error' };

const POLL_INTERVAL_MS = 30_000;

export function SetupGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [probe, setProbe] = useState<ProbeState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const h = await api.health();
        if (cancelled) return;
        // If the daemon reports NEEDS_SETUP but the browser still has
        // a stored password from a prior install on this host, blow
        // away that stored credential. Otherwise RequireAuth would
        // happily route the user into the (now non-existent) auth'd
        // pages and they'd never see the wizard. Caught us once on a
        // genuine fresh install where the operator's browser
        // remembered an old session.
        if (h.mode === 'NEEDS_SETUP' && getPassword() !== null) {
          clearPassword();
        }
        setProbe({ kind: 'mode', mode: h.mode });
      } catch {
        if (cancelled) return;
        // Don't lock the user out on a transient probe failure -
        // optimistically let pages render and let them surface their
        // own errors.
        setProbe({ kind: 'error' });
      }
      if (!cancelled) {
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Allow /setup to render while we figure out the mode - the wizard
  // is the only useful destination if we're loading the probe AND
  // already on /setup, so don't bounce.
  if (probe.kind === 'loading' && location.pathname !== '/setup') {
    return (
      <div className="min-h-full flex items-center justify-center text-slate-400 text-sm">
        <Trans>Connecting to daemon…</Trans>
      </div>
    );
  }

  if (probe.kind === 'mode' && probe.mode === 'NEEDS_SETUP') {
    if (location.pathname !== '/setup') {
      return <Navigate to="/setup" replace />;
    }
  }

  if (probe.kind === 'mode' && probe.mode === 'OPERATIONAL') {
    if (location.pathname === '/setup') {
      // Daemon is operational but the user is on /setup - redirect
      // to the home page (or login). Wizard's own post-submit flow
      // handles its own redirect, so this only triggers if a stale
      // wizard tab survives across a manual setup completion.
      return <Navigate to="/" replace />;
    }
  }

  return <>{children}</>;
}
