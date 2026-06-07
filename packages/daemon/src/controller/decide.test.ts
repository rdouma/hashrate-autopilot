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
    pool: { reachable: true, last_ok_at: 1_700_000_000_000, consecutive_failures: 0, error: null, latency_ms: null },
    datum: null,
    ocean_hashrate_ph: null,
    share_log_pct: null,
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

describe('decide - case selection', () => {
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

describe('decide - Datum stratum down auto-cancel (#199)', () => {
  const datumDown = (failures: number) => ({
    reachable: false,
    connections: null,
    hashrate_ph: null,
    last_ok_at: 1_700_000_000_000 - failures * 60_000,
    consecutive_failures: failures,
  });

  it('cancels all owned bids when Datum is down for 3+ ticks', () => {
    const proposals = decide(state({
      datum: datumDown(3),
      owned_bids: [owned()],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'CANCEL_BID',
      braiins_order_id: 'order-a',
    });
    expect(proposals[0]!.reason).toContain('Datum stratum down');
  });

  it('cancels multiple owned bids when Datum is down', () => {
    const proposals = decide(state({
      datum: datumDown(5),
      owned_bids: [owned(), owned({ braiins_order_id: 'order-b' })],
    }));
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.kind === 'CANCEL_BID')).toBe(true);
  });

  it('does not cancel when Datum is down for fewer than 3 ticks', () => {
    const proposals = decide(state({
      datum: datumDown(2),
      owned_bids: [owned()],
    }));
    expect(proposals.every((p) => p.kind !== 'CANCEL_BID')).toBe(true);
  });

  it('does not cancel when Datum is not configured (null)', () => {
    const proposals = decide(state({
      datum: null,
      owned_bids: [owned()],
    }));
    expect(proposals.every((p) => p.kind !== 'CANCEL_BID' || p.reason.includes('multiple'))).toBe(true);
  });

  it('does nothing when Datum is down but no owned bids', () => {
    const proposals = decide(state({
      datum: datumDown(10),
      owned_bids: [],
    }));
    expect(proposals).toEqual([]);
  });

  it('does not block CREATE after Datum recovers', () => {
    const proposals = decide(state({
      datum: { reachable: true, connections: 1, hashrate_ph: 1.5, last_ok_at: Date.now(), consecutive_failures: 0 },
      owned_bids: [],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'CREATE_BID' });
  });
});

describe('decide - PENDING_CANCEL bids are never re-mutated (#276)', () => {
  const datumDown = (failures: number) => ({
    reachable: false,
    connections: null,
    hashrate_ph: null,
    last_ok_at: 1_700_000_000_000 - failures * 60_000,
    consecutive_failures: failures,
  });
  const pendingCancel = (id = 'order-a') =>
    owned({ braiins_order_id: id, status: 'BID_STATUS_PENDING_CANCEL' });

  it('does not re-cancel a PENDING_CANCEL bid when Datum is down (empirical 2026-06-06: duplicate cancel markers)', () => {
    const proposals = decide(state({
      datum: datumDown(3),
      owned_bids: [pendingCancel()],
    }));
    expect(proposals).toEqual([]);
  });

  it('cancels only the still-live bid when Datum is down and another is PENDING_CANCEL', () => {
    const proposals = decide(state({
      datum: datumDown(3),
      owned_bids: [pendingCancel('order-a'), owned({ braiins_order_id: 'order-b' })],
    }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'CANCEL_BID', braiins_order_id: 'order-b' });
  });

  it('does not CREATE a replacement while the old bid is still PENDING_CANCEL (no overlap)', () => {
    const proposals = decide(state({
      owned_bids: [pendingCancel()],
    }));
    expect(proposals).toEqual([]);
  });

  it('does not EDIT_PRICE a PENDING_CANCEL bid even when its price has drifted', () => {
    const proposals = decide(state({
      // Price far below fillable + overpay → would normally trigger
      // an EDIT_PRICE well past any deadband.
      owned_bids: [pendingCancel()].map((b) => ({ ...b, price_sat: 40_000_000 })),
    }));
    expect(proposals).toEqual([]);
  });

  it('does not cancel a PENDING_CANCEL bid as an extra in the keep-one-bid sweep', () => {
    const proposals = decide(state({
      owned_bids: [owned({ braiins_order_id: 'order-a' }), pendingCancel('order-b')],
    }));
    expect(proposals.filter((p) => p.kind === 'CANCEL_BID')).toEqual([]);
  });
});

describe('decide - CREATE path', () => {
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
    // 46M, below dynamic cap - no clamp.
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

describe('decide - EDIT_PRICE to target', () => {
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

  // #222: deadband percentage is now operator-configurable. The
  // existing tests above cover the default 20% (= legacy `overpay/5`).
  // These cover the configurability itself.
  it('configurable deadband: 50% raises the threshold from 200k to 500k', () => {
    // bid_edit_deadband_pct = 50 → deadband = max(tick_size, overpay × 50 / 100)
    //   = max(1,000, 500,000) = 500,000.
    // fillable 45,550,000 + overpay 1M = 46,550,000; current 46M → delta 550k
    // crosses 50% deadband but would cross 20% trivially - the 50%
    // version still edits.
    const s = state({
      config: { ...BASE_CONFIG, bid_edit_deadband_pct: 50 },
      fillable_ask_sat_per_eh_day: 45_550_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: 46_550_000,
    });
  });

  it('configurable deadband: 50% absorbs a drift the 20% default would have edited', () => {
    // bid_edit_deadband_pct = 50 → deadband = 500,000.
    // fillable 45_300_000 + overpay 1M = 46,300,000; current 46M → delta 300k.
    // Above 20% (= 200k) but below 50% (= 500k), so no edit.
    const s = state({
      config: { ...BASE_CONFIG, bid_edit_deadband_pct: 50 },
      fillable_ask_sat_per_eh_day: 45_300_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toBeUndefined();
  });

  it('configurable deadband: 0% falls back to tick_size floor (1,000)', () => {
    // bid_edit_deadband_pct = 0 → deadband = max(tick_size, 0) = 1,000.
    // fillable 45,001,000 + overpay 1M = 46,001,000; current 46M → delta 1k.
    // Equals tick_size exactly so it qualifies for an edit.
    const s = state({
      config: { ...BASE_CONFIG, bid_edit_deadband_pct: 0 },
      fillable_ask_sat_per_eh_day: 45_001_000,
      owned_bids: [owned({ price_sat: 46_000_000 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_PRICE')).toMatchObject({
      kind: 'EDIT_PRICE',
      new_price_sat: 46_001_000,
    });
  });
});

describe('decide - EDIT_SPEED', () => {
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

describe('decide - cheap-mode engagement (#50 sustained window, #160 our-bid semantics)', () => {
  // Threshold 90 % of hashprice. Hashprice 50M sat/EH/day. Overpay 1M.
  // Cheap engages when our bid (fillable + 1M) < 45M.
  // I.e. fillable must be < 44M for engagement.
  const CHEAP_CONFIG = {
    ...BASE_CONFIG,
    target_hashrate_ph: 1,
    cheap_target_hashrate_ph: 3,
    cheap_threshold_pct: 90,
  };
  const HASHPRICE_PH = 50_000; // 50,000 sat/PH/day → 50M sat/EH/day

  it('spot path (window=0): our bid below threshold → cheap-mode on', () => {
    const s = state({
      config: { ...CHEAP_CONFIG, cheap_sustained_window_minutes: 0 },
      market: market(44_000_000), // best_ask irrelevant under new semantics
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      fillable_ask_sat_per_eh_day: 43_000_000, // our_bid = 44M < 45M threshold
      cheap_mode_window: null,
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    const proposals = decide(s);
    expect(proposals.find((p) => p.kind === 'EDIT_SPEED')).toMatchObject({
      kind: 'EDIT_SPEED',
      new_speed_limit_ph: 3,
    });
  });

  it('spot path: our bid at threshold → cheap-mode off (strict <)', () => {
    const s = state({
      config: { ...CHEAP_CONFIG, cheap_sustained_window_minutes: 0 },
      market: market(40_000_000), // misleading: best_ask cheap but we still pay 45M
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      fillable_ask_sat_per_eh_day: 44_000_000, // our_bid = 45M = threshold
      cheap_mode_window: null,
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_SPEED')).toBeUndefined();
  });

  it('sustained path: engage=true → cheap-mode on', () => {
    const s = state({
      config: { ...CHEAP_CONFIG, cheap_sustained_window_minutes: 5 },
      market: market(46_000_000),
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      fillable_ask_sat_per_eh_day: 45_000_000, // current tick irrelevant
      cheap_mode_window: {
        engage: true,
        ticks_below: 5,
        ticks_total: 5,
        ticks_required: 5,
        threshold_pct: 90,
      },
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_SPEED')).toMatchObject({
      kind: 'EDIT_SPEED',
      new_speed_limit_ph: 3,
    });
  });

  it('sustained path: engage=false → cheap-mode off (no spot fallback)', () => {
    const s = state({
      config: { ...CHEAP_CONFIG, cheap_sustained_window_minutes: 5 },
      market: market(40_000_000), // spot would say cheap, but operator opted into sustained
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      fillable_ask_sat_per_eh_day: 40_000_000, // current tick would pass, but sustained != current
      cheap_mode_window: {
        engage: false, // observe() said no - either short on samples or not all-below
        ticks_below: 4,
        ticks_total: 4, // 4 of 5 required → not engaged
        ticks_required: 5,
        threshold_pct: 90,
      },
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_SPEED')).toBeUndefined();
  });

  it('sustained path: cheap_mode_window null (e.g. observe error) → cheap-mode off', () => {
    const s = state({
      config: { ...CHEAP_CONFIG, cheap_sustained_window_minutes: 5 },
      market: market(40_000_000),
      hashprice_sat_per_ph_day: HASHPRICE_PH,
      fillable_ask_sat_per_eh_day: 40_000_000,
      cheap_mode_window: null,
      owned_bids: [owned({ speed_limit_ph: 1 })],
    });
    expect(decide(s).find((p) => p.kind === 'EDIT_SPEED')).toBeUndefined();
  });
});

describe('decide - multi-bid cleanup', () => {
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

describe('decide - bid_budget_sat sentinel (0 = full wallet)', () => {
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
