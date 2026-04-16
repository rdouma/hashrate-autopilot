import { describe, expect, it } from 'vitest';
import {
  SAT_PER_BTC,
  SECONDS_PER_DAY,
  btcToSats,
  convertHashrate,
  formatHashrate,
  rentalCostSats,
  rentalDurationSeconds,
  satsToBtc,
} from './units.js';

describe('convertHashrate', () => {
  it('is an identity on the same unit', () => {
    expect(convertHashrate(1, 'PH', 'PH')).toBe(1);
  });

  it('scales up the SI ladder correctly', () => {
    expect(convertHashrate(1, 'PH', 'TH')).toBe(1000);
    expect(convertHashrate(1, 'EH', 'PH')).toBe(1000);
    expect(convertHashrate(1, 'EH', 'TH')).toBe(1_000_000);
  });

  it('scales down the SI ladder correctly', () => {
    expect(convertHashrate(1000, 'TH', 'PH')).toBe(1);
    expect(convertHashrate(2_500, 'TH', 'PH')).toBe(2.5);
  });

  it('handles zero', () => {
    expect(convertHashrate(0, 'EH', 'H')).toBe(0);
  });
});

describe('rentalCostSats', () => {
  it('computes cost = price × hashrate(EH) × days', () => {
    // 1000 sat/EH/day × 1 EH × 1 day = 1000 sats
    expect(rentalCostSats(1000, 1, 'EH', SECONDS_PER_DAY)).toBe(1000);
  });

  it('scales linearly with duration', () => {
    expect(rentalCostSats(1000, 1, 'EH', SECONDS_PER_DAY * 7)).toBe(7000);
  });

  it('scales linearly with hashrate', () => {
    // 1 PH = 0.001 EH; at 1000 sat/EH/day × 1 PH × 1 day = 1 sat
    expect(rentalCostSats(1000, 1, 'PH', SECONDS_PER_DAY)).toBe(1);
  });

  it('is zero for zero duration', () => {
    expect(rentalCostSats(1000, 1, 'EH', 0)).toBe(0);
  });
});

describe('rentalDurationSeconds', () => {
  it('returns the duration a budget sustains at price × hashrate', () => {
    // budget 1000 sats / (1000 sat/EH/day × 1 EH) = 1 day
    expect(rentalDurationSeconds(1000, 1000, 1, 'EH')).toBe(SECONDS_PER_DAY);
  });

  it('inverts rentalCostSats', () => {
    const cost = rentalCostSats(500, 2, 'PH', SECONDS_PER_DAY * 3);
    const duration = rentalDurationSeconds(cost, 500, 2, 'PH');
    expect(duration).toBeCloseTo(SECONDS_PER_DAY * 3, 5);
  });

  it('returns 0 for non-positive price or hashrate', () => {
    expect(rentalDurationSeconds(1000, 0, 1, 'EH')).toBe(0);
    expect(rentalDurationSeconds(1000, 1000, 0, 'EH')).toBe(0);
  });
});

describe('sats/btc', () => {
  it('round-trips', () => {
    expect(satsToBtc(SAT_PER_BTC)).toBe(1);
    expect(btcToSats(1)).toBe(SAT_PER_BTC);
  });

  it('handles fractions', () => {
    expect(btcToSats(0.00012345)).toBe(12345);
  });
});

describe('formatHashrate', () => {
  it('picks EH for EH-scale values', () => {
    expect(formatHashrate(1, 'EH')).toBe('1.00 EH/s');
  });

  it('picks PH for PH-scale values', () => {
    expect(formatHashrate(2.5, 'PH')).toBe('2.50 PH/s');
  });

  it('picks TH for TH-scale values', () => {
    expect(formatHashrate(500, 'TH')).toBe('500.00 TH/s');
  });

  it('falls back to zero rendering', () => {
    expect(formatHashrate(0)).toBe('0 H/s');
  });

  it('converts between input units and picks the right display unit', () => {
    // 1000 TH/s = 1 PH/s
    expect(formatHashrate(1000, 'TH')).toBe('1.00 PH/s');
  });
});
