import { describe, expect, it } from 'vitest';

import {
  formatTimeTick,
  localAlignedTimeTicks,
  pickTimeTickInterval,
} from './chart-axis.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('pickTimeTickInterval', () => {
  it('returns sub-hour intervals for short spans', () => {
    expect(pickTimeTickInterval(30 * MIN)).toBe(5 * MIN);
    expect(pickTimeTickInterval(60 * MIN)).toBe(10 * MIN);
    expect(pickTimeTickInterval(2 * HOUR)).toBe(30 * MIN);
  });

  it('returns hourly+ for medium spans', () => {
    expect(pickTimeTickInterval(6 * HOUR)).toBe(HOUR);
    expect(pickTimeTickInterval(12 * HOUR)).toBe(2 * HOUR);
    expect(pickTimeTickInterval(24 * HOUR)).toBe(6 * HOUR);
  });

  it('returns daily+ for long spans (target = span/6, picks next-larger candidate)', () => {
    // 7 days / 6 ≈ 28h → next candidate is 2*DAY
    expect(pickTimeTickInterval(7 * DAY)).toBe(2 * DAY);
    // 30 days / 6 = 5d → next candidate is 7*DAY
    expect(pickTimeTickInterval(30 * DAY)).toBe(7 * DAY);
    // 4 days / 6 ≈ 16h → next candidate is 1*DAY
    expect(pickTimeTickInterval(4 * DAY)).toBe(DAY);
  });
});

describe('localAlignedTimeTicks', () => {
  it('returns hourly ticks aligned to local top-of-hour', () => {
    // Pick a span that crosses several hours. Use Date.now()-relative
    // values so the test stays timezone-agnostic — we only check the
    // *alignment*, not the absolute clock value.
    const start = new Date();
    start.setHours(8, 37, 12, 555); // not on the hour
    const end = new Date(start);
    end.setHours(end.getHours() + 4); // span ~4h 23m

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), HOUR);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getMinutes()).toBe(0);
      expect(d.getSeconds()).toBe(0);
    }
  });

  it('returns minute ticks aligned to multiples of stepMinutes', () => {
    const start = new Date();
    start.setHours(10, 7, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 60);

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), 15 * MIN);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getMinutes() % 15).toBe(0);
    }
  });

  it('returns daily ticks aligned to local midnight', () => {
    const start = new Date();
    start.setHours(14, 30, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);

    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), DAY);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    for (const t of ticks) {
      const d = new Date(t);
      expect(d.getHours()).toBe(0);
      expect(d.getMinutes()).toBe(0);
    }
  });

  it('returns empty when maxMs <= minMs', () => {
    expect(localAlignedTimeTicks(1000, 1000, HOUR)).toEqual([]);
    expect(localAlignedTimeTicks(2000, 1000, HOUR)).toEqual([]);
  });

  it('every emitted tick lies within [minMs, maxMs]', () => {
    const start = new Date();
    start.setHours(8, 37, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + 6);
    const ticks = localAlignedTimeTicks(start.getTime(), end.getTime(), HOUR);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(start.getTime());
      expect(t).toBeLessThanOrEqual(end.getTime());
    }
  });
});

describe('formatTimeTick', () => {
  it('formats sub-day intervals as HH:mm 24-hour', () => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    const out = formatTimeTick(d.getTime(), HOUR, 'en-US');
    // Various locales render 09:00 differently; verify a 5-char HH:mm
    // string with the leading zero preserved.
    expect(out).toMatch(/^\d{2}:\d{2}$/);
    expect(out.startsWith('09')).toBe(true);
  });

  it('formats day+ intervals as a date label (no time)', () => {
    const d = new Date(2026, 3, 16, 14, 0, 0);
    const out = formatTimeTick(d.getTime(), DAY, 'en-US');
    expect(out).toMatch(/16/);
    expect(out).not.toMatch(/:/);
  });
});
