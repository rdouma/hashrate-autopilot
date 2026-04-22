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
  // Tests default to hashprice_sat_per_ph_day: null, which collides with
  // the new default dynamic cap that blocks trading when hashprice is
  // unknown. Disable the dynamic cap here so tests keep exercising the
  // plain fixed-cap path; dedicated dynamic-cap tests override this
  // explicitly + supply a hashprice.
  max_overpay_vs_hashprice_sat_per_eh_day: null,
  // Explicit budget so existing tests exercise the historical
  // fixed-budget path. The sentinel (0 = "use full wallet balance")
  // is the new default in APP_CONFIG_DEFAULTS; dedicated tests for
  // it live in the "bid_budget_sat sentinel" describe block.
  bid_budget_sat: 200_000,
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
    lower_ready_since: 1_700_000_000_000 - 30 * 60_000,
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

describe('decide — bid_budget_sat sentinel (0 = use full wallet balance)', () => {
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
    const proposals = decide(s);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      amount_sat: 850_000,
    });
  });

  it('clamps amount_sat to the Braiins 1-BTC-per-bid hard cap', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: balance(250_000_000), // 2.5 BTC in the wallet
    });
    const proposals = decide(s);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      amount_sat: 100_000_000, // 1 BTC
    });
  });

  it('skips the CREATE when balance is null (API down) and budget is the sentinel', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: null,
    });
    expect(decide(s)).toEqual([]);
  });

  it('skips the CREATE when the wallet is empty and budget is the sentinel', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 0 },
      balance: balance(0),
    });
    expect(decide(s)).toEqual([]);
  });

  it('ignores balance and passes through the explicit amount when bid_budget_sat > 0', () => {
    const s = state({
      config: { ...BASE_CONFIG, bid_budget_sat: 50_000 },
      balance: balance(10_000_000), // plenty of wallet; should not override
    });
    const proposals = decide(s);
    expect(proposals[0]).toMatchObject({
      kind: 'CREATE_BID',
      amount_sat: 50_000,
    });
  });
});

describe('decide — bypass_pacing (run-decision-now) lowers immediately', () => {
  // Mirror of the "auto-lowers when overpaying" test from the EDIT/CANCEL
  // path, but with lower_ready_since set so recently that the normal
  // patience gate would block the lower. With bypass_pacing=true the
  // gate is overridden and the EDIT_PRICE still fires — that's the
  // operator's expectation when they click "Run decision now".
  it('fires EDIT_PRICE lowering even when lower_ready_since is within the patience window', () => {
    const overpayAmount = 2_000_000;
    const tickAt = 1_700_000_000_000;
    // lower_ready_since 30s ago — far below the 15-minute default
    // patience, so `aboveFloorLongEnough` is false. Lowering should
    // still fire because bypass_pacing=true.
    const s = state({
      tick_at: tickAt,
      lower_ready_since: tickAt - 30_000,
      owned_bids: [owned({ price_sat: EXPECTED_TARGET + overpayAmount })],
      bypass_pacing: true,
    } as Partial<State>);
    const proposals = decide(s);
    const edit = proposals.find((p) => p.kind === 'EDIT_PRICE') as
      | { new_price_sat: number }
      | undefined;
    expect(edit).toBeDefined();
    expect(edit?.new_price_sat).toBe(EXPECTED_TARGET);
  });

  it('does NOT fire when bypass_pacing is false and the patience window has not elapsed', () => {
    const overpayAmount = 2_000_000;
    const tickAt = 1_700_000_000_000;
    const s = state({
      tick_at: tickAt,
      lower_ready_since: tickAt - 30_000,
      owned_bids: [owned({ price_sat: EXPECTED_TARGET + overpayAmount })],
      bypass_pacing: false,
    } as Partial<State>);
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });
});

describe('decide — market too expensive', () => {
  it('silently skips the tick when target > max_bid', () => {
    const cappedCfg = { ...BASE_CONFIG, max_bid_sat_per_eh_day: 44_000_000 };
    expect(decide(state({ config: cappedCfg }))).toEqual([]);
  });
});

