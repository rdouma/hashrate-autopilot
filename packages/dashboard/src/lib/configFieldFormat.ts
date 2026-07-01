/**
 * #318 follow-up: turn a raw config-change record (field key + old/new
 * stored values) into something a human reads comfortably, honoring the
 * operator's hashrate denomination. e.g.
 *   max_overpay_vs_hashprice_sat_per_eh_day: 2000000 -> 1500000
 * becomes, at PH:
 *   "Max overpay vs hashprice: 2,000 -> 1,500 sat/PH/day".
 *
 * Pure - denomination and the number formatter are passed in - so it's
 * unit-testable and reusable by the timeline row summary and the detail
 * drawer alike (they inject the operator's locale-aware formatNumber).
 */

export type HashrateUnit = 'TH' | 'PH' | 'EH';

/** Injected locale-aware integer formatter; defaults to en-US grouping. */
export type NumFmt = (n: number) => string;
const DEFAULT_FMT: NumFmt = (n) => new Intl.NumberFormat('en-US').format(n);

/** sat/EH/day -> sat/<unit>/day divisor. */
function ehToUnitDivisor(unit: HashrateUnit): number {
  return unit === 'TH' ? 1_000_000 : unit === 'PH' ? 1_000 : 1;
}

// A few labels the generic prettifier can't guess well; everything else
// is derived from the key.
const LABEL_OVERRIDES: Record<string, string> = {
  max_overpay_vs_hashprice_sat_per_eh_day: 'Max overpay vs hashprice',
  overpay_sat_per_eh_day: 'Overpay',
  max_bid_sat_per_eh_day: 'Max bid',
  minimum_floor_hashrate_ph: 'Minimum floor',
  target_hashrate_ph: 'Target hashrate',
  bid_budget_sat: 'Bid budget',
  bid_edit_deadband_pct: 'Edit-price deadband',
  run_mode: 'Run mode',
};

const UNIT_SUFFIX_RE =
  /_(sat_per_eh_day|sat_per_ph_day|sat|ph|pct|minutes|hours|seconds|ms)$/;

/** Human label for a config field key. */
export function configFieldLabel(field: string): string {
  if (LABEL_OVERRIDES[field]) return LABEL_OVERRIDES[field]!;
  const stripped = field.replace(UNIT_SUFFIX_RE, '').replace(/_/g, ' ').trim();
  if (!stripped) return field;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** Format one stored value + its unit suffix for a field. */
export function formatConfigValue(
  field: string,
  raw: string | null,
  unit: HashrateUnit,
  fmtNum: NumFmt = DEFAULT_FMT,
): { value: string; suffix: string } {
  if (raw === null || raw === '') return { value: '—', suffix: '' };
  if (raw === 'true') return { value: 'on', suffix: '' };
  if (raw === 'false') return { value: 'off', suffix: '' };
  const num = Number(raw);
  const isNum = raw.trim() !== '' && Number.isFinite(num);

  if (field.endsWith('_sat_per_eh_day') && isNum) {
    return {
      value: fmtNum(Math.round(num / ehToUnitDivisor(unit))),
      suffix: `sat/${unit}/day`,
    };
  }
  if (field.endsWith('_sat_per_ph_day') && isNum) {
    // stored per-PH; scale to the selected unit (PH->TH x1/1000, PH->EH x1000).
    const factor = unit === 'TH' ? 1 / 1000 : unit === 'EH' ? 1000 : 1;
    return { value: fmtNum(Math.round(num * factor)), suffix: `sat/${unit}/day` };
  }
  if (field.endsWith('_sat') && isNum) return { value: fmtNum(num), suffix: 'sat' };
  if (field.endsWith('_ph') && isNum) return { value: String(num), suffix: 'PH/s' };
  if (field.endsWith('_pct') && isNum) return { value: String(num), suffix: '%' };
  if (field.endsWith('_minutes') && isNum) return { value: String(num), suffix: 'min' };
  // enum / url / address / anything else: show as stored.
  return { value: raw, suffix: '' };
}

/**
 * Full "label: old -> new [unit]" string for a config change. Uses the
 * Unicode arrow for display.
 */
export function formatConfigChange(
  field: string,
  oldValue: string | null,
  newValue: string | null,
  unit: HashrateUnit,
  fmtNum: NumFmt = DEFAULT_FMT,
): { label: string; change: string } {
  const label = configFieldLabel(field);
  const o = formatConfigValue(field, oldValue, unit, fmtNum);
  const n = formatConfigValue(field, newValue, unit, fmtNum);
  const suffix = n.suffix || o.suffix;
  return { label, change: `${o.value} → ${n.value}${suffix ? ` ${suffix}` : ''}` };
}
