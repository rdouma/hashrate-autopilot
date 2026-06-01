/**
 * #238: chart color resolution tests.
 */

import { describe, expect, it } from 'vitest';

import {
  CHART_COLOR_DEFAULTS,
  getChartColor,
  parseOverrides,
  serializeOverrides,
} from './chartColors.js';

describe('parseOverrides', () => {
  it('returns empty for null / undefined / empty string', () => {
    expect(parseOverrides(null)).toEqual({});
    expect(parseOverrides(undefined)).toEqual({});
    expect(parseOverrides('')).toEqual({});
  });

  it('returns empty for malformed JSON', () => {
    expect(parseOverrides('not json')).toEqual({});
    expect(parseOverrides('{')).toEqual({});
  });

  it('returns empty for non-object roots', () => {
    expect(parseOverrides('"a string"')).toEqual({});
    expect(parseOverrides('123')).toEqual({});
    expect(parseOverrides('[1,2,3]')).toEqual({});
    expect(parseOverrides('null')).toEqual({});
  });

  it('keeps valid hex overrides for known keys', () => {
    const result = parseOverrides(
      JSON.stringify({
        'hashrate.delivered': '#ff00ff',
        'price.our_bid': '#abcdef',
      }),
    );
    expect(result).toEqual({
      'hashrate.delivered': '#ff00ff',
      'price.our_bid': '#abcdef',
    });
  });

  it('silently drops unknown keys', () => {
    const result = parseOverrides(
      JSON.stringify({
        'hashrate.delivered': '#ff00ff',
        'made.up.key': '#ff0000',
      }),
    );
    expect(result).toEqual({ 'hashrate.delivered': '#ff00ff' });
  });

  it('silently drops non-hex values, non-strings, and bad formats', () => {
    const result = parseOverrides(
      JSON.stringify({
        'hashrate.delivered': 'red',       // not hex
        'hashrate.received_datum': '#fff', // 3-digit hex not accepted
        'hashrate.received_ocean': '#GGGGGG', // invalid hex
        'price.our_bid': 12345,            // not a string
        'price.fillable': null,            // not a string
        'price.hashprice': '#abcdef',      // valid - kept
      }),
    );
    expect(result).toEqual({ 'price.hashprice': '#abcdef' });
  });
});

describe('getChartColor', () => {
  it('returns the override when set', () => {
    expect(
      getChartColor('hashrate.delivered', { 'hashrate.delivered': '#abcdef' }),
    ).toBe('#abcdef');
  });

  it('returns the documented default when no override', () => {
    expect(getChartColor('hashrate.delivered', {})).toBe(
      CHART_COLOR_DEFAULTS['hashrate.delivered'],
    );
    expect(getChartColor('events.create', {})).toBe(CHART_COLOR_DEFAULTS['events.create']);
  });

  it('pins every default to a valid hex string (snapshot guard)', () => {
    for (const [key, value] of Object.entries(CHART_COLOR_DEFAULTS)) {
      expect(value, `${key} default must be #RRGGBB`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('serializeOverrides', () => {
  it('round-trips through parseOverrides', () => {
    const overrides = { 'hashrate.delivered': '#ff00ff' as const };
    const json = serializeOverrides(overrides);
    expect(parseOverrides(json)).toEqual(overrides);
  });

  it('drops malformed values during serialization', () => {
    const overrides = {
      'hashrate.delivered': '#ff00ff',
      'price.our_bid': 'red', // not hex
    } as unknown as Partial<Record<'hashrate.delivered' | 'price.our_bid', string>>;
    expect(serializeOverrides(overrides)).toBe(
      JSON.stringify({ 'hashrate.delivered': '#ff00ff' }),
    );
  });
});
