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

  it('events are visible for short ranges and hidden for ≥ 1 month', () => {
    expect(CHART_RANGE_SPECS['6h'].showEvents).toBe(true);
    expect(CHART_RANGE_SPECS['12h'].showEvents).toBe(true);
    expect(CHART_RANGE_SPECS['24h'].showEvents).toBe(true);
    expect(CHART_RANGE_SPECS['1w'].showEvents).toBe(true);
    expect(CHART_RANGE_SPECS['1m'].showEvents).toBe(false);
    expect(CHART_RANGE_SPECS['1y'].showEvents).toBe(false);
    expect(CHART_RANGE_SPECS.all.showEvents).toBe(false);
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
  it('returns raw (0) for spans up to a week', () => {
    expect(pickBucketForSpan(0)).toBe(0);
    expect(pickBucketForSpan(HOUR)).toBe(0);
    expect(pickBucketForSpan(DAY)).toBe(0);
    expect(pickBucketForSpan(7 * DAY)).toBe(0);
  });

  it('switches to 5 min between 1 week and 1 month', () => {
    expect(pickBucketForSpan(7 * DAY + 1)).toBe(5 * MINUTE);
    expect(pickBucketForSpan(14 * DAY)).toBe(5 * MINUTE);
    expect(pickBucketForSpan(30 * DAY)).toBe(5 * MINUTE);
  });

  it('switches to 1 h between 1 month and 1 year', () => {
    expect(pickBucketForSpan(30 * DAY + 1)).toBe(HOUR);
    expect(pickBucketForSpan(180 * DAY)).toBe(HOUR);
    expect(pickBucketForSpan(365 * DAY)).toBe(HOUR);
  });

  it('switches to 1 d past 1 year', () => {
    expect(pickBucketForSpan(365 * DAY + 1)).toBe(DAY);
    expect(pickBucketForSpan(5 * 365 * DAY)).toBe(DAY);
  });
});
