/**
 * First-run onboarding wizard (#57). Replaces the interactive
 * `setup.ts` CLI for appliance / Docker / NUC users who don't have
 * (or don't want) a terminal.
 *
 * Mode detection lives in the route guard (main.tsx). When the
 * daemon's GET /api/health returns `mode: NEEDS_SETUP`, the dashboard
 * routes here. After a successful POST /api/setup, the daemon exits
 * and is restarted by the process manager; we poll /api/health until
 * `mode: OPERATIONAL`, then auto-sign-in with the password the wizard
 * just collected and redirect to /.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type AppConfig, type SetupInfoResponse } from '../lib/api';
import { setPassword } from '../lib/auth';

const SAT_PER_EH_PER_PH = 1000;

interface FormState {
  // Secrets
  braiins_owner_token: string;
  braiins_read_only_token: string;
  dashboard_password: string;
  dashboard_password_confirm: string;
  // Config
  target_hashrate_ph: number;
  minimum_floor_hashrate_ph: number;
  destination_pool_url: string;
  destination_pool_worker_name: string;
  btc_payout_address: string;
  // Pricing — already-defaulted, exposed so the operator sees them
  max_bid_sat_per_ph_day: number; // converted from sat/EH/day
  overpay_sat_per_ph_day: number;
  // Optional bitcoind
  bitcoind_rpc_url: string;
  bitcoind_rpc_user: string;
  bitcoind_rpc_password: string;
}

type Step = 'access' | 'mining' | 'review' | 'submitting';

export function Setup() {
  const navigate = useNavigate();
  const [info, setInfo] = useState<SetupInfoResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('access');
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  // Bootstrap the form from /api/setup-info on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const i = await api.setupInfo();
        if (cancelled) return;
        setInfo(i);
        const base: AppConfig = i.current_config ?? i.defaults;
        setForm({
          braiins_owner_token: '',
          braiins_read_only_token: '',
          dashboard_password: '',
          dashboard_password_confirm: '',
          target_hashrate_ph: base.target_hashrate_ph,
          minimum_floor_hashrate_ph: base.minimum_floor_hashrate_ph,
          destination_pool_url: base.destination_pool_url,
          destination_pool_worker_name: base.destination_pool_worker_name,
          btc_payout_address: base.btc_payout_address,
          max_bid_sat_per_ph_day: base.max_bid_sat_per_eh_day / SAT_PER_EH_PER_PH,
          overpay_sat_per_ph_day: base.overpay_sat_per_eh_day / SAT_PER_EH_PER_PH,
          bitcoind_rpc_url: base.bitcoind_rpc_url,
          bitcoind_rpc_user: base.bitcoind_rpc_user,
          bitcoind_rpc_password: base.bitcoind_rpc_password,
        });
      } catch (err) {
        if (cancelled) return;
        setLoadErr((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loadErr) {
    return (
      <CenteredCard>
        <div className="text-red-400">Failed to load setup data: {loadErr}</div>
        <p className="text-sm text-slate-400 mt-2">
          The daemon may not be in setup mode. Reload the page or check the daemon logs.
        </p>
      </CenteredCard>
    );
  }

  if (!form || !info) {
    return (
      <CenteredCard>
        <div className="text-slate-400">Loading…</div>
      </CenteredCard>
    );
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const submit = async () => {
    setSubmitErr(null);
    setStep('submitting');
    if (!info) return;
    try {
      const base: AppConfig = info.current_config ?? info.defaults;
      const config: AppConfig = {
        ...base,
        target_hashrate_ph: form.target_hashrate_ph,
        minimum_floor_hashrate_ph: form.minimum_floor_hashrate_ph,
        destination_pool_url: form.destination_pool_url,
        destination_pool_worker_name: form.destination_pool_worker_name,
        btc_payout_address: form.btc_payout_address,
        max_bid_sat_per_eh_day: Math.round(form.max_bid_sat_per_ph_day * SAT_PER_EH_PER_PH),
        overpay_sat_per_eh_day: Math.round(form.overpay_sat_per_ph_day * SAT_PER_EH_PER_PH),
        bitcoind_rpc_url: form.bitcoind_rpc_url,
        bitcoind_rpc_user: form.bitcoind_rpc_user,
        bitcoind_rpc_password: form.bitcoind_rpc_password,
      };
      await api.submitSetup({
        config,
        secrets: {
          braiins_owner_token: form.braiins_owner_token,
          ...(form.braiins_read_only_token
            ? { braiins_read_only_token: form.braiins_read_only_token }
            : {}),
          dashboard_password: form.dashboard_password,
          ...(form.bitcoind_rpc_url
            ? {
                bitcoind_rpc_url: form.bitcoind_rpc_url,
                bitcoind_rpc_user: form.bitcoind_rpc_user,
                bitcoind_rpc_password: form.bitcoind_rpc_password,
              }
            : {}),
        },
      });
      // Daemon writes + exits ~200 ms after the response. Wait for it
      // to come back operational, then auto-sign-in and redirect.
      await waitForOperational();
      setPassword(form.dashboard_password, true);
      navigate('/');
    } catch (err) {
      setSubmitErr((err as Error).message);
      setStep('review');
    }
  };

  if (step === 'submitting') {
    return (
      <CenteredCard wide>
        <h1 className="text-xl text-amber-400 font-semibold">Setting up…</h1>
        <p className="text-slate-300 text-sm mt-2">
          Writing config + secrets and restarting the daemon. This usually takes a few seconds.
        </p>
        <div className="mt-4 h-2 w-full bg-slate-800 rounded overflow-hidden">
          <div className="h-full bg-amber-400 animate-pulse w-1/3" />
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard wide>
      <Header step={step} info={info} />
      {step === 'access' && (
        <AccessStep
          form={form}
          update={update}
          onNext={() => setStep('mining')}
        />
      )}
      {step === 'mining' && (
        <MiningStep
          form={form}
          update={update}
          onBack={() => setStep('access')}
          onNext={() => setStep('review')}
        />
      )}
      {step === 'review' && (
        <ReviewStep
          form={form}
          err={submitErr}
          onBack={() => setStep('mining')}
          onSubmit={submit}
        />
      )}
    </CenteredCard>
  );
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Block until the daemon flips back to OPERATIONAL after the wizard restart. */
async function waitForOperational(maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const h = await api.health();
      if (h.mode === 'OPERATIONAL') return;
    } catch {
      // Daemon mid-restart — fetch fails, keep polling.
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('Daemon did not return to OPERATIONAL within 90 seconds.');
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function Header({ step, info }: { step: Step; info: SetupInfoResponse }) {
  const stepIndex = step === 'access' ? 0 : step === 'mining' ? 1 : 2;
  const verb = info.has_existing_config ? 'Re-setup' : 'First-run setup';
  return (
    <div className="mb-6">
      <h1 className="text-2xl text-amber-400 font-semibold">Braiins Autopilot — {verb}</h1>
      <p className="text-sm text-slate-400 mt-1">
        {info.has_existing_config
          ? 'Existing config detected — fields are pre-filled. Update what changed and click through.'
          : 'A few questions to get the daemon operational. Defaults work for typical home miners; tune later from the Config page.'}
      </p>
      <div className="flex gap-2 mt-4">
        {['Access', 'Mining', 'Review'].map((label, i) => (
          <div
            key={label}
            className={`flex-1 px-3 py-1.5 rounded text-xs font-medium text-center ${
              i === stepIndex
                ? 'bg-amber-400 text-slate-900'
                : i < stepIndex
                  ? 'bg-emerald-700/60 text-emerald-100'
                  : 'bg-slate-800 text-slate-400'
            }`}
          >
            {i + 1}. {label}
          </div>
        ))}
      </div>
    </div>
  );
}

function AccessStep({
  form,
  update,
  onNext,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  onNext: () => void;
}) {
  const passwordsMatch = form.dashboard_password === form.dashboard_password_confirm;
  const valid =
    form.braiins_owner_token.trim().length > 0 &&
    form.dashboard_password.length >= 8 &&
    passwordsMatch;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onNext();
      }}
      className="space-y-4"
    >
      <Section title="Braiins API access">
        <Field label="Owner token" hint="From hashpower.braiins.com → API tokens. Required.">
          <input
            type="password"
            value={form.braiins_owner_token}
            onChange={(e) => update('braiins_owner_token', e.target.value)}
            autoFocus
            className={textInputCss}
          />
        </Field>
        <Field
          label="Read-only token"
          hint="Optional. Useful if you'd like a second token only for read paths."
        >
          <input
            type="password"
            value={form.braiins_read_only_token}
            onChange={(e) => update('braiins_read_only_token', e.target.value)}
            className={textInputCss}
          />
        </Field>
      </Section>
      <Section title="Dashboard password">
        <p className="text-xs text-slate-400 -mt-1">
          You'll use this to sign in to the dashboard after setup. At least 8 characters.
        </p>
        <Field label="Password">
          <input
            type="password"
            value={form.dashboard_password}
            onChange={(e) => update('dashboard_password', e.target.value)}
            className={textInputCss}
          />
        </Field>
        <Field label="Confirm password">
          <input
            type="password"
            value={form.dashboard_password_confirm}
            onChange={(e) => update('dashboard_password_confirm', e.target.value)}
            className={textInputCss}
          />
          {!passwordsMatch && form.dashboard_password_confirm.length > 0 && (
            <div className="text-xs text-red-400 mt-1">passwords don't match</div>
          )}
        </Field>
      </Section>
      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={!valid}
          className={primaryButtonCss}
        >
          Next →
        </button>
      </div>
    </form>
  );
}

