/**
 * #373: churn breaker + marketplace-blacklist hold. Pins the exact
 * semantics from the operator interview (2026-08-21): 3 zero-delivery
 * create→vanish cycles trip a manual-release hold; a blacklist 400
 * parses its expiry into an auto-releasing hold; the autopilot's own
 * cancels and genuinely-delivering bids never count as churn.
 */
import { describe, expect, it, vi } from 'vitest';

import { BidGuardService } from './bid-guard.js';
import type { ExecutionResult, Proposal } from '../controller/types.js';

const T0 = 1_787_300_000_000;

function makeGuard(startMs = T0) {
  let nowMs = startMs;
  const patches: unknown[] = [];
  const guard = new BidGuardService({
    now: () => nowMs,
    runtimeRepo: { patch: vi.fn(async (p: unknown) => void patches.push(p)) },
  });
  return {
    guard,
    patches,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function bid(id: string, speedPh = 0): { braiins_order_id: string; avg_speed_ph: number } {
  return { braiins_order_id: id, avg_speed_ph: speedPh };
}

function failedCreate(error: string): ExecutionResult {
  const proposal = {
    kind: 'CREATE_BID',
    price_sat: 1,
    amount_sat: 1,
    speed_limit_ph: 1,
    dest_pool_url: 'stratum+tcp://x:1',
    dest_worker_name: 'w',
    reason: 'test',
  } as unknown as Proposal;
  return { proposal, outcome: 'FAILED', error };
}

function executedCancel(id: string): ExecutionResult {
  const proposal = {
    kind: 'CANCEL_BID',
    braiins_order_id: id,
    reason: 'test',
  } as unknown as Proposal;
  return { proposal, outcome: 'EXECUTED', note: 'ok' };
}

describe('BidGuardService churn breaker (#373)', () => {
  it('trips a manual hold after 3 zero-delivery vanish cycles', () => {
    const { guard, advance } = makeGuard();
    for (let i = 1; i <= 3; i++) {
      guard.observeBids([bid(`b${i}`)], true);
      advance(60_000);
      guard.observeBids([], true); // vanished, no cancel by us, 0 delivered
      expect(guard.getHold()?.kind ?? null).toBe(i >= 3 ? 'churn' : null);
      advance(60_000);
    }
    // Manual-release: time passing never clears it.
    advance(48 * 60 * 60_000);
    expect(guard.getHold()?.kind).toBe('churn');
    expect(guard.getHold()?.until_ms).toBeNull();
    guard.clearHold();
    expect(guard.getHold()).toBeNull();
  });

  it('our own cancels are neutral - never churn', () => {
    const { guard, advance } = makeGuard();
    for (let i = 1; i <= 5; i++) {
      guard.observeBids([bid(`b${i}`)], true);
      guard.observeExecuted([executedCancel(`b${i}`)]);
      advance(60_000);
      guard.observeBids([], true);
    }
    expect(guard.getHold()).toBeNull();
  });

  it('a bid that delivered real hashrate resets the streak', () => {
    const { guard, advance } = makeGuard();
    // Two churn cycles...
    for (let i = 1; i <= 2; i++) {
      guard.observeBids([bid(`z${i}`)], true);
      advance(60_000);
      guard.observeBids([], true);
    }
    // ...then a healthy bid delivers 3 PH and ends (e.g. fulfilled).
    guard.observeBids([bid('good', 3.1)], true);
    advance(60_000);
    guard.observeBids([], true);
    // Two more churn cycles must NOT trip (streak restarted at 0).
    for (let i = 3; i <= 4; i++) {
      guard.observeBids([bid(`z${i}`)], true);
      advance(60_000);
      guard.observeBids([], true);
    }
    expect(guard.getHold()).toBeNull();
  });

  it('a failed bids fetch never counts as disappearance', () => {
    const { guard, advance } = makeGuard();
    guard.observeBids([bid('a'), bid('b'), bid('c')], true);
    advance(60_000);
    guard.observeBids([], false); // fetch failed - everything "gone"
    advance(60_000);
    guard.observeBids([bid('a'), bid('b'), bid('c')], true); // back
    expect(guard.getHold()).toBeNull();
  });
});

describe('BidGuardService blacklist hold (#373)', () => {
  const ERROR =
    'Braiins API POST /spot/bid returned 400 - Target not allowed (blacklisted until 2026-08-22T19:01:40.951541240+00:00)';

  it('parses the expiry and auto-releases after it (plus margin)', () => {
    const start = Date.parse('2026-08-21T22:10:00Z');
    const { guard, advance } = makeGuard(start);
    guard.observeExecuted([failedCreate(ERROR)]);
    const hold = guard.getHold();
    expect(hold?.kind).toBe('blacklist');
    // expiry 2026-08-22T19:01:40.951Z + 5 min margin
    const expected = Date.parse('2026-08-22T19:01:40.951Z') + 5 * 60_000;
    expect(hold?.until_ms).toBe(expected);
    // Still held one minute before release...
    advance(expected - start - 60_000);
    expect(guard.getHold()?.kind).toBe('blacklist');
    // ...auto-clears once past it.
    advance(2 * 60_000);
    expect(guard.getHold()).toBeNull();
  });

  it('falls back to a 24h hold when the timestamp is unparseable', () => {
    const { guard } = makeGuard();
    guard.observeExecuted([
      failedCreate('400 - Target not allowed (blacklisted until whenever)'),
    ]);
    const hold = guard.getHold();
    expect(hold?.kind).toBe('blacklist');
    expect(hold?.until_ms).toBe(T0 + 24 * 60 * 60_000);
  });

  it('ignores unrelated CREATE failures', () => {
    const { guard } = makeGuard();
    guard.observeExecuted([failedCreate('500 - internal error')]);
    expect(guard.getHold()).toBeNull();
  });

  it('persists holds through the runtime repo and hydrates them back', () => {
    const { guard, patches } = makeGuard();
    guard.observeExecuted([failedCreate(ERROR)]);
    expect(patches.length).toBe(1);
    const persisted = patches[0] as Record<string, unknown>;
    expect(persisted['create_hold_kind']).toBe('blacklist');

    const fresh = makeGuard().guard;
    fresh.hydrate({
      create_hold_kind: 'churn',
      create_hold_until_ms: null,
      create_hold_detail: 'from a previous run',
      create_hold_since_ms: T0 - 1000,
    });
    expect(fresh.getHold()?.kind).toBe('churn');
    expect(fresh.getHold()?.detail).toBe('from a previous run');
  });
});
