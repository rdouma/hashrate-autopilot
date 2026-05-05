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

export type NextActionDescriptor =
  | { kind: 'paused' }
  | { kind: 'unknown_bids'; ids: readonly string[] }
  | { kind: 'braiins_unreachable' }
  | { kind: 'awaiting_hashprice' }
  | { kind: 'no_market_supply' }
  | {
      kind: 'will_create_bid';
      run_mode: 'LIVE' | 'DRY_RUN';
      target_ph: number;
      capped: boolean;
      target_ph_label: number;
      target_hashrate_ph: number;
      budget:
        | { kind: 'configured'; sat: number }
        | { kind: 'full_wallet'; available_sat: number }
        | { kind: 'awaiting_balance' };
    }
  | { kind: 'bid_pending'; id_short: string; status: string }
  | {
      kind: 'cooldown_active';
      target_ph: number;
      current_ph: number;
      mins_left: number;
      direction: 'lower' | 'raise';
    }
  | {
      kind: 'will_edit_bid';
      run_mode: 'LIVE' | 'DRY_RUN';
      target_ph: number;
      current_ph: number;
      clamped: boolean;
    }
  | { kind: 'on_target'; capped: boolean; avg_speed_ph: number };

export interface NextActionView {
  descriptor: NextActionDescriptor | null;
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
   * Ocean `share_log` percentage at this tick (e.g. 0.0182 for
   * 0.0182%). Drives the opt-in violet `% of Ocean` line on the
   * Hashrate chart. Null when Ocean isn't configured, the poll
   * failed, or the tick predates migration 0048.
   */
  share_log_pct: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick
   * (sat). Per-tick deltas against this give the authoritative actual
   * effective rate — drives the chart's "effective" line. Null for
   * pre-migration ticks and ticks with no primary owned bid.
   */
  primary_bid_consumed_sat: number | null;
  // #93: extended series for the per-chart secondary Y-axis dropdown.
  network_difficulty: number | null;
  pool_hashrate_ph: number | null;
  estimated_block_reward_sat: number | null;
  btc_usd_price: number | null;
  ocean_unpaid_sat: number | null;
  pool_blocks_24h_count: number | null;
  pool_blocks_7d_count: number | null;
  /**
   * Trailing 24h / 7d mean of `pool_hashrate_ph` ending at this
   * tick. Used by the chart's pool-luck calc as a window-matched
   * denominator (numerator is the matching trailing-Nd block count).
   * Null on rows older than migration 0056.
   */
  pool_hashrate_ph_avg_24h: number | null;
  pool_hashrate_ph_avg_7d: number | null;
  /**
   * Gap-based pool luck values (24h / 7d) computed daemon-side.
   * `luck = (600 / pool_share) / time_since_last_pool_block`. Read
   * directly by the chart's right-axis pool-luck series; no
   * client-side calc needed.
   */
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
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
  actual_spend_per_day_sat_3h: number | null;
  live_effective_sat_per_ph_day: number | null;
  below_floor_since: number | null;
  last_proposals: ProposalView[];
  config_summary: {
    target_hashrate_ph: number;
    minimum_floor_hashrate_ph: number;
    max_bid_sat_per_ph_day: number;
    max_overpay_vs_hashprice_sat_per_ph_day: number | null;
    effective_cap_sat_per_ph_day: number;
    binding_cap: 'fixed' | 'dynamic';
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
  overpay_sat_per_eh_day: number;
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
  electrs_host: string | null;
  electrs_port: number | null;
  boot_mode: 'ALWAYS_DRY_RUN' | 'LAST_MODE' | 'ALWAYS_LIVE';
  spent_scope: 'autopilot' | 'account';
  btc_price_source: 'none' | 'coingecko' | 'coinbase' | 'bitstamp' | 'kraken';
  cheap_target_hashrate_ph: number;
  cheap_threshold_pct: number;
  cheap_sustained_window_minutes: number;
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
  show_effective_rate_on_price_chart: boolean;
  show_share_log_on_hashrate_chart: boolean;
  block_found_sound:
    | 'off'
    | 'cartoon-cowbell'
    | 'glass-drop-and-roll'
    | 'metallic-clank-1'
    | 'metallic-clank-2'
    | 'custom';
}

export interface ConfigResponse {
  config: AppConfig;
}

// ---------------------------------------------------------------------------
// First-run onboarding wizard (#57) — public endpoints, no auth.
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
  mode: 'NEEDS_SETUP' | 'OPERATIONAL';
}

export interface SetupInfoResponse {
  has_existing_config: boolean;
  has_existing_secrets: boolean;
  defaults: AppConfig;
  current_config: AppConfig | null;
  /**
   * Bitcoin Core RPC creds discovered in the appliance's standard
   * env vars (Umbrel/Start9 inject `BITCOIN_RPC_*` when an app
   * declares a Bitcoin Core dependency). Each field is `null` when
   * not detected, so the wizard can show a "detected" hint when
   * any is non-null.
   */
  detected_bitcoind: {
    url: string | null;
    user: string | null;
    password: string | null;
  };
}

export interface SetupRequestPayload {
  config: AppConfig;
  secrets: {
    braiins_owner_token: string;
    braiins_read_only_token?: string;
    dashboard_password: string;
    bitcoind_rpc_url?: string;
    bitcoind_rpc_user?: string;
    bitcoind_rpc_password?: string;
  };
}

export interface SetupResponse {
  ok: boolean;
}