describe('decide — max_overpay_vs_hashprice cap (issue #27)', () => {
  // Ask 45M + overpay 500K = desired 45.5M. Hashprice = 44M (sat/EH/day
  // → 44K sat/PH/day). Dynamic cap + 1M overpay over hashprice = 45M.
  // Fixed cap (default 60M) is way looser, so dynamic is binding.
  const HASHPRICE_PH_DAY = 44_000;

  it('binding fixed cap when dynamic cap is disabled (null)', () => {
    // Default APP_CONFIG_DEFAULTS.max_overpay_vs_hashprice_sat_per_eh_day
    // is null → dynamic cap off → effective = fixed. Target should be
    // fillable + overpay = 45.5M, under the 60M fixed cap → CREATE at
    // EXPECTED_TARGET, not clamped.
    const s = state({ hashprice_sat_per_ph_day: HASHPRICE_PH_DAY });
    const proposals = decide(s);
    const create = proposals.find((p) => p.kind === 'CREATE_BID') as
      | { price_sat: number }
      | undefined;
    expect(create?.price_sat).toBe(EXPECTED_TARGET);
  });

  it('binding dynamic cap when it is tighter than fixed', () => {
    // Dynamic = hashprice (44M) + overpay cap (1M) = 45M.
    // Desired = 45.5M. 45.5M > 45M → market too expensive → [].
    const cfg = {
      ...BASE_CONFIG,
      max_overpay_vs_hashprice_sat_per_eh_day: 1_000_000,
    };
    const s = state({ config: cfg, hashprice_sat_per_ph_day: HASHPRICE_PH_DAY });
    expect(decide(s)).toEqual([]);
  });

  it('binding fixed cap when dynamic is looser', () => {
    // Dynamic = 44M + 10M = 54M. Fixed = 60M (default). Effective = 54M.
    // Desired = 45.5M, under 54M → CREATE at 45.5M.
    const cfg = {
      ...BASE_CONFIG,
      max_overpay_vs_hashprice_sat_per_eh_day: 10_000_000,
    };
    const s = state({ config: cfg, hashprice_sat_per_ph_day: HASHPRICE_PH_DAY });
    const proposals = decide(s);
    const create = proposals.find((p) => p.kind === 'CREATE_BID') as
      | { price_sat: number }
      | undefined;
    expect(create?.price_sat).toBe(EXPECTED_TARGET);
  });

  it('refuses to trade when dynamic cap is configured but hashprice is unavailable (issue #28)', () => {
    // Dynamic cap configured but hashprice=null (Ocean unreachable or
    // cache stale). Silently falling back to the fixed cap alone
    // would bypass the safety the operator explicitly enabled, so
    // decide() returns [] until hashprice comes back.
    const cfg = {
      ...BASE_CONFIG,
      max_overpay_vs_hashprice_sat_per_eh_day: 1_000_000,
    };
    const s = state({ config: cfg, hashprice_sat_per_ph_day: null });
    expect(decide(s)).toEqual([]);
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

describe('decide — above_market mode (preemptive raise)', () => {
  it('raises to target when below_target_since has elapsed past the window', () => {
    const tick = 1_700_000_000_000;
    const stuckMinutes = BASE_CONFIG.fill_escalation_after_minutes + 5;
    const longAgo = tick - stuckMinutes * 60_000;
    const belowTarget = EXPECTED_TARGET - 1_000_000;
    // Still filling fine — the whole point of the mode: we're NOT below
    // floor, but the market has closed the overpay gap for long enough
    // that the preemptive timer fires.
    const primary = owned({
      price_sat: belowTarget,
      avg_speed_ph: BASE_CONFIG.target_hashrate_ph,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: null,
      below_target_since: longAgo,
      owned_bids: [primary],
      config: { ...BASE_CONFIG, escalation_mode: 'above_market' as const },
    });
    const proposals = decide(s);
    const edit = proposals.find((p) => p.kind === 'EDIT_PRICE') as
      | { new_price_sat: number; reason: string }
      | undefined;
    expect(edit).toBeDefined();
    expect(edit?.new_price_sat).toBe(EXPECTED_TARGET);
    expect(edit?.reason).toContain('above_market');
  });

  it('does NOT raise when below_target_since is shorter than the escalation window', () => {
    const tick = 1_700_000_000_000;
    const recent = tick - 30_000; // 30 seconds ago — way under the window
    const belowTarget = EXPECTED_TARGET - 1_000_000;
    const primary = owned({
      price_sat: belowTarget,
      avg_speed_ph: BASE_CONFIG.target_hashrate_ph,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: null,
      below_target_since: recent,
      owned_bids: [primary],
      config: { ...BASE_CONFIG, escalation_mode: 'above_market' as const },
    });
    const proposals = decide(s);
    expect(proposals.filter((p) => p.kind === 'EDIT_PRICE')).toHaveLength(0);
  });

  it('does NOT fire the reactive below-floor trigger under above_market mode', () => {
    // Operator is below floor and has been for ages. Under market/dampened
    // this would escalate. Under above_market, below_floor_since is not
    // consulted — only below_target_since is. Since below_target_since is
    // null here (bid is above target), nothing should fire.
    const tick = 1_700_000_000_000;
    const longAgo = tick - 60 * 60_000;
    const primary = owned({
      price_sat: EXPECTED_TARGET + 2_000_000, // above target
      avg_speed_ph: 0,
      speed_limit_ph: 2,
    });
    const s = state({
      tick_at: tick,
      below_floor_since: longAgo,
      below_target_since: null,
      owned_bids: [primary],
      lower_ready_since: null, // don't trip the lower path
      config: { ...BASE_CONFIG, escalation_mode: 'above_market' as const },
    });
    const proposals = decide(s);
    expect(proposals.filter((p) => p.kind === 'EDIT_PRICE')).toHaveLength(0);
  });
});
