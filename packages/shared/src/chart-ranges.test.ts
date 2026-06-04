import { describe, expect, it } from 'vitest';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  pickBucketForSpan,
} from './chart-ranges.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('CHART_RANGE_SPECS', () => {
  it('has a spec for every enumerated range', () => {
    for (const r of CHART_RANGES) {
      expect(CHART_RANGE_SPECS[r]).toBeDefined();
      expect(CHART_RANGE_SPECS[r].range).toBe(r);
    }
  });

  it('default range is one of the enumerated options', () => {
    expect(CHART_RANGES).toContain(DEFAULT_CHART_RANGE);
  });

  it('all four event kinds shown at sub-day ranges', () => {
    for (const r of ['3h', '6h', '12h', '24h'] as const) {
      const kinds = CHART_RANGE_SPECS[r].showEventKinds;
      expect(kinds).toContain('CREATE_BID');
      expect(kinds).toContain('EDIT_PRICE');
      expect(kinds).toContain('EDIT_SPEED');
      expect(kinds).toContain('CANCEL_BID');
    }
  });

  it('1w drops EDIT_PRICE but keeps the rare kinds (#75)', () => {
    const kinds = CHART_RANGE_SPECS['1w'].showEventKinds;
    expect(kinds).not.toContain('EDIT_PRICE');
    expect(kinds).toContain('CREATE_BID');
    expect(kinds).toContain('EDIT_SPEED');
    expect(kinds).toContain('CANCEL_BID');
  });

  it('1m / 1y / all show no event markers', () => {
    expect(CHART_RANGE_SPECS['1m'].showEventKinds).toEqual([]);
    expect(CHART_RANGE_SPECS['1y'].showEventKinds).toEqual([]);
    expect(CHART_RANGE_SPECS.all.showEventKinds).toEqual([]);
  });
});

describe('parseChartRange', () => {
  it('accepts every valid preset', () => {
    for (const r of CHART_RANGES) {
      expect(parseChartRange(r)).toBe(r);
    }
  });

  it('returns null for anything else', () => {
    expect(parseChartRange('forever')).toBeNull();
    expect(parseChartRange('')).toBeNull();
    expect(parseChartRange(undefined)).toBeNull();
    expect(parseChartRange(42)).toBeNull();
  });
});

describe('pickBucketForSpan', () => {
  it('returns 0 (raw) when computed bucket is at or below the tick interval', () => {
    // 24h / 1440 = exactly 60_000 ms = tick interval → raw.
    expect(pickBucketForSpan(0)).toBe(0);
    expect(pickBucketForSpan(HOUR)).toBe(0);
    expect(pickBucketForSpan(12 * HOUR)).toBe(0);
    expect(pickBucketForSpan(24 * HOUR)).toBe(0);
  });

  it('grows proportionally past 24 h instead of cliffing to 30 min', () => {
    // Operator-stated expectation: 30h span → ~75s bucket (not 30 min).
    expect(pickBucketForSpan(26 * HOUR)).toBe(65_000); // 26h / 1440 = 65s
    expect(pickBucketForSpan(30 * HOUR)).toBe(75_000); // 30h / 1440 = 75s
    expect(pickBucketForSpan(48 * HOUR)).toBe(120_000); // 48h / 1440 = 2 min
  });

  it('lands at 7 min for 7 d (vs the old 30 min)', () => {
    expect(pickBucketForSpan(7 * DAY)).toBe(420_000); // 7 min
    expect(pickBucketForSpan(14 * DAY)).toBe(840_000); // 14 min
  });

  it('lands at exactly 30 min for 30 d (same as the old tier table)', () => {
    expect(pickBucketForSpan(30 * DAY)).toBe(30 * MINUTE);
  });

  it('scales smoothly through 365 d (~6 h) instead of jumping to 1 h then 1 d', () => {
    expect(pickBucketForSpan(60 * DAY)).toBe(HOUR); // 60d / 1440 = 1h exact
    expect(pickBucketForSpan(180 * DAY)).toBe(3 * HOUR); // 180d / 1440 = 3h exact
    expect(pickBucketForSpan(365 * DAY)).toBe(21_900_000); // ~6.083h
  });

  it('continues scaling past 1 year (no fixed ceiling)', () => {
    expect(pickBucketForSpan(2 * 365 * DAY)).toBe(2 * 21_900_000); // ~12h
    expect(pickBucketForSpan(5 * 365 * DAY)).toBe(5 * 21_900_000); // ~30h
  });
});
