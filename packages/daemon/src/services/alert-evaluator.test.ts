import { describe, expect, it, vi } from 'vitest';

import { AlertEvaluator } from './alert-evaluator.js';
import type { AlertManager } from './alert-manager.js';
import type { State } from '../controller/types.js';

type Recorded = Parameters<AlertManager['recordAlert']>[0];

function makeManager(): AlertManager & { recorded: Recorded[]; nextId: number } {
  let nextId = 1;
  const recorded: Recorded[] = [];
  return {
    recorded,
    get nextId() { return nextId; },
    set nextId(v: number) { nextId = v; },
    recordAlert: vi.fn(async (args: Recorded) => {
      recorded.push(args);
      return nextId++;
    }),
  } as unknown as AlertManager & { recorded: Recorded[]; nextId: number };
}

function makeState(overrides: Partial<State>): State {
  const base = {
    tick_at: 0,
    config: {
      pool_outage_blip_tolerance_seconds: 60,
      // #135: dedicated alert thresholds (was derived from
      // pool_outage_blip_tolerance_seconds × 5).
      datum_unreachable_alert_after_minutes: 5,
      sustained_paused_alert_after_minutes: 5,
      below_floor_alert_after_minutes: 10,
      zero_hashrate_loud_alert_after_minutes: 15,
      api_outage_alert_after_minutes: 10,
      minimum_floor_hashrate_ph: 0.5,
      notification_disabled_event_classes: [],
    },
    market: {} as State['market'],
    datum: { reachable: true, connections: 1, hashrate_ph: 1, last_ok_at: 0, consecutive_failures: 0 },
    actual_hashrate: { owned_ph: 1.0, unknown_ph: 0, total_ph: 1.0 },
    below_floor_since: null,
    owned_bids: [],
    unknown_bids: [],
  } as unknown as State;
  return { ...base, ...overrides } as State;
}

describe('AlertEvaluator - datum_unreachable', () => {
  it('does nothing while Datum is reachable', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    await ev.evaluate(makeState({}));
    now += 60_000;
    await ev.evaluate(makeState({}));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('arms but does not fire below the threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    await ev.evaluate(bad);
    now += 60_000; // 60s, threshold is 5*60 = 300s
    await ev.evaluate(bad);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('fires once after the threshold elapses', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    await ev.evaluate(bad);
    now += 5 * 60_000;
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('datum_unreachable');
    expect(mgr.recorded[0]!.severity).toBe('IMPORTANT');
  });

  it('pairs a recovery message when Datum becomes reachable again', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
    });
    const ok = makeState({});
    await ev.evaluate(bad);
    now += 5 * 60_000;
    await ev.evaluate(bad); // fires alert id=1
    now += 60_000;
    await ev.evaluate(ok); // recovery
    expect(mgr.recordAlert).toHaveBeenCalledTimes(2);
    expect(mgr.recorded[1]!.event_class).toBe('datum_unreachable_recovery');
    expect(mgr.recorded[1]!.severity).toBe('INFO');
    expect(mgr.recorded[1]!.paired_alert_id).toBe(1);
  });

  it('clears state without recovery if the bad streak never crossed the threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    await ev.evaluate(makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 1 },
    }));
    now += 60_000;
    await ev.evaluate(makeState({}));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });
});

describe('AlertEvaluator - api_unreachable', () => {
  it('fires after the configured threshold when state.market is null', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({ market: null });
    await ev.evaluate(bad);
    now += 10 * 60_000;
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('api_unreachable');
  });
});

describe('AlertEvaluator - unknown_bid', () => {
  it('fires immediately when an unknown bid appears', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    const bad = makeState({
      unknown_bids: [{ braiins_order_id: 'bid_xyz' }] as unknown as State['unknown_bids'],
    });
    await ev.evaluate(bad);
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('unknown_bid');
    expect(mgr.recorded[0]!.body).toContain('bid_xyz');
  });
});

describe('AlertEvaluator - beta_exit', () => {
  it('fires immediately on the first non-zero fee_rate_pct', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    const bad = makeState({
      owned_bids: [
        { fee_rate_pct: 1.5, status: 'CL_ORDER_STATE_ACTIVE' },
      ] as unknown as State['owned_bids'],
    });
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.severity).toBe('WARNING');
    expect(mgr.recorded[0]!.event_class).toBe('beta_exit');
  });
});