function MiningStep({
  form,
  update,
  onBack,
  onNext,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const valid =
    form.target_hashrate_ph > 0 &&
    form.minimum_floor_hashrate_ph > 0 &&
    form.minimum_floor_hashrate_ph <= form.target_hashrate_ph &&
    form.destination_pool_url.trim().length > 0 &&
    form.destination_pool_worker_name.includes('.') &&
    form.btc_payout_address.trim().length > 0;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onNext();
      }}
      className="space-y-4"
    >
      <Section title="Hashrate targets">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target (PH/s)" hint="What the controller aims for.">
            <input
              type="number"
              step="0.1"
              min="0.001"
              value={form.target_hashrate_ph}
              onChange={(e) => update('target_hashrate_ph', Number(e.target.value))}
              className={textInputCss}
            />
          </Field>
          <Field label="Floor (PH/s)" hint="Below this triggers an alert. ≤ target.">
            <input
              type="number"
              step="0.1"
              min="0.001"
              value={form.minimum_floor_hashrate_ph}
              onChange={(e) =>
                update('minimum_floor_hashrate_ph', Number(e.target.value))
              }
              className={textInputCss}
            />
          </Field>
        </div>
      </Section>
      <Section title="Pool destination (where Braiins delivers)">
        <Field label="Pool URL" hint="Stratum URL for your Datum gateway or pool.">
          <input
            type="text"
            value={form.destination_pool_url}
            onChange={(e) => update('destination_pool_url', e.target.value)}
            className={textInputCss}
          />
        </Field>
        <Field
          label="Worker identity"
          hint="Format: <btc-address>.<label> — Ocean TIDES credits hashrate to the address. The period is mandatory."
        >
          <input
            type="text"
            placeholder="bc1q…address.autopilot"
            value={form.destination_pool_worker_name}
            onChange={(e) => update('destination_pool_worker_name', e.target.value)}
            className={textInputCss}
          />
          {form.destination_pool_worker_name.length > 0 &&
            !form.destination_pool_worker_name.includes('.') && (
              <div className="text-xs text-red-400 mt-1">
                must contain a period — without it shares are uncredited on Ocean
              </div>
            )}
        </Field>
      </Section>
      <Section title="On-chain payouts">
        <Field
          label="Bitcoin payout address"
          hint="Your address that receives Ocean TIDES payouts. Used to observe block credits."
        >
          <input
            type="text"
            value={form.btc_payout_address}
            onChange={(e) => update('btc_payout_address', e.target.value)}
            className={textInputCss}
          />
        </Field>
      </Section>
      <details className="bg-slate-900/40 border border-slate-800 rounded p-3">
        <summary className="cursor-pointer text-sm text-slate-300 select-none">
          Bitcoin Core RPC (optional)
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-slate-400">
            Connect to a bitcoind instance to observe on-chain payouts. You can also configure this
            from the Config page after setup.
          </p>
          <Field label="RPC URL">
            <input
              type="text"
              placeholder="http://10.21.21.8:8332"
              value={form.bitcoind_rpc_url}
              onChange={(e) => update('bitcoind_rpc_url', e.target.value)}
              className={textInputCss}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="RPC user">
              <input
                type="text"
                value={form.bitcoind_rpc_user}
                onChange={(e) => update('bitcoind_rpc_user', e.target.value)}
                className={textInputCss}
              />
            </Field>
            <Field label="RPC password">
              <input
                type="password"
                value={form.bitcoind_rpc_password}
                onChange={(e) => update('bitcoind_rpc_password', e.target.value)}
                className={textInputCss}
              />
            </Field>
          </div>
        </div>
      </details>
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={secondaryButtonCss}>
          ← Back
        </button>
        <button type="submit" disabled={!valid} className={primaryButtonCss}>
          Next →
        </button>
      </div>
    </form>
  );
}

