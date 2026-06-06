import type { ChartRange } from '@hashrate-autopilot/shared';

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
    throw new Error(`${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
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
  total_balance_sat: number | null;
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
   * effective rate - drives the chart's "effective" line. Null for
   * pre-migration ticks and ticks with no primary owned bid.
   */
  primary_bid_consumed_sat: number | null;
  // #93: extended series for the per-chart secondary Y-axis dropdown.
  network_difficulty: number | null;
  pool_hashrate_ph: number | null;
  estimated_block_reward_sat: number | null;
  btc_usd_price: number | null;
  ocean_unpaid_sat: number | null;
  paid_total_sat: number | null;
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
  pool_luck_30d: number | null;
  pool_blocks_30d_count: number | null;
  pool_hashrate_ph_avg_30d: number | null;
  braiins_reachable: number | null;
  /**
   * #224 (#222): bid_edit_deadband_pct in effect at this tick.
   * Read by the EDIT_PRICE event tooltip to show the historical
   * deadband value via nearest-tick lookup. Backfilled to 20 by
   * migration 0100 for pre-existing rows.
   */
  bid_edit_deadband_pct: number;
  /**
   * #243: primary owned bid's cumulative-since-bid-creation share
   * counters sampled from Braiins `/spot/bid/detail.counters_committed`.
   * The chart's `braiins_rejection_pct` right-axis series derives the
   * instantaneous per-tick rate as `Δrejected / Δpurchased × 100`,
   * NULL-skipping ticks where Δpurchased ≤ 0 (counter reset on bid
   * rotation, or no shares purchased in the bucket).
   */
  primary_bid_shares_purchased_m: number | null;
  primary_bid_shares_accepted_m: number | null;
  primary_bid_shares_rejected_m: number | null;
}

/** #256 follow-up: one bid's roll-up shown as a collapsible header on the History page. */
export interface BidHistorySummary {
  braiins_order_id: string;
  first_event_at_ms: number;
  last_event_at_ms: number;
  first_price_sat_per_ph_day: number | null;
  last_price_sat_per_ph_day: number | null;
  event_count: number;
  status: 'cancelled' | 'closed_or_active';
}

export interface BidHistoryPage {
  bids: BidHistorySummary[];
  /** Pass to `bidHistorySummaries` to fetch the next page; null when this was the last page. */
  next_cursor_ms: number | null;
}

/** #256 v2: flat-table toolbar filter shape. */
export interface BidHistoryFilters {
  kinds?: ReadonlyArray<'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID'>;
  source?: 'AUTOPILOT' | 'OPERATOR';
  orderIdContains?: string;
  sinceMs?: number;
  untilMs?: number;
  /** In sat/PH/day. EDIT_PRICE events with |Δ| < this are hidden. */
  minAbsPriceDelta?: number;
}

/** #256 v2: one row on the flat /history table. */
export interface BidHistoryFlatEvent extends BidEventView {
  /** Fillable ask at the moment of the event, sat/PH/day. Null when no qualifying tick. */
  fillable_at_event_sat_per_ph_day: number | null;
}

export interface BidHistoryFlatPage {
  events: BidHistoryFlatEvent[];
  next_cursor_id: number | null;
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
  /** #120: snapshot of overpay setting at event time. Null on legacy rows. */
  overpay_sat_per_ph_day: number | null;
  /** #120: snapshot of dynamic-cap ceiling at event time. Null on legacy rows. */
  max_overpay_vs_hashprice_sat_per_ph_day: number | null;
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
  // action_mode collapsed to 'NORMAL' in spec v1.1 when the owner-token
  // API was found to bypass 2FA. Stale QUIET_HOURS / PENDING_CONFIRMATION /
  // CONFIRMATION_TIMEOUT members removed; the daemon never sends them now
  // (see packages/shared/src/types.ts ActionMode).
  action_mode: 'NORMAL';
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
    error: string | null;
    latency_ms: number | null;
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
  /** #222: EDIT_PRICE deadband as a percentage of overpay. Default 20 = legacy `overpay/5`. */
  bid_edit_deadband_pct: number;
  /** #222: operator-acceptable max Braiins fee_rate_pct before gate halts CREATE/EDIT. Default 0. */
  max_acceptable_fee_pct: number;
  bid_budget_sat: number;
  wallet_runway_alert_days: number;
  below_floor_alert_after_minutes: number;
  zero_hashrate_loud_alert_after_minutes: number;
  pool_outage_blip_tolerance_seconds: number;
  datum_unreachable_alert_after_minutes: number;
  sustained_paused_alert_after_minutes: number;
  api_outage_alert_after_minutes: number;
  handover_window_minutes: number;
  btc_payout_address: string;
  telegram_chat_id: string;
  telegram_bot_token: string;
  telegram_instance_label: string;
  notifications_muted: boolean;
  notification_retry_interval_minutes: number;
  notification_disabled_event_classes: string[];
  notify_on_pool_block_credit: boolean;
  notify_on_braiins_deposit: boolean;
  /** #226: payout-initiated Telegram alert (Ocean debited unpaid_sat). Off by default. */
  notify_on_payout_initiated: boolean;
  /** #226: payout-confirmed Telegram alert (on-chain coinbase to payout address). Off by default. */
  notify_on_payout_confirmed: boolean;
  /** #227 follow-up: display number format ('system' | 'en-US' | 'nl-NL' | 'fr-FR' | 'no-grouping'). */
  display_number_locale: string;
  /** #227 follow-up: display date layout ('system' | 'us' | 'eu-spaced-24h' | 'slash-dmy-24h' | 'iso' | 'slash-mdy-12h'). */
  display_date_layout: string;
  /** #238: per-series chart color overrides as a JSON string. Empty
   *  `'{}'` means use every series's built-in default. Parsed
   *  defensively via `lib/chartColors.parseOverrides`. */
  chart_color_overrides: string;
  /** #266: StatsBar tile selection + order as a JSON-encoded array of
   *  catalogue ids. `'[]'` means "use the dashboard defaults".
   *  Parsed via `parseDashboardTiles` from `@hashrate-autopilot/shared`. */
  dashboard_tiles: string;
  /** #244: RESERVED / dormant. Daemon-side card-order column kept for
   *  forward compatibility; the dashboard stores the drag-chosen order
   *  per-device in localStorage (see lib/cardOrder) and does not read or
   *  write this field. Always `'[]'` in practice. */
  dashboard_card_order: string;
  notification_locale: 'en' | 'nl' | 'es';
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
  alerts_retention_days: number;
  chart_max_markers: number;
  datum_api_url: string | null;
  block_explorer_url_template: string;
  block_explorer_tx_url_template: string;
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
    | 'ocean-mining-found-block'
    | 'custom';
  // #111: daemon-managed Dynamic DNS updater. Empty provider = disabled.
  ddns_provider: '' | 'noip' | 'duckdns' | 'dyndns2';
  ddns_hostname: string;
  ddns_username: string;
  ddns_credential: string;
  ddns_update_url: string;
  // #149: solo-mining monitoring (Bitaxe / AxeOS).
  solo_mining_enabled: boolean;
  solo_overheating_threshold_celsius: number;
  solo_zero_hashrate_alert_after_minutes: number;
  solo_share_rejection_threshold_pct: number;
  solo_share_rejection_window_minutes: number;
  // #167: minutes the Braiins marketplace must be empty (no fillable + delivery ~0) before the Telegram alert fires.
  marketplace_empty_alert_after_minutes: number;
  // #170: when true, the payout-observer backfills ALL historical coinbase receipts at the payout address into reward_events (not just currently-unspent UTXOs).
  include_historical_payouts: boolean;
  // #170 follow-up: operator-entered offset for pre-installation / off-chain earnings; added to lifetime-earnings chart and net P&L. Always >= 0.
  historical_payouts_offset_sat: number;
  debug_api_enabled: boolean;
}

export interface ConfigResponse {
  config: AppConfig;
}

// #149: solo-mining monitoring (Bitaxe / AxeOS / Nerdaxe). The
// daemon polls each enabled device every tick when the master
// toggle is on; the dashboard reads the resulting in-memory snapshot
// here to render the Status card + chart series.

export interface SoloMinerDevice {
  id: number;
  label: string;
  ip: string;
  enabled: boolean;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface SoloMinerSnapshotEntry {
  device: SoloMinerDevice;
  last_polled_at: number;
  reachable: boolean;
  hashrate_instant_ghs: number | null;
  hashrate_1m_ghs: number | null;
  hashrate_10m_ghs: number | null;
  hashrate_1h_ghs: number | null;
  expected_hashrate_ghs: number | null;
  temp_c: number | null;
  vr_temp_c: number | null;
  power_w: number | null;
  voltage_v: number | null;
  current_a: number | null;
  shares_accepted: number | null;
  shares_rejected: number | null;
  uptime_seconds: number | null;
  asic_model: string | null;
  version: string | null;
  stratum_url: string | null;
  stratum_port: number | null;
  stratum_user: string | null;
  best_diff_text: string | null;
  best_session_diff_text: string | null;
  /** Exact numeric best difficulty (#260); text fields are display-formatted. */
  best_diff_numeric: number | null;
  error: string | null;
}

export interface SoloScanCandidate {
  ip: string;
  asic_model: string | null;
  version: string | null;
  hashrate_ghs: number | null;
  already_added: boolean;
}

export type SoloScanState = 'idle' | 'running' | 'done' | 'error';

export interface SoloScanStatus {
  state: SoloScanState;
  cidr: string;
  done: number;
  total: number;
  candidates: SoloScanCandidate[];
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface SoloScanStartResponse {
  ok: boolean;
  error: string | null;
  status: SoloScanStatus;
}

export interface SoloFleetSeriesRow {
  tick_at: number;
  total_hashrate_ghs: number | null;
  total_power_w: number | null;
  max_temp_c: number | null;
  device_count: number;
  max_best_diff: number | null;
}

export interface SoloFleetSeriesResponse {
  rows: SoloFleetSeriesRow[];
}

export interface SoloBestDiffEvent {
  recorded_at: number;
  difficulty: number;
}

export interface SoloBestDiffEventsResponse {
  events: SoloBestDiffEvent[];
}

export interface SoloMinersResponse {
  devices: SoloMinerDevice[];
  snapshot: {
    enabled: boolean;
    entries: SoloMinerSnapshotEntry[];
  };
}

export interface SoloMinerMutationResponse {
  ok: boolean;
  device?: SoloMinerDevice;
  error?: string;
}

// #111: DDNS + public IP diagnostics for the dashboard.
export interface DdnsSnapshot {
  enabled: boolean;
  provider: string;
  hostname: string;
  last_status: string | null;
  last_pushed_ip: string | null;
  last_pushed_at: number | null;
  last_attempted_at: number | null;
  last_error: string | null;
}

// #250: one observed public-IP rotation (old -> new) at a point in time.
export interface IpChangeEvent {
  id: number;
  occurred_at: number;
  old_ip: string | null;
  new_ip: string;
}

export interface DdnsRouteResponse {
  daemon_public_ip: string | null;
  daemon_public_ip_checked_at: number | null;
  daemon_public_ip_error: string | null;
  pool_url_hostname: string | null;
  pool_url_resolves_to: string | null;
  pool_url_resolve_error: string | null;
  ddns: DdnsSnapshot;
  /** #250: last time the public IP actually changed (distinct from the
   *  DDNS heartbeat push). Null until a rotation has been recorded. */
  last_ip_change: { occurred_at: number; old_ip: string | null; new_ip: string } | null;
  checked_at: number;
}

export interface DdnsTestResponse {
  ok: boolean;
  status?: string;
  ip?: string;
  raw?: string;
  error?: string;
}

export interface PoolUrlTestResponse {
  ok: boolean;
  host?: string;
  port?: number;
  latency_ms?: number | null;
  error?: string;
}

export interface DatumTestResponse {
  ok: boolean;
  connections?: number | null;
  hashrate_ph?: number | null;
  error?: string;
}

// #113: stale-URL bids - active Braiins bids whose dest_upstream URL
// differs from the current `destination_pool_url` setting.
export interface StaleUrlBid {
  bid_id: string;
  created_at: number;
  old_host_port: string;
  new_host_port: string;
  amount_sat: number | null;
  amount_consumed_sat: number;
  unconsumed_sat: number | null;
  status: string | null;
}

export interface StaleUrlsResponse {
  stale: StaleUrlBid[];
  current_destination_pool_url: string;
  current_host_port: string | null;
  checked_at: number;
}

// ---------------------------------------------------------------------------
// First-run onboarding wizard (#57) - public endpoints, no auth.
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
   * Bitcoin Knots RPC creds discovered in the appliance's standard
   * env vars (Umbrel/Start9 inject `BITCOIN_RPC_*` when an app
   * declares a Bitcoin Knots dependency). Each field is `null` when
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

/** Public probe - no auth, returns 200 in both setup and operational modes. */
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
    throw new Error(`${res.status} ${res.statusText}${text ? ` - ${text}` : ''}`);
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
  tickNow: () => request<TickNowResponse>('/api/actions/tick-now', { method: 'POST' }),
  metrics: (range: ChartRange) =>
    request<{ points: MetricPoint[]; range: ChartRange | null }>(
      `/api/metrics?range=${encodeURIComponent(range)}`,
    ),
  metricsViewport: (since: number, until: number, visibleSpan?: number) =>
    request<{ points: MetricPoint[]; range: ChartRange | null }>(
      `/api/metrics?since=${since}&until=${until}${visibleSpan != null ? `&span=${visibleSpan}` : ''}`,
    ),
  bidEvents: (range: ChartRange) =>
    request<{ events: BidEventView[] }>(
      `/api/bid-events?range=${encodeURIComponent(range)}`,
    ),
  bidEventsViewport: (since: number, until: number, visibleSpan?: number) =>
    request<{ events: BidEventView[] }>(
      `/api/bid-events?since=${since}&until=${until}${
        visibleSpan != null ? `&span=${visibleSpan}` : ''
      }`,
    ),
  // #256 follow-up: history page endpoints.
  bidHistorySummaries: (limit = 20, beforeMs?: number) =>
    request<BidHistoryPage>(
      `/api/bid-history?limit=${limit}${beforeMs ? `&before_ms=${beforeMs}` : ''}`,
    ),
  bidHistoryEvents: (orderId: string) =>
    request<{ events: BidEventView[] }>(
      `/api/bid-history/${encodeURIComponent(orderId)}/events`,
    ),
  // #256 v2: flat-table page endpoint.
  bidHistoryFlatEvents: (filters: BidHistoryFilters, beforeId?: number, limit = 100) => {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit));
    if (beforeId !== undefined) qs.set('before_id', String(beforeId));
    if (filters.kinds && filters.kinds.length > 0) qs.set('kinds', filters.kinds.join(','));
    if (filters.source) qs.set('source', filters.source);
    if (filters.orderIdContains) qs.set('order_id', filters.orderIdContains);
    if (filters.sinceMs != null) qs.set('since_ms', String(filters.sinceMs));
    if (filters.untilMs != null) qs.set('until_ms', String(filters.untilMs));
    if (filters.minAbsPriceDelta != null && filters.minAbsPriceDelta > 0) {
      qs.set('min_abs_price_delta', String(filters.minAbsPriceDelta));
    }
    return request<BidHistoryFlatPage>(`/api/bid-history-events?${qs.toString()}`);
  },
  // #250: public-IP change markers for the charts.
  ipChangesViewport: (since: number, until: number) =>
    request<{ events: IpChangeEvent[] }>(
      `/api/ip-changes?since=${since}&until=${until}`,
    ),
  payouts: () => request<PayoutsResponse>('/api/payouts'),
  scanPayouts: () => request<{ ok: boolean; error?: string }>('/api/payouts/scan', { method: 'POST' }),
  backfillPayouts: () =>
    request<{
      ok: boolean;
      error?: string;
      inserted: number;
      with_matching_outputs: number;
      tx_seen: number;
      duration_ms: number;
    }>('/api/payouts/backfill', { method: 'POST' }),
  rewardEvents: (limit?: number) =>
    request<RewardEventsResponse>(
      `/api/reward-events${limit ? `?limit=${limit}` : ''}`,
    ),
  deposits: (limit?: number) =>
    request<DepositsResponse>(
      `/api/deposits${limit ? `?limit=${limit}` : ''}`,
    ),
  uploadBlockFoundSound: (dataBase64: string, mime: string, filename: string | null) =>
    request<{ ok: boolean; bytes?: number; mime?: string; filename?: string | null; error?: string }>(
      '/api/config/block-found-sound',
      {
        method: 'POST',
        body: JSON.stringify({ data_base64: dataBase64, mime, filename }),
      },
    ),
  blockFoundSoundStatus: () =>
    request<{
      has_blob: boolean;
      bytes: number | null;
      mime: string | null;
      filename: string | null;
    }>('/api/config/block-found-sound/status'),
  // Custom block-found sound is served from an auth-gated /api route,
  // and HTML5 <audio> doesn't include Basic Auth headers when fetching
  // its src. We have to fetch the bytes through our own request path,
  // wrap as a Blob, and hand the audio element a blob: URL. Caller is
  // responsible for revoking the URL when it's no longer needed
  // (`URL.revokeObjectURL(url)`); leaking object URLs will eventually
  // exhaust browser handles. Returns null when no blob is on the
  // daemon (404 from the GET).
  blockFoundSoundBlobUrl: async (): Promise<string | null> => {
    const password = getPassword();
    const headers = new Headers();
    if (password) headers.set('Authorization', basicAuthHeader(password));
    const res = await fetch('/api/config/block-found-sound', { headers });
    if (res.status === 401) {
      clearPassword();
      throw new UnauthorizedError();
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  btcPrice: () => request<BtcPriceResponse>('/api/btc-price'),
  /** #270: live oracle probe for the Config panel's Test connection button. */
  btcPriceTest: (source: string) =>
    request<BtcPriceTestResponse>('/api/btc-price/test', {
      method: 'POST',
      body: JSON.stringify({ source }),
    }),
  /** #272: one-shot support bundle (runs all connectivity probes server-side, ~5s). */
  diagnostics: () => request<DiagnosticsResponse>('/api/diagnostics'),
  ddns: () => request<DdnsRouteResponse>('/api/ddns'),
  // #149: solo-mining device list + live AxeOS snapshot.
  soloMiners: () => request<SoloMinersResponse>('/api/solo-miners'),
  createSoloMiner: (body: { label: string; ip: string; enabled?: boolean }) =>
    request<SoloMinerMutationResponse>('/api/solo-miners', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateSoloMiner: (
    id: number,
    body: { label?: string; ip?: string; enabled?: boolean; sort_order?: number },
  ) =>
    request<SoloMinerMutationResponse>(`/api/solo-miners/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteSoloMiner: (id: number) =>
    request<{ ok: boolean }>(`/api/solo-miners/${id}`, { method: 'DELETE' }),
  startSoloMinersScan: (cidr?: string) =>
    request<SoloScanStartResponse>('/api/solo-miners/scan', {
      method: 'POST',
      body: JSON.stringify(cidr && cidr.trim() ? { cidr: cidr.trim() } : {}),
    }),
  soloMinersScanStatus: () =>
    request<SoloScanStatus>('/api/solo-miners/scan/status'),
  cancelSoloMinersScan: () =>
    request<SoloScanStatus>('/api/solo-miners/scan/cancel', { method: 'POST' }),
  soloFleetSeries: (sinceMs?: number) => {
    const q = sinceMs !== undefined ? `?since=${sinceMs}` : '';
    return request<SoloFleetSeriesResponse>(`/api/solo-miners/series${q}`);
  },
  soloBestDiffEvents: (sinceMs?: number) => {
    const q = sinceMs !== undefined ? `?since=${sinceMs}` : '';
    return request<SoloBestDiffEventsResponse>(`/api/solo-miners/best-diff-events${q}`);
  },
  staleUrls: () => request<StaleUrlsResponse>('/api/stale-urls'),
  cancelStaleUrlBid: (bidId: string) =>
    request<{ ok: boolean; error?: string }>('/api/stale-urls/cancel', {
      method: 'POST',
      body: JSON.stringify({ bid_id: bidId }),
    }),
  ddnsTest: (creds: {
    provider: string;
    hostname: string;
    username: string;
    credential: string;
    update_url?: string;
  }) =>
    request<DdnsTestResponse>('/api/ddns/test', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),
  poolUrlTest: (url: string) =>
    request<PoolUrlTestResponse>('/api/pool-url/test', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  datumTest: (url: string) =>
    request<DatumTestResponse>('/api/datum/test', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  /** #231 follow-up #3: two-option range - `current` (in-progress
   *  epoch) or `all` (everything since the first known BIP 110
   *  signaling block, height 938,903 on 2026-03-01). */
  bip110Scan: (range: 'current' | 'all') =>
    request<Bip110ScanResponse>(`/api/bip110/scan?range=${encodeURIComponent(range)}`),
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
  notificationsTest: (creds: {
    bot_token: string;
    chat_id: string;
    instance_label?: string;
  }) =>
    request<NotificationsTestResponse>('/api/notifications/test', {
      method: 'POST',
      body: JSON.stringify(creds),
    }),
  notificationsTestEvent: (event_class: string) =>
    request<NotificationsTestResponse>('/api/notifications/test-event', {
      method: 'POST',
      body: JSON.stringify({ event_class }),
    }),
  build: () => request<BuildInfoResponse>('/api/build'),
  alertsList: (filters: AlertsListFilters = {}) => {
    const qs = new URLSearchParams();
    if (filters.since_ms !== undefined) qs.set('since_ms', String(filters.since_ms));
    if (filters.before_created_at_ms !== undefined)
      qs.set('before_created_at_ms', String(filters.before_created_at_ms));
    if (filters.severity) qs.set('severity', filters.severity);
    if (filters.delivery_status) qs.set('delivery_status', filters.delivery_status);
    if (filters.unacknowledged_only) qs.set('unacknowledged_only', 'true');
    if (filters.limit !== undefined) qs.set('limit', String(filters.limit));
    const q = qs.toString();
    return request<AlertsListResponse>(`/api/alerts${q ? '?' + q : ''}`);
  },
  alertAcknowledge: (id: number) =>
    request<{ ok: true; acknowledged_at_ms: number }>(`/api/alerts/${id}/acknowledge`, {
      method: 'POST',
      body: '{}',
    }),
  alertAcknowledgeAll: () =>
    request<{ ok: true; acknowledged_at_ms: number; count: number }>(
      '/api/alerts/acknowledge-all',
      { method: 'POST', body: '{}' },
    ),
  finance: () => request<FinanceResponse>('/api/finance'),
  financeRange: (range: ChartRange) =>
    request<FinanceRangeResponse>(
      `/api/finance/range?range=${encodeURIComponent(range)}`,
    ),
  financeRangeViewport: (since: number, until: number) =>
    request<FinanceRangeResponse>(
      `/api/finance/range?since=${since}&until=${until}`,
    ),
  rebuildSpendCache: () =>
    request<{ ok: boolean; error?: string }>('/api/finance/spend/rebuild', {
      method: 'POST',
    }),
  stats: (range: ChartRange) =>
    request<StatsResponse>(`/api/stats?range=${encodeURIComponent(range)}`),
  statsViewport: (since: number, until: number) =>
    request<StatsResponse>(`/api/stats?since=${since}&until=${until}`),
  storageEstimate: () => request<StorageEstimateResponse>('/api/storage-estimate'),
  ocean: () => request<OceanResponse>('/api/ocean'),
  // Test-auth call: hits /api/status to validate credentials.
  checkAuth: () => request<StatusResponse>('/api/status'),
};

export interface StatsResponse {
  uptime_pct: number | null;
  /** #254: % of window time with an active Braiins bid (orderbook coverage). */
  uptime_bid_coverage_pct: number | null;
  /** #254: % of bid-active time that actually delivered hashrate (hardware/connection quality). */
  uptime_delivery_when_bid_active_pct: number | null;
  avg_hashrate_ph: number | null;
  avg_datum_hashrate_ph: number | null;
  avg_ocean_hashrate_ph: number | null;
  total_ph_hours: number | null;
  avg_overpay_vs_hashprice_sat_per_ph_day: number | null;
  avg_cost_per_ph_sat_per_ph_day: number | null;
  /** #164: time-weighted mean of (our_bid - fillable_ask) over the window. */
  avg_intent_overpay_sat_per_ph_day: number | null;
  /** #164: delta-weighted mean of (effective_rate - fillable_ask) over the window. */
  avg_settled_overpay_sat_per_ph_day: number | null;
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

export interface DepositView {
  tx_id: string;
  amount_sat: number;
  address: string | null;
  first_seen_at_ms: number;
  tx_timestamp_ms: number | null;
  credited_at_ms: number | null;
}

export interface DepositsResponse {
  deposits: DepositView[];
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
  alerts: StorageEstimateBucket;
  db_file_bytes: number | null;
  sample_days: number;
  computed_at: number;
}

export interface BtcPriceResponse {
  usd_per_btc: number | null;
  source: string;
  fetched_at_ms: number | null;
}

/** #270: response of POST /api/btc-price/test. */
export interface BtcPriceTestResponse {
  ok: boolean;
  usd_per_btc: number | null;
  source: string;
  error: string | null;
}

/** #272: one entry of the diagnostics connectivity matrix. */
export interface ConnectivityProbe {
  target: string;
  status: 'ok' | 'failed' | 'not_configured';
  latency_ms: number | null;
  detail: string | null;
  error: string | null;
}

/** #272: GET /api/diagnostics support bundle. */
export interface DiagnosticsResponse {
  identity: {
    version: string;
    build: number;
    hash: string;
    node: string;
    platform: string;
    uptime_seconds: number;
    run_mode: string | null;
    tick_interval_ms: number;
  };
  config: Record<string, unknown>;
  connectivity: ConnectivityProbe[];
  tick_health: {
    last_tick_at: number | null;
    last_tick_age_seconds: number | null;
    braiins_reachable_last_tick: boolean | null;
    datum_data_last_tick: boolean | null;
    ocean_data_last_tick: boolean | null;
    btc_price_cache_age_seconds: number | null;
  };
}

export interface Bip110ScanSignalingBlock {
  height: number;
  hash: string;
  time_ms: number;
  version: number;
  version_hex: string;
  n_tx: number | null;
  size_bytes: number | null;
  weight: number | null;
  subsidy_sat: number;
  total_fees_sat: number | null;
  /** #237: pool identity from the coinbase. For Ocean blocks
   *  normalised to the literal "Ocean"; for non-Ocean blocks it's
   *  the longest printable run in the coinbase (Foundry USA Pool,
   *  AntPool, etc.). Null when there are no printable runs ≥3 chars. */
  pool_tag: string | null;
  /** #234 / #237: miner identity extracted from the coinbase. For Ocean
   *  blocks this is the inner-miner tag (e.g. "Roughnecks"), NOT the
   *  "<OCEAN.XYZ>" pool-wrapper signature. Null for non-Ocean blocks
   *  (the two-actor pool/miner distinction doesn't apply). */
  miner_tag: string | null;
}

export interface Bip110ScanDeployment {
  key: string;
  status: string | null;
  bit: number | null;
  /** #235: block height at which the deployment transitioned to its
   *  current status. Populated from bitcoind's `bip9.since`. Used to
   *  distinguish MASF (since < UASF height) from UASF (since == UASF
   *  height) activation in the ACTIVE-state tooltip. */
  since: number | null;
  statistics: {
    count: number;
    elapsed: number;
    threshold: number;
    period: number;
  } | null;
}

/**
 * #231: per-epoch signaling bucket. `start_height` is always a
 * multiple of 2016. For completed epochs, `end_height` is
 * `start_height + 2015` and `in_progress` is false. For the
 * current epoch, `end_height` is the chain tip and `in_progress`
 * is true; `signaling_pct` is therefore "progress so far" and is
 * directly comparable to the 55% MASF activation threshold.
 */
export interface Bip110EpochBucket {
  start_height: number;
  end_height: number;
  /** First and last block timestamps observed in the epoch's scanned
   *  range. Null when the epoch had no headers in the scan (defensive). */
  start_time_ms: number | null;
  end_time_ms: number | null;
  /** #233: linear-extrapolated forecast of when block 2016 of the
   *  in-progress epoch will be mined, based on the average block
   *  time observed in the bucket so far. Null for completed
   *  epochs and when an average can't be computed. */
  expected_end_time_ms: number | null;
  scanned: number;
  signaling_count: number;
  signaling_pct: number;
  in_progress: boolean;
}

export interface Bip110ScanResponse {
  rpc_available: boolean;
  tip_height: number | null;
  scanned: number;
  signaling_count: number;
  signaling_pct: number;
  /** #231: per-epoch breakdown, ordered earliest-first. */
  epochs: Bip110EpochBucket[];
  deployment: Bip110ScanDeployment | null;
  softfork_keys: string[] | null;
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

export interface NotificationsTestResponse {
  ok: boolean;
  error?: string | null;
}

export interface BuildInfoResponse {
  build: number;
  hash: string;
  version: string;
}

export type AlertSeverity = 'INFO' | 'WARNING' | 'IMPORTANT';
export type AlertDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'muted'
  | 'gave_up';

export interface AlertRow {
  id: number;
  created_at: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  status: 'BUFFERED' | 'SENT' | 'FAILED';
  sent_at: number | null;
  event_class: string | null;
  delivery_status: AlertDeliveryStatus;
  delivery_attempts: number;
  last_attempt_at_ms: number | null;
  next_retry_at_ms: number | null;
  paired_alert_id: number | null;
  delivery_meta_json: string | null;
  acknowledged_at_ms: number | null;
}

export interface AlertsListFilters {
  since_ms?: number;
  /** #121: cursor for descending pagination - rows strictly older than this. */
  before_created_at_ms?: number;
  severity?: AlertSeverity;
  delivery_status?: AlertDeliveryStatus;
  unacknowledged_only?: boolean;
  limit?: number;
}

export interface AlertsListResponse {
  alerts: AlertRow[];
  unacknowledged_high_severity_count: number;
  /** #121: total rows matching the filter set, ignoring pagination. */
  total_count: number;
  /** #121: are there older rows past the returned page? */
  has_more: boolean;
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
  /**
   * #243: Braiins primary-bid share rejection rate over the
   * selected range, computed server-side from raw `tick_metrics`
   * (NOT bucketed chart data). Bypasses the bucket-MAX precision
   * loss that made the card-from-chart-data calculation inconsistent
   * across range presets. Null on no data / no shares cleared / bid
   * rotation.
   */
  braiins_rejection_pct: number | null;
}

export interface FinanceResponse {
  spent_sat: number;
  spent_scope: 'autopilot' | 'account';
  spent_closed_sat: number | null;
  spent_active_sat: number | null;
  collected_sat: number | null;
  /** #97 - distinguishes "first scan still running" (computing) from "0 sat collected" (ready) from "observer disabled" (idle). */
  collected_status: 'computing' | 'ready' | 'idle';
  expected_sat: number | null;
  /** #170 follow-up: operator-entered pre-installation / off-chain earnings. Always >= 0. Already folded into net_sat. */
  historical_offset_sat: number;
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
 * Pool block that credited our wallet - surfaced as a cube marker on
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
  blocks_30d: number;
  blocks_all_time: number;
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
  pool_luck_30d: number | null;
  pool_luck_all_time: number | null;
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
