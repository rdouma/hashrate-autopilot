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
  event_kind:
    | 'escalation'
    | 'lower_after_override'
    | 'lower_after_patience'
    | 'lower_after_cooldown'
    | null;
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

export interface TickNowExecutedEntry {
  kind: string;
  outcome: 'DRY_RUN' | 'EXECUTED' | 'BLOCKED' | 'FAILED';
  reason: string | null;
}

export interface TickNowResponse {
  ok: boolean;
  tick_at?: number;
  proposals?: number;
  executed?: TickNowExecutedEntry[];
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
  datum_hashrate_ph: number | null;
  ocean_hashrate_ph: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick
   * (sat). Per-tick deltas against this give the authoritative actual
   * effective rate — drives the chart's "effective" line. Null for
   * pre-migration ticks and ticks with no primary owned bid.
   */
  primary_bid_consumed_sat: number | null;
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
  datum: {
    reachable: boolean;
    connections: number | null;
    hashrate_ph: number | null;
    last_ok_at: number | null;
    consecutive_failures: number;
  } | null;
  bids: BidView[];
  actual_hashrate_ph: number;
  avg_delivered_ph_3h: number | null;
  below_floor_since: number | null;
  last_proposals: ProposalView[];
  config_summary: {
    target_hashrate_ph: number;
    minimum_floor_hashrate_ph: number;
    overpay_sat_per_ph_day: number;
    max_bid_sat_per_ph_day: number;
    max_overpay_vs_hashprice_sat_per_ph_day: number | null;
    effective_cap_sat_per_ph_day: number;
    binding_cap: 'fixed' | 'dynamic';
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
  // Nullable dynamic-cap config. Server coerces 0 → null via Zod
  // preprocess; keep the wider type here so existing callers don't
  // need to special-case the UI's "disabled" representation.
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
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
  escalation_mode: 'market' | 'dampened' | 'above_market';
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
  tick_metrics_retention_days: number;
  decisions_uneventful_retention_days: number;
  decisions_eventful_retention_days: number;
  datum_api_url: string | null;
  block_explorer_url_template: string;
  braiins_hashrate_smoothing_minutes: number;
  datum_hashrate_smoothing_minutes: number;
  braiins_price_smoothing_minutes: number;
}

export interface ConfigResponse {
  config: AppConfig;
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  decisions: (limit = 500) =>
    request<DecisionSummary[]>(`/api/decisions?limit=${limit}`),
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
  financeRange: (range: ChartRange) =>
    request<FinanceRangeResponse>(
      `/api/finance/range?range=${encodeURIComponent(range)}`,
    ),
  rebuildSpendCache: () =>
    request<{ ok: boolean; error?: string }>('/api/finance/spend/rebuild', {
      method: 'POST',
    }),
  stats: (range: ChartRange) =>
    request<StatsResponse>(`/api/stats?range=${encodeURIComponent(range)}`),
  simulate: (params: SimulateRequest) =>
    request<SimulateResponse>('/api/simulate', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
  ocean: () => request<OceanResponse>('/api/ocean'),
  // Test-auth call: hits /api/status to validate credentials.
  checkAuth: () => request<StatusResponse>('/api/status'),
};

export interface StatsResponse {
  uptime_pct: number | null;
  avg_hashrate_ph: number | null;
  avg_datum_hashrate_ph: number | null;
  avg_ocean_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_overpay_sat_per_ph_day: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  avg_time_to_fill_ms: number | null;
  mutation_count: number;
  range: ChartRange;
  tick_count: number;
}

export interface BtcPriceResponse {
  usd_per_btc: number | null;
  source: string;
  fetched_at_ms: number | null;
}

export interface FinanceRangeResponse {
  range: ChartRange;
  window_ms: number | null;
  tick_count: number;
  first_tick_at: number | null;
  last_tick_at: number | null;
  avg_price_sat_per_ph_day: number | null;
  avg_hashprice_sat_per_ph_day: number | null;
  avg_delivered_ph: number | null;
  sum_spend_sat: number | null;
  spend_per_day_sat: number | null;
  projected_income_per_day_sat: number | null;
  projected_net_per_day_sat: number | null;
  insufficient_history: boolean;
}

export interface FinanceResponse {
  spent_sat: number;
  spent_scope: 'autopilot' | 'account';
  spent_closed_sat: number | null;
  spent_active_sat: number | null;
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
  /**
   * Dynamic hashprice-relative cap allowance. When non-null, the
   * simulator uses min(max_bid, hashprice + this) as the per-tick
   * effective cap — matching decide()'s behaviour. Null/0 disables.
   */
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
  fill_escalation_step_sat_per_eh_day: number;
  fill_escalation_after_minutes: number;
  lower_patience_minutes: number;
  min_lower_delta_sat_per_eh_day: number;
  escalation_mode: 'market' | 'dampened' | 'above_market';
}

export interface SimStatsSummary {
  uptime_pct: number | null;
  avg_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  avg_overpay_sat_per_ph_day: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  gap_count: number;
  gap_minutes: number;
  /** CREATE + EDIT_PRICE events the simulator would have issued. */
  mutation_count: number;
}

export interface SimulatedTick {
  tick_at: number;
  simulated_price_sat_per_ph_day: number;
  delivered_ph: number;
}

export interface SimulateResponse {
  actual: SimStatsSummary;
  simulated: SimStatsSummary;
  ticks: SimulatedTick[];
  tick_count: number;
  range: string;
}

export interface OceanBlockView {
  height: number;
  timestamp_ms: number;
  total_reward_sat: number;
  subsidy_sat: number;
  fees_sat: number;
  worker: string;
}

/**
 * Pool block that credited our wallet — surfaced as a cube marker on
 * the Hashrate chart. Under Ocean TIDES, every pool block credits
 * everyone with shares in the reward window, so this is populated for
 * every recent pool block while the daemon is mining. `found_by_us`
 * flags the rare solo-lottery case where our payout address was the
 * literal finder.
 */
export interface OurBlockMarker {
  height: number;
  timestamp_ms: number;
  total_reward_sat: number;
  subsidy_sat: number;
  fees_sat: number;
  block_hash: string;
  worker: string;
  found_by_us: boolean;
}

export interface OceanResponse {
  configured: boolean;
  last_block: {
    height: number;
    timestamp_ms: number;
    total_reward_sat: number;
    block_hash: string;
    ago_text: string;
  } | null;
  blocks_24h: number;
  blocks_7d: number;
  recent_blocks: OceanBlockView[];
  our_recent_blocks: OurBlockMarker[];
  pool: {
    active_users: number | null;
    active_workers: number | null;
    network_difficulty: number | null;
    pool_hashrate_ph: number | null;
    estimated_block_reward_sat: number | null;
  } | null;
  user: {
    unpaid_sat: number | null;
    next_block_sat: number | null;
    daily_estimate_sat: number | null;
    hashprice_sat_per_ph_day: number | null;
    time_to_payout_text: string | null;
    share_log_pct: number | null;
    hashrate_th: number | null;
    hashrate_5m_ph: number | null;
    payout_threshold_sat: number;
    rewards_in_window_sat: number | null;
  } | null;
  fetched_at_ms: number | null;
}
