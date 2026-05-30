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

// #226: payout_confirmed detection. The trigger is a new
// `reward_events` row (id > the in-memory watermark, reorged = 0).
// Silent-baseline contract on first tick after construction.
describe('AlertEvaluator - payout_confirmed (#226)', () => {
  type RewardRow = {
    id: number;
    txid: string;
    vout: number;
    block_height: number;
    confirmations: number;
    value_sat: number;
    detected_at: number;
    reorged: number;
  };

  function fakeRewardEventsRepo(initial: RewardRow[] = []) {
    const rows = [...initial];
    return {
      rows,
      async maxId() {
        return rows.length === 0 ? null : Math.max(...rows.map((r) => r.id));
      },
      async sinceId(sinceId: number) {
        return rows.filter((r) => r.id > sinceId && r.reorged === 0);
      },
      async listSince() { return [] as RewardRow[]; },
      async sumPaidUpTo() { return 0; },
    };
  }

  function payoutConfirmedState(overrides: Partial<State> = {}): State {
    return makeState({
      ...overrides,
      config: {
        ...(makeState({}).config),
        notify_on_payout_confirmed: true,
      } as State['config'],
    });
  }

  it('does nothing while the toggle is off', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo([
      { id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 0 },
    ]);
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(makeState({ ocean_unpaid_sat: null } as Partial<State>));
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('silently baselines on first tick after construction (no fire for existing rows)', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo([
      { id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 0 },
      { id: 2, txid: 'def', vout: 0, block_height: 200, confirmations: 6, value_sat: 1_070_000, detected_at: 100, reorged: 0 },
    ]);
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('fires once for the first new row after baseline', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo([
      { id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 0 },
    ]);
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline
    // Scanner inserts a new row, then next tick fires.
    repo.rows.push({ id: 2, txid: 'def', vout: 0, block_height: 200, confirmations: 6, value_sat: 1_070_000, detected_at: 100, reorged: 0 });
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
    expect(mgr.recorded[0]!.event_class).toBe('payout_confirmed');
    expect(mgr.recorded[0]!.severity).toBe('INFO');
  });

  it('does not refire on subsequent ticks for the same row', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline at -1
    repo.rows.push({ id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 0 });
    await ev.evaluate(payoutConfirmedState()); // fires
    await ev.evaluate(payoutConfirmedState()); // no new rows
    await ev.evaluate(payoutConfirmedState()); // still no new rows
    expect(mgr.recordAlert).toHaveBeenCalledTimes(1);
  });

  it('fires once per new row when multiple land between ticks', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline at -1
    repo.rows.push(
      { id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 0 },
      { id: 2, txid: 'def', vout: 0, block_height: 200, confirmations: 6, value_sat: 1_070_000, detected_at: 100, reorged: 0 },
    );
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).toHaveBeenCalledTimes(2);
  });

  it('skips reorged rows', async () => {
    const mgr = makeManager();
    const repo = fakeRewardEventsRepo();
    const ev = new AlertEvaluator({ alertManager: mgr, rewardEventsRepo: repo as never });
    await ev.evaluate(payoutConfirmedState()); // baseline
    repo.rows.push(
      { id: 1, txid: 'abc', vout: 0, block_height: 100, confirmations: 6, value_sat: 1_062_144, detected_at: 0, reorged: 1 },
    );
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

  it('short-circuits when no repo wired', async () => {
    const mgr = makeManager();
    const ev = new AlertEvaluator({ alertManager: mgr });
    await ev.evaluate(payoutConfirmedState());
    await ev.evaluate(payoutConfirmedState());
    expect(mgr.recordAlert).not.toHaveBeenCalled();
  });

});
