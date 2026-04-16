import { basicAuthHeader, clearPassword, getPassword } from './auth';

export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const password = getPassword();
  const headers = new Headers(init.headers);
  if (password) headers.set('Authorization', basicAuthHeader(password));
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) {
    clearPassword();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface BidView {
  braiins_order_id: string;
  cl_order_id: string | null;
  price_sat_per_ph_day: number;
  amount_sat: number;
  speed_limit_ph: number | null;
  avg_speed_ph: number;
  progress_pct: number | null;
  amount_remaining_sat: number | null;
  status: string;
  is_owned: boolean;
  created_at_ms: number | null;
}

export interface TickNowResponse {
  ok: boolean;
  tick_at?: number;
  proposals?: number;
  executed?: unknown[];
  error?: string;
}

export interface BumpPriceResponse {
  ok: boolean;
  braiins_order_id?: string;
  old_price_sat_per_eh_day?: number;
  new_price_sat_per_eh_day?: number;
  error?: string;
}

export interface MetricPoint {
  tick_at: number;
  delivered_ph: number;
  target_ph: number;
  floor_ph: number;
  our_primary_price_sat_per_ph_day: number | null;
  best_bid_sat_per_ph_day: number | null;
  best_ask_sat_per_ph_day: number | null;
  available_balance_sat: number | null;
  run_mode: string;
}

export interface ProposalView {
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'CANCEL_BID' | 'PAUSE';
  summary: string;
  reason: string;
  allowed: boolean;
  gate_reason: string | null;
  executed: 'DRY_RUN' | 'EXECUTED' | 'BLOCKED' | 'FAILED';
}

export interface BalanceView {
  subaccount: string;
  currency: string;
  total_balance_sat: number;
  available_balance_sat: number;
  blocked_balance_sat: number;
}

export interface NextActionView {
  summary: string;
  detail: string | null;
}

export interface StatusResponse {
  run_mode: 'DRY_RUN' | 'LIVE' | 'PAUSED';
  action_mode: 'NORMAL' | 'QUIET_HOURS' | 'PENDING_CONFIRMATION' | 'CONFIRMATION_TIMEOUT';
  operator_available: boolean;
  tick_at: number | null;
  last_api_ok_at: number | null;
  next_tick_at: number | null;
  tick_interval_ms: number;
  next_action: NextActionView;
  balances: BalanceView[];
  market: {
    best_bid_sat_per_ph_day: number | null;
    best_ask_sat_per_ph_day: number | null;
  } | null;
  pool: {
    reachable: boolean;
    last_ok_at: number | null;
    consecutive_failures: number;
  };
  bids: BidView[];
  actual_hashrate_ph: number;
  below_floor_since: number | null;
  last_proposals: ProposalView[];
  config_summary: {
    target_hashrate_ph: number;
    minimum_floor_hashrate_ph: number;
    max_price_sat_per_ph_day: number;
    emergency_max_price_sat_per_ph_day: number;
    bid_budget_sat: number;
    pool_url: string;
    quiet_hours_start: string;
    quiet_hours_end: string;
    quiet_hours_timezone: string;
  };
}

export interface DecisionSummary {
  id: number;
  tick_at: number;
  run_mode: string;
  action_mode: string;
  proposal_count: number;
}

export interface DecisionDetail extends DecisionSummary {
  observed: unknown;
  proposed: unknown;
  gated: unknown;
  executed: unknown;
}

export interface AppConfig {
  target_hashrate_ph: number;
  minimum_floor_hashrate_ph: number;
  destination_pool_url: string;
  destination_pool_worker_name: string;
  max_price_sat_per_eh_day: number;
  emergency_max_price_sat_per_eh_day: number;
  monthly_budget_ceiling_sat: number;
  bid_budget_sat: number;
  wallet_runway_alert_days: number;
  below_floor_alert_after_minutes: number;
  below_floor_emergency_cap_after_minutes: number;
  zero_hashrate_loud_alert_after_minutes: number;
  pool_outage_blip_tolerance_seconds: number;
  api_outage_alert_after_minutes: number;
  quiet_hours_start: string;
  quiet_hours_end: string;
  quiet_hours_timezone: string;
  confirmation_timeout_minutes: number;
  handover_window_minutes: number;
  btc_payout_address: string;
  telegram_chat_id: string;
  fill_escalation_step_sat_per_eh_day: number;
  fill_escalation_after_minutes: number;
  max_overpay_vs_ask_sat_per_eh_day: number;
  hibernate_on_expensive_market: boolean;
}

export interface ConfigResponse {
  config: AppConfig;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  decisions: (limit = 50, mode?: 'DRY_RUN' | 'LIVE' | 'PAUSED') => {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (mode) q.set('mode', mode);
    return request<DecisionSummary[]>(`/api/decisions?${q.toString()}`);
  },
  decision: (id: number) => request<DecisionDetail>(`/api/decisions/${id}`),
  config: () => request<ConfigResponse>('/api/config'),
  updateConfig: (cfg: AppConfig) =>
    request<ConfigResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),
  setRunMode: (run_mode: 'DRY_RUN' | 'LIVE' | 'PAUSED') =>
    request<{ run_mode: string }>('/api/run-mode', {
      method: 'POST',
      body: JSON.stringify({ run_mode }),
    }),
  setOperatorAvailable: (available: boolean) =>
    request<{ operator_available: boolean }>('/api/operator-available', {
      method: 'POST',
      body: JSON.stringify({ available }),
    }),
  tickNow: () => request<TickNowResponse>('/api/actions/tick-now', { method: 'POST' }),
  bumpPrice: () => request<BumpPriceResponse>('/api/actions/bump-price', { method: 'POST' }),
  metrics: (sinceMs?: number) =>
    request<{ points: MetricPoint[] }>(
      `/api/metrics${sinceMs ? `?since=${sinceMs}` : ''}`,
    ),
  // Test-auth call: hits /api/status to validate credentials.
  checkAuth: () => request<StatusResponse>('/api/status'),
};
