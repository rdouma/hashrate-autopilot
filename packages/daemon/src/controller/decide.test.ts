import { describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { decide } from './decide.js';
import type { MarketSnapshot, OwnedBidSnapshot, State, UnknownBidSnapshot } from './types.js';

// Post-#49 redesign: decide() is stateless on escalation / lowering /
// overpay — the entire fill-strategy machinery was retired after
// empirical verification that Braiins matches CLOB-style (bid is a
// ceiling, actual price = matched ask). These tests cover the
// remaining minimal contract:
//
//   - PAUSE on unknown bids
//   - skip on missing market / missing hashprice (when dynamic cap
//     is configured)
//   - CREATE at effective cap when no owned bid
//   - EDIT_PRICE to effective cap when bid diverges
//   - EDIT_SPEED on cheap-mode transitions
//   - CANCEL extras when multiple owned bids exist
//   - bid_budget_sat=0 sentinel → uses wallet balance, clamped to 1 BTC

const BASE_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://datum.local:23334',
  destination_pool_worker_name: 'otto',
  btc_payout_address: 'bc1qexample',
  telegram_chat_id: '1',
  max_overpay_vs_hashprice_sat_per_eh_day: null,
  bid_budget_sat: 200_000,
};

const FIXED_CAP = BASE_CONFIG.max_bid_sat_per_eh_day;

function market(cheapestAskSat: number = 45_000_000, tickSize = 1000): MarketSnapshot {
  return {
    stats: {} as MarketSnapshot['stats'],
    orderbook: {
      bids: [],
      asks: [
        { price_sat: cheapestAskSat, hr_available_ph: 10 },
        { price_sat: cheapestAskSat + 1_000_000, hr_available_ph: 50 },
      ],
    } as unknown as MarketSnapshot['orderbook'],
    settings: { tick_size_sat: tickSize, min_bid_speed_limit_ph: 1 } as unknown as MarketSnapshot['settings'],
    fee: { spot_fees: [] } as unknown as MarketSnapshot['fee'],
    best_ask_sat: cheapestAskSat,
    best_bid_sat: null,
  };
}

function state(overrides: Partial<State> = {}): State {
  return {
    tick_at: 1_700_000_000_000,
    run_mode: 'DRY_RUN',
    action_mode: 'NORMAL',
    operator_available: true,
    config: BASE_CONFIG,
    market: market(),
    balance: null,
    owned_bids: [],
    unknown_bids: [],
    actual_hashrate: { owned_ph: 0, unknown_ph: 0, total_ph: 0 },
    below_floor_since: null,
    lower_ready_since: null,
    below_target_since: null,
    above_floor_ticks: 0,
    manual_override_until_ms: null,
    pool: { reachable: true, last_ok_at: 1_700_000_000_000, consecutive_failures: 0 },
    last_api_ok_at: 1_700_000_000_000,
    hashprice_sat_per_ph_day: null,
    bypass_pacing: false,
    ...overrides,
  };
}

function owned(overrides: Partial<OwnedBidSnapshot> = {}): OwnedBidSnapshot {
  return {
    braiins_order_id: 'order-a',
    cl_order_id: null,
    price_sat: FIXED_CAP,
    amount_sat: 50_000,
    speed_limit_ph: BASE_CONFIG.target_hashrate_ph,
    avg_speed_ph: BASE_CONFIG.target_hashrate_ph,
    progress_pct: 10,
    amount_remaining_sat: 45_000,
    amount_consumed_sat: 5_000,
    status: 'BID_STATUS_ACTIVE',
    last_price_decrease_at: null,
    ...overrides,
  };
}

function unknown(overrides: Partial<UnknownBidSnapshot> = {}): UnknownBidSnapshot {
  return {
    braiins_order_id: 'foreign-x',
    price_sat: 44_000_000,
    amount_sat: 100_000,
    speed_limit_ph: 1.5,
    avg_speed_ph: 0.0,
    status: 'BID_STATUS_ACTIVE',
    ...overrides,
  };
}

describe('decide — case selection', () => {
  it('PAUSES when unknown bids are present', () => {
    const proposals = decide(state({ unknown_bids: [unknown()] }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'PAUSE' });
  });

  it('emits nothing when the market snapshot is null (API down)', () => {
    expect(decide(state({ market: null }))).toEqual([]);
  });

  it('refuses to trade when dynamic cap is configured but hashprice is unavailable (#28)', () => {
    const s = state({
      config: { ...BASE_CONFIG, max_overpay_vs_hashprice_sat_per_eh_day: 2_000_000 },
      hashprice_sat_per_ph_day: null,
    });
    expect(decide(s)).toEqual([]);
  });
});