describe('AlertEvaluator - per-event-class opt-out (#106)', () => {
  it('skips disabled event classes entirely - no record, no timer arming', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    const bad = makeState({
      datum: { reachable: false, connections: 0, hashrate_ph: 0, last_ok_at: null, consecutive_failures: 5 },
      config: {
        ...(makeState({}).config as State['config']),
        notification_disabled_event_classes: ['datum_unreachable'],
      },
    });
    await ev.evaluate(bad);
    await ev.evaluate(bad);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });
});

describe('AlertEvaluator - hashrate_below_floor', () => {
  it('fires after the configured threshold', async () => {
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const bad = makeState({
      below_floor_since: 0,
      actual_hashrate: { owned_ph: 0.2, unknown_ph: 0, total_ph: 0.2 },
    });
    await ev.evaluate(bad);
    now += 10 * 60_000;
    await ev.evaluate(bad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('hashrate_below_floor');
  });

  it('#242: does NOT fire when actual_hashrate has recovered above floor at the threshold-crossing tick', async () => {
    // Sequence: hashrate dips, debounce arms below_floor_since, then
    // hashrate recovers above floor while the FLOOR_DEBOUNCE_TICKS
    // counter (3 above-floor ticks before below_floor_since clears)
    // hasn't finished counting down. The threshold-crossing tick
    // arrives with below_floor_since still set (isBad=true) but
    // actual >= floor. Previously the alert fired with a body that
    // said "Current: <recovered>; floor: <X>" - a self-contradiction
    // the operator caught in Telegram. suppressFire in runTransition
    // now skips the fire while keeping the timer armed.
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    // Tick 1: dip starts. below_floor_since set.
    await ev.evaluate(
      makeState({
        below_floor_since: 0,
        actual_hashrate: { owned_ph: 0.2, unknown_ph: 0, total_ph: 0.2 },
      }),
    );
    // Tick 2: 10 min later, threshold elapsed, BUT actual has
    // recovered above floor and the debounce hasn't cleared yet
    // (below_floor_since still set).
    now += 10 * 60_000;
    await ev.evaluate(
      makeState({
        below_floor_since: 0,
        actual_hashrate: { owned_ph: 4.24, unknown_ph: 0, total_ph: 4.24 },
      }),
    );
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('#242: still fires when actual_hashrate stays below floor through threshold (the normal happy path)', async () => {
    // Same shape as the existing "fires after the configured
    // threshold" test, repeated explicitly under the #242 banner so
    // the regression coverage spells out that we did NOT just gate
    // the fire away for everyone - only suppress when actual has
    // already recovered.
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    const stillBad = makeState({
      below_floor_since: 0,
      actual_hashrate: { owned_ph: 0.2, unknown_ph: 0, total_ph: 0.2 },
    });
    await ev.evaluate(stillBad);
    now += 10 * 60_000;
    await ev.evaluate(stillBad);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });

  it('#242: fires on a NEXT tick if the dip resumes before the debounce clears', async () => {
    // Recovery suppresses fire; dip resumes on a later tick within
    // the same below_floor_since window; alert fires then.
    const mgr = makeManager();
    let now = 0;
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => now });
    // Tick 1: dip starts.
    await ev.evaluate(
      makeState({
        below_floor_since: 0,
        actual_hashrate: { owned_ph: 0.2, unknown_ph: 0, total_ph: 0.2 },
      }),
    );
    // Tick 2: 10 min later, threshold reached, but recovered.
    // Fire suppressed.
    now += 10 * 60_000;
    await ev.evaluate(
      makeState({
        below_floor_since: 0,
        actual_hashrate: { owned_ph: 4.24, unknown_ph: 0, total_ph: 4.24 },
      }),
    );
    expect(mgr.recordAlert).not.toHaveBeenCalled();
    // Tick 3: 60s later, dip resumes. below_floor_since still set
    // (debounce never cleared because we only saw 1 above-floor
    // tick), threshold elapsed long ago. Fire now.
    now += 60_000;
    await ev.evaluate(
      makeState({
        below_floor_since: 0,
        actual_hashrate: { owned_ph: 0.1, unknown_ph: 0, total_ph: 0.1 },
      }),
    );
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });
});

// #226: payout_initiated detection. The trigger is a sharp drop in
// `state.ocean_unpaid_sat` between consecutive ticks, gated on the
// residual being below the payout threshold (so non-payout dips
// don't fire). Idempotency: `payoutPrevUnpaidSat` advances every
// tick to the current value, so a second tick at the same residual
// has zero delta and won't refire.
describe('AlertEvaluator - payout_initiated (#226)', () => {
  function payoutState(overrides: Partial<State> & { ocean_unpaid_sat: number | null }): State {
    return makeState({
      ...overrides,
      config: {
        ...(makeState({}).config),
        notify_on_payout_initiated: true,
      } as State['config'],
    });
  }

  it('does nothing while the toggle is off', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(makeState({ ocean_unpaid_sat: 1_200_000 } as Partial<State>));
    await ev.evaluate(makeState({ ocean_unpaid_sat: 5_000 } as Partial<State>));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('fires once when unpaid drops >30% AND residual is below threshold', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 1_074_562 }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 12_418 }));
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('payout_initiated');
    expect(mgr.recorded[0]!.severity).toBe('INFO');
  });

  it('does not fire when the drop is <30%', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    // 1_200_000 -> 1_000_000: 16.7% drop. Doesn't qualify.
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 1_200_000 }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 1_000_000 }));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('does not fire when residual stays at-or-above the payout threshold', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    // 5_000_000 -> 1_500_000: 70% drop but residual still above 1,048,576.
    // Not a payout - some other Ocean-side accounting bump.
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 5_000_000 }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 1_500_000 }));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('does not refire on subsequent ticks observing the same residual', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 1_074_562 }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 12_418 })); // fires
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 12_500 })); // no delta worth firing
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 14_000 })); // small rise, no fire
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });

  it('null observations re-baseline silently (no fire on either tick)', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutState({ ocean_unpaid_sat: null }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 5_000 }));
    await ev.evaluate(payoutState({ ocean_unpaid_sat: null }));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('first tick with a baseline does not fire (no prior comparison)', async () => {
    // Daemon-restart edge case: the prev field is null on the first
    // tick after construction, so a drop straddling that boundary is
    // silently absorbed. Documented behavior; the matching
    // payout_confirmed will still fire when the coinbase confirms.
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutState({ ocean_unpaid_sat: 12_418 }));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('respects notification_disabled_event_classes', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    const s1 = payoutState({ ocean_unpaid_sat: 1_074_562 });
    const s2 = payoutState({ ocean_unpaid_sat: 12_418 });
    (s2.config as { notification_disabled_event_classes: string[] }).notification_disabled_event_classes = ['payout_initiated'];
    (s1.config as { notification_disabled_event_classes: string[] }).notification_disabled_event_classes = ['payout_initiated'];
    await ev.evaluate(s1);
    await ev.evaluate(s2);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });
});

