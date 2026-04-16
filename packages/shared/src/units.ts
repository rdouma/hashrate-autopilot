/**
 * Unit conversions for hashrate and sat-denominated pricing.
 *
 * Market convention on Braiins: price is sat per (1 EH/s) per (1 day).
 * See RESEARCH.md §2 and /spot/settings.hr_unit.
 */

export const SAT_PER_BTC = 100_000_000;
export const SECONDS_PER_DAY = 86_400;

// SI powers of 10, base 1000. EH/s = 1e18 H/s.
export const HASHRATE_UNITS = {
  H: 1,
  kH: 1e3,
  MH: 1e6,
  GH: 1e9,
  TH: 1e12,
  PH: 1e15,
  EH: 1e18,
} as const satisfies Record<string, number>;

export type HashrateUnit = keyof typeof HASHRATE_UNITS;

/**
 * Convert a hashrate value between units. Performs the scale ratio as a float
 * division so intermediate values don't blow past 2^53 when the magnitudes
 * involved are large (e.g. 1 EH in H = 1e18, above safe-integer range).
 */
export function convertHashrate(value: number, from: HashrateUnit, to: HashrateUnit): number {
  if (from === to) return value;
  return value * (HASHRATE_UNITS[from] / HASHRATE_UNITS[to]);
}

/**
 * Cost in sats for a given rental, where price is sat-per-EH-per-day.
 */
export function rentalCostSats(
  priceSatPerEHPerDay: number,
  hashrateValue: number,
  hashrateUnit: HashrateUnit,
  durationSeconds: number,
): number {
  const hashrateEH = convertHashrate(hashrateValue, hashrateUnit, 'EH');
  const days = durationSeconds / SECONDS_PER_DAY;
  return priceSatPerEHPerDay * hashrateEH * days;
}

/**
 * Duration in seconds that a given sat budget will sustain a rental at the
 * given price and hashrate.
 */
export function rentalDurationSeconds(
  budgetSats: number,
  priceSatPerEHPerDay: number,
  hashrateValue: number,
  hashrateUnit: HashrateUnit,
): number {
  const hashrateEH = convertHashrate(hashrateValue, hashrateUnit, 'EH');
  if (priceSatPerEHPerDay <= 0 || hashrateEH <= 0) return 0;
  const satPerSecond = (priceSatPerEHPerDay * hashrateEH) / SECONDS_PER_DAY;
  return budgetSats / satPerSecond;
}

export function satsToBtc(sats: number): number {
  return sats / SAT_PER_BTC;
}

export function btcToSats(btc: number): number {
  return Math.round(btc * SAT_PER_BTC);
}

/**
 * Human-readable hashrate string: picks the largest unit that keeps the
 * mantissa >= 1 (e.g. 2.5e15 H/s -> "2.50 PH/s").
 */
export function formatHashrate(value: number, fromUnit: HashrateUnit = 'H'): string {
  const valueInH = convertHashrate(value, fromUnit, 'H');
  if (valueInH === 0) return '0 H/s';
  const units: HashrateUnit[] = ['EH', 'PH', 'TH', 'GH', 'MH', 'kH', 'H'];
  for (const unit of units) {
    const scaled = convertHashrate(valueInH, 'H', unit);
    if (Math.abs(scaled) >= 1) {
      return `${scaled.toFixed(2)} ${unit}/s`;
    }
  }
  return `${valueInH.toFixed(2)} H/s`;
}
