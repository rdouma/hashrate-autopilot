import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, UnauthorizedError } from '../lib/api';
import { clearPassword, setPassword } from '../lib/auth';

export function Login() {
  const navigate = useNavigate();
  const { i18n } = useLingui();
  void i18n;
  const [password, setLocal] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Belt-and-suspenders for the NEEDS_SETUP race. The SetupGate above
  // already redirects when the daemon reports needs-setup, but a
  // browser running a stale JS bundle (cached from a prior install)
  // may not have that gate yet. Re-probe here so anyone landing on
  // /login while the daemon is in NEEDS_SETUP bounces straight to
  // the wizard, with any stored auth wiped on the way out.
  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((h) => {
        if (cancelled) return;
        if (h.mode === 'NEEDS_SETUP') {
          clearPassword();
          navigate('/setup', { replace: true });
        }
      })
      .catch(() => {
        /* probe failed - fall through, let the form render */
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    setPassword(password, remember);
    try {
      await api.checkAuth();
      navigate('/');
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        setErr(t`incorrect password`);
      } else {
        setErr((cause as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-lg p-6 space-y-4"
      >
        <div>
          <h1 className="text-xl text-amber-400 font-semibold">Hashrate Autopilot</h1>
          <p className="text-sm text-slate-400"><Trans>dashboard sign-in</Trans></p>
        </div>
        <label className="block text-sm">
          <span className="block text-slate-300 mb-1"><Trans>password</Trans></span>
          <input
            type="password"
            value={password}
            onChange={(e) => setLocal(e.target.value)}
            autoFocus
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100 focus:border-amber-400 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-300 select-none cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-amber-400"
          />
          <span><Trans>Remember me on this device</Trans></span>
        </label>
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full bg-amber-400 text-slate-900 font-medium py-2 rounded hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? <Trans>signing in…</Trans> : <Trans>sign in</Trans>}
        </button>
      </form>
    </div>
  );
}
