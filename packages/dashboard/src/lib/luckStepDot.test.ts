import { describe, expect, it } from 'vitest';

import { pickLuckStepDot } from './luckStepDot';

/**
 * Helper: a decaying line. 24h pool luck decays a little every tick
 * between events (expected blocks grows with elapsed time), which is
 * exactly the property that broke v1's min-over-window for AGED OUT.
 */
function decay(from: number, ticks: number, perTick = 0.005): number[] {
  return Array.from({ length: ticks }, (_, i) => from - i * perTick);
}

describe('pickLuckStepDot - FOUND (in)', () => {
  it('lands on the post-step value when Ocean updates immediately', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, [2.1, 2.1, 2.1, 2.1]);
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });

  it('lands at the step when Ocean lags past the legacy 15-tick fence', () => {
    // 20 ticks of slowly-decaying pre-step before the jump - v1's
    // 15-tick scan gave up here; v2 finds the +0.6 jump at offset 20.
    const window = [...decay(1.5, 20), 2.1, 2.095, 2.09];
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, window);
    expect(r?.offset).toBe(20);
    expect(r?.luck).toBe(2.1);
  });

  it('picks the largest upward jump, not later noise', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [1.5, 1.5, 1.6, 1.8, 2.1, 2.0, 1.9],
    );
    // Largest up-delta is 1.8→2.1 (+0.3); dot at the post-step tick.
    expect(r).toEqual({ offset: 4, luck: 2.1 });
  });

  it('falls back to luckBefore when Ocean never updates in window', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, [1.5, 1.5, 1.5, 1.5]);
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('falls back to luckBefore on pure decay (no step yet)', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, decay(1.5, 30));
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('falls back to luckBefore when the data moves AGAINST the FOUND direction', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, [1.5, 1.3, 1.2, 1.1]);
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('handles null-laced windows (Ocean skipped some snapshots)', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [null, null, 1.5, null, 2.1, null, 2.09],
    );
    expect(r).toEqual({ offset: 4, luck: 2.1 });
  });

  it('uses the step when luckBefore is null (event at start of data)', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], null, [null, 1.5, 2.1, 2.09]);
    expect(r).toEqual({ offset: 2, luck: 2.1 });
  });
});

describe('pickLuckStepDot - AGED OUT (out)', () => {
  it('lands on the post-step value when Ocean updates immediately', () => {
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, [1.5, 1.5, 1.5, 1.5]);
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('REGRESSION (build 653 screenshot): dot sits at the step, not the end of the decay', () => {
    // The v1 failure: an AGED OUT step (2.1 → 1.85 at offset 10)
    // followed by 49 ticks of decay. min(window) was the last tick
    // (~1.6) so the dot drifted to the far right-bottom, visually
    // disconnected from the step. v2 picks the -0.25 drop at the
    // step itself.
    const window = [...decay(2.1, 10), 1.85, ...decay(1.85 - 0.005, 49)];
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, window);
    expect(r?.offset).toBe(10);
    expect(r?.luck).toBe(1.85);
  });

  it('lands at the step when Ocean lags past the legacy 15-tick fence', () => {
    const window = [...decay(2.1, 20), 1.5, 1.495, 1.49];
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, window);
    expect(r?.offset).toBe(20);
    expect(r?.luck).toBe(1.5);
  });

  it('picks the largest single drop in noisy data', () => {
    const r = pickLuckStepDot(
      [{ kind: 'out' }],
      2.1,
      [2.1, 2.1, 1.9, 1.7, 1.4, 1.45, 1.5],
    );
    // Drops: -0.2 (idx2), -0.2 (idx3), -0.3 (idx4). Largest at idx4.
    expect(r).toEqual({ offset: 4, luck: 1.4 });
  });

  it('falls back to luckBefore when Ocean never updates in window', () => {
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, [2.1, 2.1, 2.1, 2.1]);
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });

  it('treats pure decay as no-step (falls back to luckBefore)', () => {
    // Decay drops every tick but uniformly - the median filter means
    // none of them reads as THE step.
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, decay(2.1, 30));
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });

  it('falls back to luckBefore when the data moves AGAINST the AGED direction', () => {
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, [2.1, 2.2, 2.3, 2.4]);
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });
});

describe('pickLuckStepDot - mixed (in+out at same tick)', () => {
  it('picks first value differing from luckBefore (legacy semantic)', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }, { kind: 'out' }],
      1.5,
      [1.5, 1.5, 1.7, 1.7],
    );
    expect(r).toEqual({ offset: 2, luck: 1.7 });
  });

  it('falls back to luckBefore when no change in window', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }, { kind: 'out' }],
      1.5,
      [1.5, 1.5, 1.5, 1.5],
    );
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });
});

describe('pickLuckStepDot - edge cases', () => {
  it('returns null when window is empty AND luckBefore is null', () => {
    expect(pickLuckStepDot([{ kind: 'in' }], null, [])).toBeNull();
  });

  it('returns luckBefore when window is empty but luckBefore is known', () => {
    expect(pickLuckStepDot([{ kind: 'in' }], 1.5, [])).toEqual({
      offset: 0,
      luck: 1.5,
    });
  });

  it('returns null when window is all nulls AND luckBefore is null', () => {
    expect(pickLuckStepDot([{ kind: 'in' }], null, [null, null, null])).toBeNull();
  });

  it('single sample without luckBefore anchors on that sample', () => {
    expect(pickLuckStepDot([{ kind: 'out' }], null, [null, 1.7])).toEqual({
      offset: 1,
      luck: 1.7,
    });
  });
});
