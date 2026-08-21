import { describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { gate } from './gate.js';
import type { Proposal, State } from './types.js';

const BASE_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://d:23334',
  destination_pool_worker_name: 'otto',
  btc_payout_address: 'bc1qexample',
};

function state(overrides: Partial<State> = {}): State {
  return {
    tick_at: 10_000_000,
    run_mode: 'LIVE',
    config: BASE_CONFIG,
    market: {
      stats: {} as never,
      orderbook: { bids: [], asks: [] } as unknown as State['market'] extends infer M ? (M extends null ? never : M['orderbook']) : never,
      settings: { min_bid_price_decrease_period_s: 600 } as unknown as State['market'] extends infer M ? (M extends null ? never : M['settings']) : never,
      fee: {} as never,
      best_ask_sat: null,
      best_bid_sat: null,
    } as unknown as State['market'],
    balance: null,
    owned_bids: [],
    unknown_bids: [],
    actual_hashrate: { owned_ph: 0, unknown_ph: 0, total_ph: 0 },
    below_floor_since: null,
    above_floor_ticks: 0,
    manual_override_until_ms: null,
    pool: { reachable: true, last_ok_at: null, consecutive_failures: 0, error: null, latency_ms: null },
    create_hold: null,
    node_stale: false,
    last_api_ok_at: null,
    ...overrides,
  };
}

const CREATE: Proposal = {
  kind: 'CREATE_BID',
  price_sat: 45_001_000,
  amount_sat: 50_000,
  speed_limit_ph: 2,
  dest_pool_url: 'stratum+tcp://d:23334',
  dest_worker_name: 'otto',
  reason: 'no_owned_bids',
};
const EDIT_DOWN: Proposal = {
  kind: 'EDIT_PRICE',
  braiins_order_id: 'bid-a',
  new_price_sat: 45_000_000,
  old_price_sat: 50_000_000,
  reason: 'overpaying',
};
const EDIT_UP: Proposal = {
  kind: 'EDIT_PRICE',
  braiins_order_id: 'bid-a',
  new_price_sat: 55_000_000,
  old_price_sat: 50_000_000,
  reason: 'raising cap',
};
const CANCEL: Proposal = { kind: 'CANCEL_BID', braiins_order_id: 'bid-a', reason: 'extra' };
const PAUSE: Proposal = { kind: 'PAUSE', reason: 'unknown_bids_present' };

