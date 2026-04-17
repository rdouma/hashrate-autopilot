import { describe, expect, it } from 'vitest';

import { APP_CONFIG_DEFAULTS } from '../config/schema.js';
import { decide } from './decide.js';
import type { MarketSnapshot, OwnedBidSnapshot, State, UnknownBidSnapshot } from './types.js';

const BASE_CONFIG = {
  ...APP_CONFIG_DEFAULTS,
  destination_pool_url: 'stratum+tcp://datum.local:23334',
  destination_pool_worker_name: 'otto',
  btc_payout_address: 'bc1qexample',
  telegram_chat_id: '1',
};

// With the defaults, overpay allowance = 500,000 sat/EH/day.
// Given a cheapest-available ask at 45M sat/EH/day, target = 45.5M.
const CHEAPEST_ASK = 45_000_000;
const EXPECTED_TARGET = CHEAPEST_ASK + APP_CONFIG_DEFAULTS.overpay_sat_per_eh_day;

function market(cheapestAskSat: number = CHEAPEST_ASK, tickSize = 1000): MarketSnapshot {
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
    above_floor_ticks: 0,
    manual_override_until_ms: null,
    pool: { reachable: true, last_ok_at: 1_700_000_000_000, consecutive_failures: 0 },
    last_api_ok_at: 1_700_000_000_000,
    hashprice_sat_per_ph_day: null,
    ...overrides,
  };
}

function owned(overrides: Partial<OwnedBidSnapshot> = {}): OwnedBidSnapshot {
  return {
    braiins_order_id: 'order-a',
    cl_order_id: null,
    price_sat: EXPECTED_TARGET,
    amount_sat: 50_000,
    // Match BASE_CONFIG.target_hashrate_ph so the new EDIT_SPEED logic
    // doesn't fire spuriously in tests that focus on price behavior.
    speed_limit_ph: BASE_CONFIG.target_hashrate_ph,
    avg_speed_ph: BASE_CONFIG.target_hashrate_ph,
    progress_pct: 10,
    amount_remaining_sat: 45_000,
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

  it('emits nothing when the orderbook is empty', () => {
    const emptyBook: MarketSnapshot = {
      ...market(),
      orderbook: { bids: [], asks: [] } as unknown as MarketSnapshot['orderbook'],
      best_ask_sat: null,
    };
    expect(decide(state({ market: emptyBook }))).toEqual([]);
  });

  it('emits nothing when all asks have zero available hashrate', () => {
    const saturated: MarketSnapshot = {
      ...market(),
      orderbook: {
        bids: [],
        asks: [{ price_sat: CHEAPEST_ASK, hr_available_ph: 0 }],
      } as unknown as MarketSnapshot['orderbook'],
    };
    expect(decide(state({ market: saturated }))).toEqual([]);
  });
});

describe('decide — CREATE path', () => {
  it('proposes CREATE_BID at cheapest_available_ask + overpay when no owned bids', () => {
    const proposals = decide(state());
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: EXPECTED_TARGET,
      amount_sat: BASE_CONFIG.bid_budget_sat,
    });
  });

  it('skips asks with zero available and picks the next tier up', () => {
    const tieredMarket: MarketSnapshot = {
      ...market(),
      orderbook: {
        bids: [],
        asks: [
          { price_sat: 44_000_000, hr_available_ph: 0 },
          { price_sat: 46_000_000, hr_available_ph: 5 },
        ],
      } as unknown as MarketSnapshot['orderbook'],
    };
    const proposals = decide(state({ market: tieredMarket }));
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      price_sat: 46_000_000 + APP_CONFIG_DEFAULTS.overpay_sat_per_eh_day,
    });
  });
});

describe('decide — market too expensive', () => {
  it('silently skips the tick when target > max_bid', () => {
    const cappedCfg = { ...BASE_CONFIG, max_bid_sat_per_eh_day: 44_000_000 };
    expect(decide(state({ config: cappedCfg }))).toEqual([]);
  });
});

