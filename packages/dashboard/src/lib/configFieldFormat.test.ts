import { describe, expect, it } from 'vitest';

import { configFieldLabel, formatConfigChange, formatConfigValue } from './configFieldFormat';

describe('configFieldFormat', () => {
  it("renders the operator's example human-readably at PH", () => {
    const { label, change } = formatConfigChange(
      'max_overpay_vs_hashprice_sat_per_eh_day',
      '2000000',
      '1500000',
      'PH',
    );
    expect(label).toBe('Max overpay vs hashprice');
    expect(change).toBe('2,000 → 1,500 sat/PH/day');
  });

  it('scales sat/EH/day to the selected unit', () => {
    expect(formatConfigValue('overpay_sat_per_eh_day', '1000000', 'PH').value).toBe('1,000');
    expect(formatConfigValue('overpay_sat_per_eh_day', '1000000', 'TH').value).toBe('1');
    expect(formatConfigValue('overpay_sat_per_eh_day', '1000000', 'EH').value).toBe('1,000,000');
    expect(formatConfigValue('overpay_sat_per_eh_day', '1000000', 'PH').suffix).toBe('sat/PH/day');
  });

  it('handles booleans, minutes, pct, ph, sat, and strings', () => {
    expect(formatConfigValue('solo_mining_enabled', 'true', 'PH')).toEqual({ value: 'on', suffix: '' });
    expect(formatConfigValue('below_floor_alert_after_minutes', '15', 'PH')).toEqual({ value: '15', suffix: 'min' });
    expect(formatConfigValue('bid_edit_deadband_pct', '20', 'PH')).toEqual({ value: '20', suffix: '%' });
    expect(formatConfigValue('target_hashrate_ph', '3', 'PH')).toEqual({ value: '3', suffix: 'PH/s' });
    expect(formatConfigValue('bid_budget_sat', '2000000', 'PH')).toEqual({ value: '2,000,000', suffix: 'sat' });
    expect(formatConfigValue('run_mode', 'LIVE', 'PH')).toEqual({ value: 'LIVE', suffix: '' });
  });

  it('derives readable labels and falls back on the key', () => {
    expect(configFieldLabel('below_floor_alert_after_minutes')).toBe('Below floor alert after');
    expect(configFieldLabel('target_hashrate_ph')).toBe('Target hashrate');
    expect(configFieldLabel('run_mode')).toBe('Run mode');
  });

  it('shows an em-dash placeholder for a null side', () => {
    expect(formatConfigChange('bid_budget_sat', null, '2000000', 'PH').change).toBe('— → 2,000,000 sat');
  });
});