describe('gate - run-mode gating', () => {
  it('blocks CREATE in DRY_RUN', () => {
    const [outcome] = gate([CREATE], state({ run_mode: 'DRY_RUN' }));
    expect(outcome).toMatchObject({ allowed: false, reason: 'RUN_MODE_NOT_LIVE' });
  });

  it('allows CREATE in LIVE', () => {
    const [outcome] = gate([CREATE], state());
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('blocks all actions in PAUSED', () => {
    const results = gate([CREATE, EDIT_DOWN, CANCEL], state({ run_mode: 'PAUSED' }));
    for (const r of results) {
      expect(r).toMatchObject({ allowed: false, reason: 'RUN_MODE_PAUSED' });
    }
  });

  it('always allows PAUSE regardless of run mode', () => {
    const [p] = gate([PAUSE], state({ run_mode: 'DRY_RUN' }));
    expect(p).toMatchObject({ allowed: true });
  });
});

describe('gate - price-decrease cooldown', () => {
  it('blocks an EDIT_PRICE that decreases inside the cooldown window', () => {
    const s = state({
      owned_bids: [
        {
          braiins_order_id: 'bid-a',
          cl_order_id: null,
          price_sat: 50_000_000,
          amount_sat: 50_000,
          speed_limit_ph: 2,
          status: 'BID_STATUS_ACTIVE',
          last_price_decrease_at: 10_000_000 - 100_000, // 100s ago, inside 600s cooldown
        },
      ],
    });
    const [outcome] = gate([EDIT_DOWN], s);
    expect(outcome).toMatchObject({ allowed: false, reason: 'PRICE_DECREASE_COOLDOWN' });
  });

  it('allows an EDIT_PRICE that raises the price even inside the cooldown window', () => {
    const s = state({
      owned_bids: [
        {
          braiins_order_id: 'bid-a',
          cl_order_id: null,
          price_sat: 50_000_000,
          amount_sat: 50_000,
          speed_limit_ph: 2,
          status: 'BID_STATUS_ACTIVE',
          last_price_decrease_at: 10_000_000 - 100_000,
        },
      ],
    });
    const [outcome] = gate([EDIT_UP], s);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('allows an EDIT_PRICE past the cooldown window', () => {
    const s = state({
      owned_bids: [
        {
          braiins_order_id: 'bid-a',
          cl_order_id: null,
          price_sat: 50_000_000,
          amount_sat: 50_000,
          speed_limit_ph: 2,
          status: 'BID_STATUS_ACTIVE',
          last_price_decrease_at: 10_000_000 - 601_000, // past 600s
        },
      ],
    });
    const [outcome] = gate([EDIT_DOWN], s);
    expect(outcome).toMatchObject({ allowed: true });
  });
});

// #222: fee-threshold halt. When any active owned bid carries a
// fee_rate_pct above config.max_acceptable_fee_pct, the gate blocks
// CREATE / EDIT_PRICE / EDIT_SPEED but still allows CANCEL_BID so
// the operator (or the Datum-down auto-cancel) can bail out of a
// fee-bearing bid.
describe('gate - fee-threshold halt (#222)', () => {
  function bidWithFee(
    feePct: number | null,
    status = 'BID_STATUS_ACTIVE',
  ): State['owned_bids'][number] {
    return {
      braiins_order_id: 'bid-a',
      cl_order_id: null,
      price_sat: 50_000_000,
      amount_sat: 50_000,
      speed_limit_ph: 2,
      avg_speed_ph: 0,
      progress_pct: 0,
      amount_remaining_sat: 50_000,
      amount_consumed_sat: 0,
      status,
      last_price_decrease_at: null,
      last_pause_reason: null,
      fee_rate_pct: feePct,
    };
  }

  it('default config (max_acceptable_fee_pct = 0): any non-zero fee blocks CREATE', () => {
    const s = state({ owned_bids: [bidWithFee(0.5)] });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: false, reason: 'FEE_THRESHOLD_EXCEEDED' });
  });

  it('default config: any non-zero fee blocks EDIT_PRICE', () => {
    const s = state({ owned_bids: [bidWithFee(0.01)] });
    const [outcome] = gate([EDIT_UP], s);
    expect(outcome).toMatchObject({ allowed: false, reason: 'FEE_THRESHOLD_EXCEEDED' });
  });

  it('CANCEL is allowed even when the fee threshold is exceeded (escape hatch)', () => {
    const s = state({ owned_bids: [bidWithFee(5)] });
    const [outcome] = gate([CANCEL], s);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('fee at the threshold (equal) does NOT trip the halt (> not >=)', () => {
    const s = state({
      config: { ...BASE_CONFIG, max_acceptable_fee_pct: 1 },
      owned_bids: [bidWithFee(1)],
    });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('fee above an operator-raised threshold still trips', () => {
    const s = state({
      config: { ...BASE_CONFIG, max_acceptable_fee_pct: 1 },
      owned_bids: [bidWithFee(1.5)],
    });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: false, reason: 'FEE_THRESHOLD_EXCEEDED' });
  });

  it('non-ACTIVE bid with a non-zero fee does NOT trip the halt', () => {
    // Finished/paused bids carrying a stale fee_rate_pct in the
    // snapshot would otherwise lock the operator out indefinitely.
    const s = state({
      owned_bids: [bidWithFee(2, 'BID_STATUS_FINISHED')],
    });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('null fee_rate_pct (pre-migration / missing field) does NOT trip the halt', () => {
    const s = state({ owned_bids: [bidWithFee(null)] });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('empty owned_bids does NOT trip the halt', () => {
    const s = state({ owned_bids: [] });
    const [outcome] = gate([CREATE], s);
    expect(outcome).toMatchObject({ allowed: true });
  });
});
