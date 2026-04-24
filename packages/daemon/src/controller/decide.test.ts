import { describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { decide } from './decide.js';
import type { MarketSnapshot, OwnedBidSnapshot, State, UnknownBidSnapshot } from './types.js';

// Pay-your-bid controller (#53). decide() targets
// `fillable_ask + overpay_sat_per_eh_day`, clamped to
// `effective_cap = min(max_bid, hashprice + max_overpay_vs_hashprice)`.
// Tests cover:
//
//   - PAUSE on unknown bids
//   - skip on missing market / missing fillable / missing hashprice
//     (when dynamic cap is configured)
//   - CREATE at target_price when no owned bid
//   - EDIT_PRICE to target_price when bid diverges (with tick_size tolerance)
//   - target_price clamped to effective_cap when fillable + overpay exceeds
//   - EDIT_SPEED on cheap-mode transitions
//   - CANCEL extras when multiple owned bids exist
//   - bid_budget_sat=0 sentinel → wallet balance, 1 BTC clamp

const BASE_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://datum.local:23334',
  destination_pool_worker_name: 'otto',
  btc_payout_address: 'bc1qexample',
  max_overpay_vs_hashprice_sat_per_eh_day: null,
  bid_budget_sat: 200_000,
  overpay_sat_per_eh_day: 1_000_000, // 1,000 sat/PH/day
};

const FIXED_CAP = BASE_CONFIG.max_bid_sat_per_eh_day;
const OVERPAY = BASE_CONFIG.overpay_sat_per_eh_day;

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
  const fillable =
    overrides.fillable_ask_sat_per_eh_day !== undefined
      ? overrides.fillable_ask_sat_per_eh_day
      : 45_000_000;
  return {
    tick_at: 1_700_000_000_000,
    run_mode: 'DRY_RUN',
    config: BASE_CONFIG,
    market: market(),
    balance: null,
    owned_bids: [],
    unknown_bids: [],
    actual_hashrate: { owned_ph: 0, unknown_ph: 0, total_ph: 0 },
    below_floor_since: null,
    above_floor_ticks: 0,
    manual_override_until_ms: null,
    pool: { reachable: true, last_ok_at: 1_700_000_000_000, consecutive_failures: 0 },
    datum: null,
    ocean_hashrate_ph: null,
    last_api_ok_at: 1_700_000_000_000,
    hashprice_sat_per_ph_day: null,
    fillable_ask_sat_per_eh_day: fillable,
    cheap_mode_window: null,
    bypass_pacing: false,
    ...overrides,
  };
}

function owned(overrides: Partial<OwnedBidSnapshot> = {}): OwnedBidSnapshot {
  return {
    braiins_order_id: 'order-a',
    cl_order_id: null,
    price_sat: 46_000_000, // fillable 45M + overpay 1M
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

  it('emits nothing when fillable_ask is null (empty orderbook)', () => {
    expect(decide(state({ fillable_ask_sat_per_eh_day: null }))).toEqual([]);
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
  it('creates at fillable + overpay when below the fixed cap', () => {
    const proposals = decide(state());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: 45_000_000 + OVERPAY,
      amount_sat: 200_000,
    });
  });

  it('clamps target to the fixed cap when fillable + overpay would exceed it', () => {
    // fillable 49,500,000 + overpay 1,000,000 = 50,500,000 > fixed 49,000,000
    const proposals = decide(state({ fillable_ask_sat_per_eh_day: 49_500_000 }));
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: FIXED_CAP,
    });
  });

  it('clamps target to the dynamic cap when tighter than fixed', () => {
    // hashprice 46,000 sat/PH/day × 1000 = 46M sat/EH/day; allowance
    // 500,000 → dynamic cap 46,500,000. fillable 45M + overpay 1M =
    // 46M, below dynamic cap — no clamp.
    const s1 = state({
      config: {
        ...BASE_CONFIG,
        max_overpay_vs_hashprice_sat_per_eh_day: 500_000,
      },
      hashprice_sat_per_ph_day: 46_000,
    });
    expect(decide(s1)[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: 46_000_000,
    });

    // Now shrink the allowance so fillable + overpay hits the dynamic cap.
    // hashprice 46M + allowance 300,000 = dyn cap 46,300,000. Make
    // fillable 45.5M so desired = 46.5M > dyn cap → clamped to 46.3M.
    const s2 = state({
      config: {
        ...BASE_CONFIG,
        max_overpay_vs_hashprice_sat_per_eh_day: 300_000,
      },
      hashprice_sat_per_ph_day: 46_000,
      fillable_ask_sat_per_eh_day: 45_500_000,
    });
    expect(decide(s2)[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: 46_300_000,
    });
  });
});