function ReviewStep({
  form,
  err,
  onBack,
  onSubmit,
}: {
  form: FormState;
  err: string | null;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      <Section title="Review">
        <ReviewRow label="Owner token" value={maskToken(form.braiins_owner_token)} />
        {form.braiins_read_only_token && (
          <ReviewRow label="Read-only token" value={maskToken(form.braiins_read_only_token)} />
        )}
        <ReviewRow label="Dashboard password" value="••••••••" />
        <ReviewRow label="Target hashrate" value={`${form.target_hashrate_ph} PH/s`} />
        <ReviewRow label="Floor hashrate" value={`${form.minimum_floor_hashrate_ph} PH/s`} />
        <ReviewRow label="Pool URL" value={form.destination_pool_url} />
        <ReviewRow label="Worker identity" value={form.destination_pool_worker_name} />
        <ReviewRow label="Payout address" value={form.btc_payout_address} />
        <ReviewRow
          label="Max bid"
          value={`${form.max_bid_sat_per_ph_day.toLocaleString()} sat/PH/day (default — tunable later)`}
        />
        <ReviewRow
          label="Overpay above fillable"
          value={`${form.overpay_sat_per_ph_day.toLocaleString()} sat/PH/day (default — tunable later)`}
        />
        {form.bitcoind_rpc_url && (
          <ReviewRow label="Bitcoin Core RPC" value={form.bitcoind_rpc_url} />
        )}
      </Section>
      <p className="text-xs text-slate-400">
        After submit, the daemon will write everything to <code>state.db</code>, restart, and start
        in <strong>DRY-RUN</strong> mode. The dashboard will sign you in automatically once the
        daemon is back. Promote to LIVE from the Status page when you're ready.
      </p>
      {err && <div className="text-sm text-red-400">{err}</div>}
      <div className="flex justify-between pt-2">
        <button type="button" onClick={onBack} className={secondaryButtonCss}>
          ← Back
        </button>
        <button type="button" onClick={onSubmit} className={primaryButtonCss}>
          Complete setup
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI primitives — kept inline so this page is self-contained.
// ---------------------------------------------------------------------------

const textInputCss =
  'w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-slate-100 focus:border-amber-400 focus:outline-none';
const primaryButtonCss =
  'bg-amber-400 text-slate-900 font-medium px-4 py-2 rounded hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed';
const secondaryButtonCss =
  'bg-slate-800 text-slate-200 font-medium px-4 py-2 rounded hover:bg-slate-700';

function CenteredCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="min-h-full flex items-center justify-center py-8 px-4">
      <div
        className={`w-full ${wide ? 'max-w-2xl' : 'max-w-md'} bg-slate-900 border border-slate-800 rounded-lg p-6`}
      >
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">{title}</h2>
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="block text-slate-300 mb-1">{label}</span>
      {children}
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </label>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm border-b border-slate-800 last:border-b-0 py-1.5">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-100 font-mono text-right truncate max-w-[60%]">{value}</span>
    </div>
  );
}

function maskToken(t: string): string {
  if (t.length <= 6) return '••••••';
  return `${t.slice(0, 3)}…${t.slice(-3)}`;
}
