/**
 * Unit tests for the pure bits of observe() - primarily the
 * below_floor_since hysteresis (issue #10). The computeBelowFloorSince
 * function is pulled out and exported so we can drive it with fabricated
 * inputs instead of standing up a whole Braiins/pool/DB surface.
 */

import { describe, expect, it } from 'vitest';

import type { PoolProbeResult } from '../services/pool-health.js';

import { FLOOR_DEBOUNCE_TICKS, computeBelowFloorSince } from './observe.js';

const FLOOR_PH = 1.0;
const REACHABLE: PoolProbeResult = {
  reachable: true,
  checked_at: 0,
  latency_ms: 10,
  error: null,
};
const UNREACHABLE: PoolProbeResult = {
  reachable: false,
  checked_at: 0,
  latency_ms: null,
  error: 'ECONNREFUSED',
};

describe('computeBelowFloorSince - hysteresis', () => {
  it('starts the timer on the first below-floor tick', () => {
    const r = computeBelowFloorSince(0.0, FLOOR_PH, null, 0, 1_000, REACHABLE, true);
    expect(r).toEqual({ below_floor_since: 1_000, above_floor_ticks: 0 });
  });

  it('preserves the timer on subsequent below-floor ticks', () => {
    const r = computeBelowFloorSince(0.0, FLOOR_PH, 1_000, 0, 2_000, REACHABLE, true);
    expect(r).toEqual({ below_floor_since: 1_000, above_floor_ticks: 0 });
  });

  it('resets the above-floor counter whenever delivery drops below floor', () => {
    // Was about to clear; drops below floor at the last moment.
    const r = computeBelowFloorSince(
      0.5,
      FLOOR_PH,
      1_000,
      FLOOR_DEBOUNCE_TICKS - 1,
      5_000,
      REACHABLE,
      true,
    );
    expect(r).toEqual({ below_floor_since: 1_000, above_floor_ticks: 0 });
  });

  it('holds the timer for a single above-floor tick - does NOT clear', () => {
    // This is the #10 bug case: a transient spike from Braiins' lagged
    // rolling avg_speed_ph on a bid-state flicker. One above-floor tick
    // must not clear a multi-minute drought.
    const r = computeBelowFloorSince(1.2, FLOOR_PH, 1_000, 0, 5_000, REACHABLE, true);
    expect(r.below_floor_since).toBe(1_000);
    expect(r.above_floor_ticks).toBe(1);
  });

  it('still holds the timer at ticks < FLOOR_DEBOUNCE_TICKS', () => {
    const r = computeBelowFloorSince(
      1.2,
      FLOOR_PH,
      1_000,
      FLOOR_DEBOUNCE_TICKS - 2,
      5_000,
      REACHABLE,
      true,
    );
    expect(r.below_floor_since).toBe(1_000);
    expect(r.above_floor_ticks).toBe(FLOOR_DEBOUNCE_TICKS - 1);
  });

  it('clears the timer once FLOOR_DEBOUNCE_TICKS consecutive above-floor ticks accumulate', () => {
    const r = computeBelowFloorSince(
      1.2,
      FLOOR_PH,
      1_000,
      FLOOR_DEBOUNCE_TICKS - 1,
      5_000,
      REACHABLE,
      true,
    );
    expect(r.below_floor_since).toBeNull();
    expect(r.above_floor_ticks).toBe(FLOOR_DEBOUNCE_TICKS);
  });

  it('caps the above-floor counter at FLOOR_DEBOUNCE_TICKS', () => {
    const r = computeBelowFloorSince(
      2.0,
      FLOOR_PH,
      null,
      FLOOR_DEBOUNCE_TICKS,
      5_000,
      REACHABLE,
      true,
    );
    expect(r.above_floor_ticks).toBe(FLOOR_DEBOUNCE_TICKS);
  });

  it('flicker scenario: below → below → above (stale spike) → below stays on same timer', () => {
    // tick 0: below floor, timer starts at t=0
    let s = computeBelowFloorSince(0.0, FLOOR_PH, null, 0, 0, REACHABLE, true);
    expect(s.below_floor_since).toBe(0);

    // tick 1-4: still below floor
    for (let t = 1; t <= 4; t++) {
      s = computeBelowFloorSince(
        0.0,
        FLOOR_PH,
        s.below_floor_since,
        s.above_floor_ticks,
        t * 60_000,
        REACHABLE,
        true,
      );
      expect(s.below_floor_since).toBe(0);
    }

    // tick 5: bid flickers ACTIVE with a stale 1.2 PH/s rolling avg.
    // This is the #10 bug - old code cleared here. New code must hold.
    s = computeBelowFloorSince(
      1.2,
      FLOOR_PH,
      s.below_floor_since,
      s.above_floor_ticks,
      5 * 60_000,
      REACHABLE,
      true,
    );
    expect(s.below_floor_since).toBe(0);
    expect(s.above_floor_ticks).toBe(1);

    // tick 6: back to 0 delivery as real delivery hasn't resumed
    s = computeBelowFloorSince(
      0.0,
      FLOOR_PH,
      s.below_floor_since,
      s.above_floor_ticks,
      6 * 60_000,
      REACHABLE,
      true,
    );
    // Timer MUST still point at t=0, not a reset to 6 * 60_000.
    expect(s.below_floor_since).toBe(0);
    expect(s.above_floor_ticks).toBe(0);
  });

  it('genuine sustained recovery (FLOOR_DEBOUNCE_TICKS consecutive above-floor ticks) clears the timer', () => {
    let s = { below_floor_since: 0 as number | null, above_floor_ticks: 0 };
    for (let t = 1; t <= FLOOR_DEBOUNCE_TICKS; t++) {
      s = computeBelowFloorSince(
        2.0,
        FLOOR_PH,
        s.below_floor_since,
        s.above_floor_ticks,
        t * 60_000,
        REACHABLE,
        true,
      );
    }
    expect(s.below_floor_since).toBeNull();
    expect(s.above_floor_ticks).toBe(FLOOR_DEBOUNCE_TICKS);
  });

  it('freezes state when API is down - preserves both timer and counter', () => {
    const r = computeBelowFloorSince(0.0, FLOOR_PH, 1_000, 2, 9_999, REACHABLE, false);
    expect(r).toEqual({ below_floor_since: 1_000, above_floor_ticks: 2 });
  });

  it('freezes state when pool is unreachable - preserves both timer and counter', () => {
    const r = computeBelowFloorSince(2.0, FLOOR_PH, 1_000, 2, 9_999, UNREACHABLE, true);
    expect(r).toEqual({ below_floor_since: 1_000, above_floor_ticks: 2 });
  });
});
