import { describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { gate } from './gate.js';
import type { Proposal, State } from './types.js';

const BASE_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://d:23334',
  destination_pool_worker_name: 'otto',
  btc_payout_address: 'bc1qexample',
  telegram_chat_id: '1',
};

function state(overrides: Partial<State> = {}): State {
  return {
    tick_at: 10_000_000,
    run_mode: 'LIVE',
    action_mode: 'NORMAL',
    operator_available: true,
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
    above_floor_since: null,
    above_floor_ticks: 0,
    manual_override_until_ms: null,
    pool: { reachable: true, last_ok_at: null, consecutive_failures: 0 },
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

describe('gate — run-mode gating', () => {
  it('blocks CREATE in DRY_RUN', () => {
    const [outcome] = gate([CREATE], state({ run_mode: 'DRY_RUN' }));
    expect(outcome).toMatchObject({ allowed: false, reason: 'RUN_MODE_NOT_LIVE' });
  });

  it('allows CREATE in LIVE + NORMAL', () => {
    const [outcome] = gate([CREATE], state());
    expect(outcome).toMatchObject({ allowed: true });
  });

  it('blocks all actions in PAUSED', () => {
    const results = gate([CREATE, EDIT_DOWN, CANCEL], state({ run_mode: 'PAUSED' }));
    for (const r of results) {
      expect(r).toMatchObject({ allowed: false, reason: 'RUN_MODE_PAUSED' });
    }
  });
});

describe('gate — action-mode gating', () => {
  it('blocks CREATE/EDIT during QUIET_HOURS but allows CANCEL', () => {
    const [c, e, x] = gate([CREATE, EDIT_DOWN, CANCEL], state({ action_mode: 'QUIET_HOURS' }));
    expect(c).toMatchObject({ allowed: false, reason: 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT' });
    expect(e).toMatchObject({ allowed: false, reason: 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT' });
    expect(x).toMatchObject({ allowed: true });
  });

  it('always allows PAUSE regardless of mode', () => {
    const [p] = gate([PAUSE], state({ run_mode: 'DRY_RUN', action_mode: 'QUIET_HOURS' }));
    expect(p).toMatchObject({ allowed: true });
  });
});

describe('gate — price-decrease cooldown', () => {
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
