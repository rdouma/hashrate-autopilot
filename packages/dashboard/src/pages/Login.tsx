import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, UnauthorizedError } from '../lib/api';
import { setPassword } from '../lib/auth';

export function Login() {
  const navigate = useNavigate();
  const [password, setLocal] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        setErr('incorrect password');
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
          <h1 className="text-xl text-amber-400 font-semibold">Braiins Autopilot</h1>
          <p className="text-sm text-slate-400">dashboard sign-in</p>
        </div>
        <label className="block text-sm">
          <span className="block text-slate-300 mb-1">password</span>
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
          <span>Remember me on this device</span>
        </label>
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          type="submit"
          disabled={submitting || password.length === 0}
          className="w-full bg-amber-400 text-slate-900 font-medium py-2 rounded hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'signing in…' : 'sign in'}
        </button>
      </form>
    </div>
  );
}