describe('decide — EDIT_PRICE to target', () => {
  it('does nothing when the bid is already at fillable + overpay', () => {
    expect(decide(state({ owned_bids: [owned()] }))).toEqual([]);
  });

  it('proposes EDIT_PRICE upward when fillable rises above the current bid (past deadband)', () => {
    // fillable 46,500,000 + overpay 1M = 47,500,000 target; current 46M → delta 1.5M clears deadband.
    const s = state({
      fillable_ask_sat_per_eh_day: 46_500_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: 47_500_000,
    });
  });

  it('proposes EDIT_PRICE downward when fillable falls below the current bid (past deadband)', () => {
    const s = state({
      fillable_ask_sat_per_eh_day: 43_000_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: 44_000_000,
    });
  });

  it('absorbs sub-deadband fillable jitter (no trade storm)', () => {
    // Deadband = max(tick_size, overpay/5) = max(1,000, 200,000) = 200,000.
    // fillable 45,150,000 + overpay 1M = 46,150,000; current 46M → delta 150k < 200k deadband → no edit.
    const s = state({
      fillable_ask_sat_per_eh_day: 45_150_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('edits once the drift clears the deadband', () => {
    // fillable 45,300,000 + overpay 1M = 46,300,000; current 46M → delta 300k >= 200k deadband.
    const s = state({
      fillable_ask_sat_per_eh_day: 45_300_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: 46_300_000,
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

describe('decide — cheap-mode engagement (#50 sustained window)', () => {
  const CHEAP_CONFIG = {
    ...BASE_CONFIG,
    target_hashrate_ph: 1,
    cheap_target_hashrate_ph: 3,
    cheap_threshold_pct: 90,
  };
  const HASHPRICE_PH = 50_000; // sat/PH/day → 50M sat/EH/day; threshold 45M

  it('window null, spot best_ask below threshold → cheap-mode on (legacy spot path)', () => {
    const s = state({
      config: CHEAP_CONFIG,
      market: market(44_000_000),
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      cheap_mode_window: null,
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_SPEED')).toMatchObject({
      kind: 'EDIT_SPEED',
      new_speed_limit_ph: 3,
    });
  });

  it('window rolling-avg below threshold → cheap-mode on regardless of spot', () => {
    const s = state({
      config: CHEAP_CONFIG,
      market: market(46_000_000),
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      cheap_mode_window: {
        avg_best_ask_sat_per_eh_day: 44_000_000,
        avg_hashprice_sat_per_eh_day: 50_000_000,
        sample_count: 10,
      },
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_SPEED')).toMatchObject({
      kind: 'EDIT_SPEED',
      new_speed_limit_ph: 3,
    });
  });

  it('window rolling-avg above threshold → cheap-mode off despite spot dip', () => {
    const s = state({
      config: CHEAP_CONFIG,
      market: market(44_000_000),
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      cheap_mode_window: {
        avg_best_ask_sat_per_eh_day: 47_000_000,
        avg_hashprice_sat_per_eh_day: 50_000_000,
        sample_count: 10,
      },
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    const proposals = decide(s);
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