// #323: payout_confirmed is now the stage-2 (enriched) alert sourced
// from the Ocean earnpay payout store. It's rail-aware (on-chain AND
// Lightning) and silently baselines every stored payout on the first
// eligible tick so the historical backfill doesn't flood Telegram;
// thereafter it fires once per new (enriched_alert = 0) settlement.
describe('AlertEvaluator - payout_confirmed (#323)', () => {
  const ADDR = 'bc1qux2aehp5ny89l9spguf052x84zm8h9uyfqvgdg';

  type PayoutRow = {
    id: number;
    address: string;
    ts: number;
    net_sat: number;
    rail: 'onchain' | 'lightning';
    enriched_alert: 0 | 1;
  };

  function fakeOceanPayoutsRepo(initial: PayoutRow[] = []) {
    const rows: PayoutRow[] = initial.map((r) => ({ ...r }));
    return {
      rows,
      async markAllEnriched(address: string) {
        for (const r of rows) if (r.address === address) r.enriched_alert = 1;
      },
      async listUnenriched(address: string) {
        return rows
          .filter((r) => r.address === address && r.enriched_alert === 0)
          .sort((a, b) => a.ts - b.ts);
      },
      async markEnriched(ids: readonly number[]) {
        for (const r of rows) if (ids.includes(r.id)) r.enriched_alert = 1;
      },
    };
  }

  function payoutConfirmedState(overrides: Partial<State> = {}): State {
    return makeState({
      ...overrides,
      config: {
        ...(makeState({}).config),
        notify_on_payout_confirmed: true,
        btc_payout_address: ADDR,
      } as State['config'],
    });
  }

  const onchain = (id: number, net = 1_062_144): PayoutRow => ({
    id, address: ADDR, ts: id * 1000, net_sat: net, rail: 'onchain', enriched_alert: 0,
  });

  it('does nothing while the toggle is off', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo([onchain(1)]);
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(makeState({ ocean_unpaid_sat: null } as Partial<State>));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('silently baselines on first tick (no fire for the historical backfill)', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo([onchain(1), onchain(2, 1_070_000)]);
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).not.toHaveBeenCalled();
    // All existing rows are now marked enriched.
    expect(repo.rows.every((r) => r.enriched_alert === 1)).toBe(true);
  });

  it('fires once for the first new settlement after baseline', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo([onchain(1)]);
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline
    // Incremental refresh inserts a new (enriched=0) settlement.
    repo.rows.push(onchain(2, 1_070_000));
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('payout_confirmed');
    expect(mgr.recorded[0]!.severity).toBe('INFO');
    expect(mgr.recorded[0]!.body).toContain('on-chain');
  });

  it('does not refire on subsequent ticks for the same settlement', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline (empty)
    repo.rows.push(onchain(1));
    await ev.evaluate(payoutConfirmedState()); // fires + marks enriched
    await ev.evaluate(payoutConfirmedState()); // nothing unenriched
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });

  it('fires once per new settlement when multiple land between ticks', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline
    repo.rows.push(onchain(1), onchain(2, 1_070_000));
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(2);
  });

  it('fires for a Lightning payout with off-chain wording (the #323 fix)', async () => {
    const mgr = makeManager();
    const repo = fakeOceanPayoutsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, oceanPayoutsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline
    repo.rows.push({ id: 1, address: ADDR, ts: 1000, net_sat: 65_536, rail: 'lightning', enriched_alert: 0 });
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.body).toContain('Lightning');
  });

  it('short-circuits when no repo wired', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutConfirmedState());
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

});