describe('decide — CREATE path', () => {
  it('creates at the fixed effective cap when no dynamic cap is configured', () => {
    const proposals = decide(state());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: FIXED_CAP,
      amount_sat: 200_000,
    });
  });

  it('creates at the dynamic cap when it is tighter than fixed', () => {
    // hashprice 46,000 sat/PH/day × 1000 = 46_000_000 sat/EH/day;
    // dynamic cap allowance 1_500_000 → 47_500_000, below fixed (49M default).
    const s = state({
      config: {
        ...BASE_CONFIG,
        max_overpay_vs_hashprice_sat_per_eh_day: 1_500_000,
      },
      hashprice_sat_per_ph_day: 46_000,
    });
    const proposals = decide(s);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: 47_500_000,
    });
  });
});

describe('decide — EDIT_PRICE to effective cap', () => {
  it('does nothing when the bid is already at the effective cap', () => {
    expect(decide(state({ owned_bids: [owned()] }))).toEqual([]);
  });

  it('proposes EDIT_PRICE when the bid is below the effective cap', () => {
    const belowCap = FIXED_CAP - 500_000;
    const proposals = decide(state({ owned_bids: [owned({ price_sat: belowCap })] }));
    expect(proposals.find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: FIXED_CAP,
      old_price_sat: belowCap,
    });
  });

  it('proposes EDIT_PRICE downward when the bid is above the effective cap', () => {
    const aboveCap = FIXED_CAP + 200_000;
    const proposals = decide(state({ owned_bids: [owned({ price_sat: aboveCap })] }));
    expect(proposals.find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: FIXED_CAP,
      old_price_sat: aboveCap,
    });
  });
});

describe('decide — EDIT_SPEED', () => {
  it('proposes EDIT_SPEED when target_hashrate_ph changes', () => {
    const s = state({
      config: { ...BASE_CONFIG, target_hashrate_ph: 2.0 },
      owned_bids: [owned({ speed_limit_ph: 1.0 })],
    });
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_SPEED')).toMatchObject({
      kind: 'EDIT_SPEED',
      new_speed_limit_ph: 2.0,
      old_speed_limit_ph: 1.0,
    });
  });

  it('does not propose EDIT_SPEED when speed already matches', () => {
    const proposals = decide(state({ owned_bids: [owned()] }));
    expect(proposals.find((p) => p.kind === 'EDIT_SPEED')).toBeUndefined();
  });
});

describe('decide — multi-bid cleanup', () => {
  it('cancels duplicate owned bids beyond the primary', () => {
    const proposals = decide(
      state({
        owned_bids: [
          owned({ braiins_order_id: 'order-a' }),
          owned({ braiins_order_id: 'order-b' }),
        ],
      }),
    );
    expect(proposals.some((p) => p.kind === 'CANCEL_BID' && p.braiins_order_id === 'order-b')).toBe(true);
  });
});

describe('decide — bid_budget_sat sentinel (0 = full wallet)', () => {
  const balance = (availableSat: number | null) =>
    availableSat === null
      ? null
      : ({
          accounts: [
            {
              subaccount: 'main',
              currency: 'BTC',
              total_balance_sat: availableSat,
              available_balance_sat: availableSat,
              blocked_balance_sat: 0,
              total_deposited_sat: 0,
              total_withdrawn_sat: 0,
              total_spot_spent_sat: 0,
              total_spot_revenue_gross_sat: 0,
              total_spot_revenue_net_sat: 0,
              total_spent_spot_buy_fees_sat: 0,
              total_spent_spot_sell_fees_sat: 0,
              total_spent_fees_sat: 0,
              has_pending_withdrawal: false,
            },
          ],
        } as unknown as NonNullable<State['balance']>);

  it('resolves amount_sat from available wallet balance when bid_budget_sat=0', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: balance(850_000),
    });
    expect(decide(s)[0]).toMatchObject({ kind: 'CREATE_BID', amount_sat: 850_000 });
  });

  it('clamps amount_sat to the 1 BTC per-bid cap', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: balance(250_000_000),
    });
    expect(decide(s)[0]).toMatchObject({ kind: 'CREATE_BID', amount_sat: 100_000_000 });
  });

  it('skips CREATE when balance is null and budget is the sentinel', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: null,
    });
    expect(decide(s)).toEqual([]);
  });

  it('skips CREATE when the wallet is empty and budget is the sentinel', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: balance(0),
    });
    expect(decide(s)).toEqual([]);
  });

  it('passes through the explicit amount when bid_budget_sat > 0', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 50_000 },
      balance: balance(10_000_000),
    });
    expect(decide(s)[0]).toMatchObject({ kind: 'CREATE_BID', amount_sat: 50_000 });
  });
});
