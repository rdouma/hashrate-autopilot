import { describe, expect, it } from 'vitest';

import {
  cheapestAskForDepth,
  unmatchedPh,
  type OrderbookAsk,
} from './orderbook.js';

describe('cheapestAskForDepth', () => {
  it('returns null on an empty book', () => {
    expect(cheapestAskForDepth([], 1.5)).toEqual({
      price_sat: null,
      thin: true,
      cumulative_ph: 0,
    });
    expect(cheapestAskForDepth(undefined, 1.5)).toEqual({
      price_sat: null,
      thin: true,
      cumulative_ph: 0,
    });
  });

  it('skips asks with zero or missing hr_available_ph', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 0 },
      { price_sat: 46_000_000 }, // undefined
      { price_sat: 47_000_000, hr_available_ph: 2.0 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result).toEqual({
      price_sat: 47_000_000,
      thin: false,
      cumulative_ph: 2.0,
    });
  });

  it('walks cumulatively across multiple small asks until target is met', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 0.3 },
      { price_sat: 45_500_000, hr_available_ph: 0.6 },
      { price_sat: 46_000_000, hr_available_ph: 0.9 }, // cum = 1.8 ≥ 1.5
      { price_sat: 47_000_000, hr_available_ph: 10 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(46_000_000);
    expect(result.thin).toBe(false);
    expect(result.cumulative_ph).toBeCloseTo(1.8, 5);
  });

  it('hits target exactly at the boundary ask', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 1.0 },
      { price_sat: 46_000_000, hr_available_ph: 0.5 }, // cum = 1.5
      { price_sat: 47_000_000, hr_available_ph: 5 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(46_000_000);
    expect(result.thin).toBe(false);
  });

  it('returns the single ask when it alone satisfies the target', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 47_803_000, hr_available_ph: 155 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(47_803_000);
    expect(result.thin).toBe(false);
    expect(result.cumulative_ph).toBe(155);
  });

  it('ignores a tiny topmost ask that misleads the naive walk', () => {
    // Mimic the 2026-04-16 empirical scenario: microscopic supply at the
    // top of the book, real depth a couple of levels higher.
    const asks: OrderbookAsk[] = [
      { price_sat: 45_070_000, hr_available_ph: 0.01 },
      { price_sat: 45_200_000, hr_available_ph: 0 },
      { price_sat: 47_803_000, hr_available_ph: 155 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(47_803_000);
  });

  it('marks the result thin when cumulative supply falls short of target', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 0.3 },
      { price_sat: 46_000_000, hr_available_ph: 0.2 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(46_000_000); // highest with supply
    expect(result.thin).toBe(true);
    expect(result.cumulative_ph).toBeCloseTo(0.5, 5);
  });

  it('sorts asks regardless of input order', () => {
    const asks: OrderbookAsk[] = [
      { price_sat: 47_000_000, hr_available_ph: 5 },
      { price_sat: 45_000_000, hr_available_ph: 1 },
      { price_sat: 46_000_000, hr_available_ph: 1 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    // Cumulative: 1 @ 45M, 2 @ 46M → target hit at 46M
    expect(result.price_sat).toBe(46_000_000);
  });

  it('subtracts hr_matched_ph from hr_available_ph — the Braiins semantic', () => {
    // Fully-matched level contributes zero unmatched supply even though
    // `hr_available_ph` is huge.
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 133.13, hr_matched_ph: 133.13 },
      { price_sat: 46_000_000, hr_available_ph: 558.4, hr_matched_ph: 553.9 }, // ~4.5 open
      { price_sat: 47_000_000, hr_available_ph: 720.6, hr_matched_ph: 352.2 }, // ~368 open
    ];
    // Target 1.5 PH: first level that brings cumulative unmatched to >=1.5
    // is the 46M level (cumulative unmatched = 4.5 there).
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(46_000_000);
    expect(result.thin).toBe(false);
    expect(result.cumulative_ph).toBeCloseTo(4.5, 1);
  });

  it('regression: the 2026-04-16 live orderbook', () => {
    // Exact capture from decisions_json that day. Old behaviour returned
    // 45,054 (topmost ask with any `hr_available_ph > 0`) which was fully
    // matched → we bid at 46,054 and never filled. With matched-aware
    // accounting the real fillable level is 46,419 (first level with
    // cumulative UNMATCHED supply ≥ 1.5 PH).
    const asks: OrderbookAsk[] = [
      { price_sat: 45_054_000, hr_available_ph: 133.13, hr_matched_ph: 133.13 },
      { price_sat: 45_281_000, hr_available_ph: 209.25, hr_matched_ph: 209.25 },
      { price_sat: 45_509_000, hr_available_ph: 380.68, hr_matched_ph: 380.68 },
      { price_sat: 45_736_000, hr_available_ph: 465.83, hr_matched_ph: 465.83 },
      { price_sat: 45_964_000, hr_available_ph: 558.41, hr_matched_ph: 553.94 }, // 4.47 open
      { price_sat: 46_419_000, hr_available_ph: 720.64, hr_matched_ph: 352.20 }, // 368.44 open
      { price_sat: 46_874_000, hr_available_ph: 505.60, hr_matched_ph: 0 },
      { price_sat: 47_784_000, hr_available_ph: 593.31, hr_matched_ph: 0 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    // Cumulative unmatched at 45,964 = 4.47 ≥ 1.5, so that's where it fills.
    expect(result.price_sat).toBe(45_964_000);
    expect(result.thin).toBe(false);
    expect(result.cumulative_ph).toBeCloseTo(4.47, 1);
  });

  it('treats missing hr_matched_ph as 0 (backward compat)', () => {
    // If a caller passes only hr_available_ph (no matched field), we
    // assume none is matched. Useful for synthetic data / older callers.
    const asks: OrderbookAsk[] = [
      { price_sat: 45_000_000, hr_available_ph: 2 },
      { price_sat: 46_000_000, hr_available_ph: 5 },
    ];
    const result = cheapestAskForDepth(asks, 1.5);
    expect(result.price_sat).toBe(45_000_000);
  });
});

describe('unmatchedPh', () => {
  it('returns available minus matched', () => {
    expect(unmatchedPh({ price_sat: 1, hr_available_ph: 10, hr_matched_ph: 3 })).toBe(7);
  });

  it('clamps to 0 when matched >= available', () => {
    expect(unmatchedPh({ price_sat: 1, hr_available_ph: 3, hr_matched_ph: 5 })).toBe(0);
    expect(unmatchedPh({ price_sat: 1, hr_available_ph: 3, hr_matched_ph: 3 })).toBe(0);
  });

  it('treats missing fields as 0', () => {
    expect(unmatchedPh({ price_sat: 1 })).toBe(0);
    expect(unmatchedPh({ price_sat: 1, hr_available_ph: 5 })).toBe(5);
  });
});