describe('AlertEvaluator - pool_block_credited actual credit (#239 v2)', () => {
  // The queue captures unpaid BEFORE Ocean credits the block (~4 min
  // user_hashrate lag); once unpaid rises past it, the delta against
  // the entry's own noticing-time value IS the credit - exact, no
  // tilde, and independent of any previous alert (so a daemon restart
  // between blocks no longer downgrades the number to the estimate).
  const block = (height: number): import('../state/types.js').PoolBlocksTable => ({
    height,
    block_hash: `hash-${height}`,
    timestamp_ms: 1_000_000,
    total_reward_sat: 316_496_380, // ~3.165 BTC
    subsidy_sat: 312_500_000,
    fees_sat: 3_996_380,
    worker: null,
    username: null,
    observed_at_ms: 1_000_000,
  });

  function makePoolBlocksRepo(blocks: import('../state/types.js').PoolBlocksTable[]) {
    let visible: import('../state/types.js').PoolBlocksTable[] = [];
    return {
      repo: {
        maxHeight: vi.fn(async () => 100),
        sinceHeight: vi.fn(async (h: number) => visible.filter((b) => b.height > h)),
      } as unknown as NonNullable<ConstructorParameters<typeof AlertEvaluator>[0]['poolBlocksRepo']>,
      reveal: () => { visible = blocks; },
    };
  }

  const tickMetricsRepo = {
    nearestShareLogPct: vi.fn(async () => 0.0106),
  } as unknown as NonNullable<ConstructorParameters<typeof AlertEvaluator>[0]['tickMetricsRepo']>;

  function creditState(overrides: Partial<State>): State {
    return makeState({
      ...overrides,
      config: {
        ...(makeState({}).config),
        notify_on_pool_block_credit: true,
      } as State['config'],
    });
  }

  it('fires with the exact noticed-based delta (no tilde) once Ocean catches up - even with no prior-alert anchor', async () => {
    const mgr = makeManager();
    const { repo, reveal } = makePoolBlocksRepo([block(101)]);
    const ev = new AlertEvaluator({ alertManager: mgr, poolBlocksRepo: repo, tickMetricsRepo });
    // Tick 1: silent baseline (post-restart posture; no anchor exists).
    await ev.evaluate(creditState({ tick_at: 0, ocean_unpaid_sat: 925_094 } as Partial<State>));
    // Tick 2: block appears; unpaid still pre-credit -> queued, no fire.
    reveal();
    await ev.evaluate(creditState({ tick_at: 60_000, ocean_unpaid_sat: 925_094 } as Partial<State>));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
    // Tick 3: Ocean caught up -> fires with unpaid_now - noticed = 34,009.
    await ev.evaluate(creditState({ tick_at: 120_000, ocean_unpaid_sat: 959_103 } as Partial<State>));
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    const body = mgr.recorded[0]!.body;
    expect(mgr.recorded[0]!.event_class).toBe('pool_block_credited');
    // Exact credit, no tilde on the credit figure (the share-pct keeps
    // its own '~' - that one genuinely is an estimate).
    expect(body).toContain('Credited to you: 34,009 sat');
    expect(body).not.toContain('~34,009');
  });

  it('falls back to the ~ estimate when the failsafe fires (unpaid never rose)', async () => {
    const mgr = makeManager();
    const { repo, reveal } = makePoolBlocksRepo([block(101)]);
    const ev = new AlertEvaluator({ alertManager: mgr, poolBlocksRepo: repo, tickMetricsRepo });
    await ev.evaluate(creditState({ tick_at: 0, ocean_unpaid_sat: 925_094 } as Partial<State>));
    reveal();
    await ev.evaluate(creditState({ tick_at: 60_000, ocean_unpaid_sat: 925_094 } as Partial<State>));
    // 10-minute failsafe elapses without unpaid moving (e.g. Ocean stuck).
    await ev.evaluate(creditState({ tick_at: 60_000 + 10 * 60_000, ocean_unpaid_sat: 925_094 } as Partial<State>));
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    const body = mgr.recorded[0]!.body;
    // estimate = 316,496,380 x 0.0106% = 33,549 sat, tilde-prefixed.
    expect(body).toContain('Credited to you: ~33,549 sat');
  });
});