/** Public probe — no auth, returns 200 in both setup and operational modes. */
async function publicGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  return JSON.parse(text) as T;
}

export const api = {
  health: () => publicGet<HealthResponse>('/api/health'),
  setupInfo: () => publicGet<SetupInfoResponse>('/api/setup-info'),
  submitSetup: (payload: SetupRequestPayload) =>
    publicPost<SetupResponse>('/api/setup', payload),
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
  rewardEvents: (limit?: number) =>
    request<RewardEventsResponse>(
      `/api/reward-events${limit ? `?limit=${limit}` : ''}`,
    ),
  uploadBlockFoundSound: (dataBase64: string, mime: string) =>
    request<{ ok: boolean; bytes?: number; mime?: string; error?: string }>(
      '/api/config/block-found-sound',
      {
        method: 'POST',
        body: JSON.stringify({ data_base64: dataBase64, mime }),
      },
    ),
  btcPrice: () => request<BtcPriceResponse>('/api/btc-price'),
  bip110Scan: (blocks: number) =>
    request<Bip110ScanResponse>(`/api/bip110/scan?blocks=${encodeURIComponent(String(blocks))}`),
  bitcoindTest: (creds: { url: string; user: string; password: string }) =>
    request<BitcoindTestResponse>('/api/bitcoind/test', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),
  electrsTest: (params: { host: string; port: number }) =>
    request<ElectrsTestResponse>('/api/electrs/test', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
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
  storageEstimate: () => request<StorageEstimateResponse>('/api/storage-estimate'),
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
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  /** #90 — 1h-rolling pool acceptance ratio (%); null when no counter pairs in window. */
  acceptance_pct_1h: number | null;
  acceptance_purchased_delta_1h: number | null;
  acceptance_accepted_delta_1h: number | null;
  avg_time_to_fill_ms: number | null;
  mutation_count: number;
  range: ChartRange;
  tick_count: number;
}

export interface RewardEventView {
  id: number;
  txid: string;
  vout: number;
  block_height: number;
  value_sat: number;
  detected_at: number;
  reorged: boolean;
}

export interface RewardEventsResponse {
  events: RewardEventView[];
}

export interface StorageEstimateBucket {
  rows_per_day: number;
  bytes_per_row: number;
  current_rows: number;
}

export interface StorageEstimateResponse {
  tick_metrics: StorageEstimateBucket;
  decisions_uneventful: StorageEstimateBucket;
  decisions_eventful: StorageEstimateBucket;
  db_file_bytes: number | null;
  sample_days: number;
  computed_at: number;
}

export interface BtcPriceResponse {
  usd_per_btc: number | null;
  source: string;
  fetched_at_ms: number | null;
}

export interface Bip110ScanSignalingBlock {
  height: number;
  hash: string;
  time_ms: number;
  version: number;
  version_hex: string;
}

export interface Bip110ScanDeployment {
  key: string;
  status: string | null;
  bit: number | null;
  statistics: {
    count: number;
    elapsed: number;
    threshold: number;
    period: number;
  } | null;
}

export interface Bip110ScanResponse {
  rpc_available: boolean;
  tip_height: number | null;
  scanned: number;
  signaling_count: number;
  signaling_pct: number;
  deployment: Bip110ScanDeployment | null;
  signaling_blocks: Bip110ScanSignalingBlock[];
  error: string | null;
}

export interface BitcoindTestResponse {
  ok: boolean;
  chain?: string | null;
  blocks?: number | null;
  headers?: number | null;
  best_block_hash?: string | null;
  error?: string | null;
}

export interface ElectrsTestResponse {
  ok: boolean;
  genesis_version?: number | null;
  error?: string | null;
}

export interface FinanceRangeResponse {
  range: ChartRange;
  window_ms: number | null;
  tick_count: number;
  first_tick_at: number | null;
  last_tick_at: number | null;
  avg_hashprice_sat_per_ph_day: number | null;
  avg_delivered_ph: number | null;
  actual_spend_sat: number | null;
  actual_spend_per_day_sat: number | null;
  projected_income_per_day_sat: number | null;
  net_per_day_sat: number | null;
  insufficient_history: boolean;
}

export interface FinanceResponse {
  spent_sat: number;
  spent_scope: 'autopilot' | 'account';
  spent_closed_sat: number | null;
  spent_active_sat: number | null;
  collected_sat: number | null;
  /** #97 — distinguishes "first scan still running" (computing) from "0 sat collected" (ready) from "observer disabled" (idle). */
  collected_status: 'computing' | 'ready' | 'idle';
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
  /**
   * `share_log_pct` recorded by the closest tick to this block, when
   * available. Null for blocks older than our tick history (predates
   * migration 0048 or pruned). Tooltip prefers this for the "our share"
   * estimate so the value reflects the share_log at the block's moment;
   * only falls back to the live share_log + drift caveat when null.
   */
  share_log_pct_at_block: number | null;
  /**
   * #94: true when the block's header version field signals BIP-110
   * support. Null when the version couldn't be looked up (no
   * bitcoind/electrs configured, or the lookup failed). Drives the
   * crown chart marker; null/false fall back to the standard cube.
   */
  signals_bip110: boolean | null;
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
  /**
   * Pool luck multipliers (24h / 7d) computed daemon-side using the
   * same formula as the chart's right axis. Reading is consistent
   * across panel and chart at the moment of every find. Null when
   * any input is unavailable.
   */
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
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
