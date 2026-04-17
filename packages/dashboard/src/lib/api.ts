import type { ChartRange } from '@braiins-hashrate/shared';

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

export interface NextActionView {
  summary: string;
  detail: string | null;
  eta_ms: number | null;
  event_started_ms: number | null;
  event_kind: 'escalation' | 'lower_after_override' | 'lower_after_cooldown' | null;
  last_executed: {
    summary: string;
    executed_at_ms: number;
  } | null;
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
  fillable_ask_sat_per_ph_day: number | null;
  hashprice_sat_per_ph_day: number | null;
  max_bid_sat_per_ph_day: number | null;
  available_balance_sat: number | null;
}

export interface BidEventView {
  id: number;
  occurred_at: number;
  source: 'AUTOPILOT' | 'OPERATOR';
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';
  braiins_order_id: string | null;
  old_price_sat_per_ph_day: number | null;
  new_price_sat_per_ph_day: number | null;
  speed_limit_ph: number | null;
  amount_sat: number | null;
  reason: string | null;
}

export interface PayoutsResponse {
  address: string | null;
  total_unspent_sat: number | null;
  utxo_count: number | null;
  scanned_block_height: number | null;
  checked_at: number | null;
  last_error: string | null;
  source: 'electrs' | 'bitcoind' | null;
}

export interface ProposalView {
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID' | 'PAUSE';
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
    fillable_ask_sat_per_ph_day: number | null;
    fillable_thin: boolean;
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
    max_bid_sat_per_ph_day: number;
    fill_escalation_step_sat_per_ph_day: number;
    bid_budget_sat: number;
    pool_url: string;
    quiet_hours_start: string;
    quiet_hours_end: string;
    quiet_hours_timezone: string;
    effective_target_hashrate_ph: number;
    cheap_mode_active: boolean;
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
  max_bid_sat_per_eh_day: number;
  monthly_budget_ceiling_sat: number;
  bid_budget_sat: number;
  wallet_runway_alert_days: number;
  below_floor_alert_after_minutes: number;
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
  overpay_sat_per_eh_day: number;
  escalation_mode: 'market' | 'dampened';
  min_lower_delta_sat_per_eh_day: number;
  lower_patience_minutes: number;
  electrs_host: string | null;
  electrs_port: number | null;
  boot_mode: 'ALWAYS_DRY_RUN' | 'LAST_MODE' | 'ALWAYS_LIVE';
  spent_scope: 'autopilot' | 'account';
  btc_price_source: 'none' | 'coingecko' | 'coinbase' | 'bitstamp' | 'kraken';
  cheap_target_hashrate_ph: number;
  cheap_threshold_pct: number;
  bitcoind_rpc_url: string;
  bitcoind_rpc_user: string;
  bitcoind_rpc_password: string;
  payout_source: 'none' | 'electrs' | 'bitcoind';
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
  metrics: (range: ChartRange) =>
    request<{ points: MetricPoint[]; range: ChartRange | null }>(
      `/api/metrics?range=${encodeURIComponent(range)}`,
    ),
  bidEvents: (range: ChartRange) =>
    request<{ events: BidEventView[] }>(
      `/api/bid-events?range=${encodeURIComponent(range)}`,
    ),
  payouts: () => request<PayoutsResponse>('/api/payouts'),
  scanPayouts: () => request<{ ok: boolean; error?: string }>('/api/payouts/scan', { method: 'POST' }),
  btcPrice: () => request<BtcPriceResponse>('/api/btc-price'),
  finance: () => request<FinanceResponse>('/api/finance'),
  stats: (range: ChartRange) =>
    request<StatsResponse>(`/api/stats?range=${encodeURIComponent(range)}`),
  simulate: (params: SimulateRequest) =>
    request<SimulateResponse>('/api/simulate', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  // Test-auth call: hits /api/status to validate credentials.
  checkAuth: () => request<StatusResponse>('/api/status'),
};

export interface StatsResponse {
  uptime_pct: number | null;
  avg_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_overpay_sat_per_ph_day: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  avg_time_to_fill_ms: number | null;
  range: ChartRange;
  tick_count: number;
}

export interface BtcPriceResponse {
  usd_per_btc: number | null;
  source: string;
  fetched_at_ms: number | null;
}

export interface FinanceResponse {
  spent_sat: number;
  spent_scope: 'autopilot' | 'account';
  collected_sat: number | null;
  expected_sat: number | null;
  net_sat: number | null;
  ocean: {
    lifetime_sat: number | null;
    daily_estimate_sat: number | null;
    hashprice_sat_per_ph_day: number | null;
    rewards_in_window_sat: number | null;
    time_to_payout_text: string | null;
    payout_threshold_sat: number;
    fetched_at_ms: number | null;
  } | null;
  checked_at_ms: number;
}

export interface SimulateRequest {
  range?: string;
  overpay_sat_per_eh_day: number;
  max_bid_sat_per_eh_day: number;
  fill_escalation_step_sat_per_eh_day: number;
  fill_escalation_after_minutes: number;
  lower_patience_minutes: number;
  min_lower_delta_sat_per_eh_day: number;
}

interface SimulateSummary {
  uptime_pct: number | null;
  avg_cost_sat_per_eh_day: number | null;
  gap_count: number;
  gap_minutes: number;
}

export interface SimulatedTick {
  tick_at: number;
  simulated_price_sat_per_eh_day: number;
  filled: boolean;
}

export interface SimulateResponse {
  actual: SimulateSummary;
  simulated: SimulateSummary;
  ticks: SimulatedTick[];
  tick_count: number;
  range: string;
}