// ---------------------------------------------------------------------
// #372: mutation_failed - repeated bid-mutation execution failures.
// ---------------------------------------------------------------------

type Exec = NonNullable<Parameters<AlertEvaluator['evaluate']>[1]>[number];

function failed(kind = 'CREATE_BID', error = 'Braiins API POST /spot/bid returned 400 - Target not allowed'): Exec {
  return { proposal: { kind }, outcome: 'FAILED', error } as unknown as Exec;
}

function ok(kind = 'CREATE_BID'): Exec {
  return { proposal: { kind }, outcome: 'EXECUTED', note: 'ok' } as unknown as Exec;
}

function dryRun(kind = 'CREATE_BID'): Exec {
  return { proposal: { kind }, outcome: 'DRY_RUN', note: 'would create' } as unknown as Exec;
}

describe('AlertEvaluator - mutation_failed (#372)', () => {
  it('does not fire after two consecutive failing ticks', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('fires once on the third consecutive failing tick, with the latest error in the body', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(
      makeState({}),
      [failed('EDIT_PRICE', 'Braiins API PATCH /spot/bid returned 400 - blacklisted until 2026-08-22T19:01:40 UTC')],
    );
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('mutation_failed');
    expect(mgr.recorded[0]!.severity).toBe('IMPORTANT');
    expect(mgr.recorded[0]!.body).toContain('blacklisted until 2026-08-22T19:01:40 UTC');
    expect(mgr.recorded[0]!.body).toContain('EDIT_PRICE');
    // Stays open on further failing ticks - one alert, not four.
    await ev.evaluate(makeState({}), [failed()]);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });

  it('treats ticks with no executed mutation as neutral - neither increments nor resets', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    await ev.evaluate(makeState({}), [failed()]);
    // Quiet tick (nothing proposed) and a DRY_RUN tick: the marketplace
    // was never asked, so neither counts either way.
    await ev.evaluate(makeState({}), []);
    await ev.evaluate(makeState({}));
    await ev.evaluate(makeState({}), [dryRun()]);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
    await ev.evaluate(makeState({}), [failed()]);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
    // Third failing tick overall - fires despite the neutral ticks in between.
    await ev.evaluate(makeState({}), [failed()]);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('mutation_failed');
  });

  it('pairs a recovery when a tick executes all its mutations successfully', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]); // fires alert id=1
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    await ev.evaluate(makeState({}), [ok()]);
    expect(mgr.recordAlert).toHaveBeenCalledTimes(2);
    expect(mgr.recorded[1]!.event_class).toBe('mutation_failed_recovery');
    expect(mgr.recorded[1]!.severity).toBe('INFO');
    expect(mgr.recorded[1]!.paired_alert_id).toBe(1);
  });

  it('a partially-successful tick still counts as a failing tick', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    for (let i = 0; i < 3; i++) {
      await ev.evaluate(makeState({}), [ok('CANCEL_BID'), failed()]);
    }
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('mutation_failed');
  });

  it('a success before the third failure resets the streak (no fire)', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [ok()]);
    await ev.evaluate(makeState({}), [failed()]);
    await ev.evaluate(makeState({}), [failed()]);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('respects the per-event-class opt-out', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr, now: () => 0 });
    const muted = makeState({
      config: {
        ...(makeState({}).config as State['config']),
        notification_disabled_event_classes: ['mutation_failed'],
      },
    });
    for (let i = 0; i < 5; i++) await ev.evaluate(muted, [failed()]);
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });
});