describe('decide — EDIT / CANCEL paths', () => {
  it('emits nothing when the single owned bid is already at target_price', () => {
    const s = state({ owned_bids: [owned({ price_sat: EXPECTED_TARGET })] });
    expect(decide(s)).toEqual([]);
  });

  it('auto-lowers price when overpaying vs target (fillable + overpay)', () => {
    // With simplified pricing: if we're paying more than target, lower
    // immediately to target. No dampening downward.
    const overpayAmount = 2_000_000;
    const s = state({
      owned_bids: [owned({ price_sat: EXPECTED_TARGET + overpayAmount })],
    });
    const proposals = decide(s);
    const edit = proposals.find((p) => p.kind === 'EDIT_PRICE') as
      | { new_price_sat: number }
      | undefined;
    expect(edit).toBeDefined();
    expect(edit?.new_price_sat).toBe(EXPECTED_TARGET);
  });

  it('does NOT auto-edit when underpaying without being below floor', () => {
    // Underpaying is only corrected via escalation (and only after the
    // below-floor window elapses). Plain "bid below target" isn't
    // enough to trigger an edit.
    const s = state({
      owned_bids: [owned({ price_sat: EXPECTED_TARGET - 2_000_000 })],
    });
    const proposals = decide(s);
    const edits = proposals.filter((p) => p.kind === 'EDIT_PRICE');
    expect(edits).toHaveLength(0);
  });

  it('proposes EDIT_SPEED when target_hashrate_ph differs from bid speed_limit', () => {
    // Operator just bumped target 1.0 -> 1.6. Existing bid still has the
    // old speed_limit of 1.0. Expect an in-place EDIT_SPEED to grow it.
    const cfg = { ...BASE_CONFIG, target_hashrate_ph: 1.6 };
    const s = state({
      config: cfg,
      owned_bids: [
        owned({ price_sat: EXPECTED_TARGET, speed_limit_ph: 1.0, avg_speed_ph: 1.0 }),
      ],
    });
    const proposals = decide(s);
    const speedEdit = proposals.find((p) => p.kind === 'EDIT_SPEED') as
      | { new_speed_limit_ph: number; old_speed_limit_ph: number }
      | undefined;
    expect(speedEdit).toBeDefined();
    expect(speedEdit?.old_speed_limit_ph).toBe(1.0);
    expect(speedEdit?.new_speed_limit_ph).toBe(1.6);
  });

  it('proposes EDIT_SPEED when shrinking the target as well', () => {
    const cfg = { ...BASE_CONFIG, target_hashrate_ph: 1.0 };
    const s = state({
      config: cfg,
      owned_bids: [
        owned({ price_sat: EXPECTED_TARGET, speed_limit_ph: 2.0, avg_speed_ph: 1.0 }),
      ],
    });
    const proposals = decide(s);
    const speedEdit = proposals.find((p) => p.kind === 'EDIT_SPEED') as
      | { new_speed_limit_ph: number; old_speed_limit_ph: number }
      | undefined;
    expect(speedEdit).toBeDefined();
    expect(speedEdit?.old_speed_limit_ph).toBe(2.0);
    expect(speedEdit?.new_speed_limit_ph).toBe(1.0);
  });

  it('caps EDIT_SPEED at min_bid_speed_limit_ph (Braiins floor)', () => {
    // Even if target is below 1.0, we never propose a sub-1.0 speed
    // because the market floor is 1.0 PH/s.
    const cfg = { ...BASE_CONFIG, target_hashrate_ph: 0.5 };
    const s = state({
      config: cfg,
      owned_bids: [owned({ speed_limit_ph: 2.0 })],
    });
    const proposals = decide(s);
    const speedEdit = proposals.find((p) => p.kind === 'EDIT_SPEED') as
      | { new_speed_limit_ph: number }
      | undefined;
    expect(speedEdit?.new_speed_limit_ph).toBe(1.0);
  });

  it('does not propose EDIT_SPEED when bid speed already matches target', () => {
    const s = state({
      owned_bids: [owned({ speed_limit_ph: BASE_CONFIG.target_hashrate_ph })],
    });
    const speedEdits = decide(s).filter((p) => p.kind === 'EDIT_SPEED');
    expect(speedEdits).toHaveLength(0);
  });

  it('proposes CANCEL for duplicate owned bids beyond the primary', () => {
    const s = state({
      owned_bids: [
        owned({ braiins_order_id: 'a', price_sat: EXPECTED_TARGET }),
        owned({ braiins_order_id: 'b', price_sat: EXPECTED_TARGET }),
        owned({ braiins_order_id: 'c', price_sat: EXPECTED_TARGET }),
      ],
    });
    const proposals = decide(s);
    const cancels = proposals.filter((p) => p.kind === 'CANCEL_BID');
    expect(cancels).toHaveLength(2);
    expect(cancels.map((c) => (c as { braiins_order_id: string }).braiins_order_id).sort()).toEqual([
      'b',
      'c',
    ]);
  });
});

describe('decide — escalation when stuck below floor', () => {
  it('escalates in dampened mode (steps toward target) when below floor', () => {
    const tick = 1_700_000_000_000;
    const stuckMinutes = BASE_CONFIG.fill_escalation_after_minutes + 5;
    const longAgo = tick - stuckMinutes * 60_000;
    const belowTarget = EXPECTED_TARGET - 1_000_000;
    const primary = owned({
      price_sat: belowTarget,
      avg_speed_ph: 0,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: longAgo,
      owned_bids: [primary],
      config: { ...BASE_CONFIG, escalation_mode: 'dampened' as const },
    });
    const proposals = decide(s);
    const edit = proposals.find((p) => p.kind === 'EDIT_PRICE') as
      | { new_price_sat: number }
      | undefined;
    expect(edit).toBeDefined();
    expect(edit?.new_price_sat).toBeGreaterThan(belowTarget);
    expect(edit?.new_price_sat).toBeLessThanOrEqual(EXPECTED_TARGET);
  });

  it('escalates in market mode (jumps to target) when below floor', () => {
    const tick = 1_700_000_000_000;
    const stuckMinutes = BASE_CONFIG.fill_escalation_after_minutes + 5;
    const longAgo = tick - stuckMinutes * 60_000;
    const belowTarget = EXPECTED_TARGET - 1_000_000;
    const primary = owned({
      price_sat: belowTarget,
      avg_speed_ph: 0,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: longAgo,
      owned_bids: [primary],
      config: { ...BASE_CONFIG, escalation_mode: 'market' as const },
    });
    const proposals = decide(s);
    const edit = proposals.find((p) => p.kind === 'EDIT_PRICE') as
      | { new_price_sat: number }
      | undefined;
    expect(edit).toBeDefined();
    expect(edit?.new_price_sat).toBe(EXPECTED_TARGET);
  });

  it('does not escalate when already at target', () => {
    const tick = 1_700_000_000_000;
    const stuckMinutes = BASE_CONFIG.fill_escalation_after_minutes + 5;
    const longAgo = tick - stuckMinutes * 60_000;
    const primary = owned({
      price_sat: EXPECTED_TARGET,
      avg_speed_ph: 0,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: longAgo,
      owned_bids: [primary],
    });
    const proposals = decide(s);
    const edits = proposals.filter((p) => p.kind === 'EDIT_PRICE');
    expect(edits).toHaveLength(0);
  });
});
