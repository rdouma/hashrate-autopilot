// Localizes the chart-range label CHART_RANGE_SPECS hands us. Source
// labels are no-space single-letter abbreviations (`3h`, `1w`, `1y`,
// `All`) - everywhere else on the dashboard the unit is glued to the
// number (`5,8 dagen`, `2,93 PH/s`), so the range buttons follow the
// same convention. Translation rules per locale below.
//
// Dutch:
//   h (hour)  -> u (uur)
//   w (week)  -> w (week, same letter)
//   m (month) -> m (maand, same letter)
//   y (year)  -> j (jaar)
//   All       -> Alles
//
// Spanish (neutral LatAm):
//   h (hour)  -> h (hora, same letter)
//   w (week)  -> s (semana)
//   m (month) -> m (mes, same letter)
//   y (year)  -> a (año)
//   All       -> Todo

import type { ChartRange } from '@braiins-hashrate/shared';
import { CHART_RANGE_SPECS } from '@braiins-hashrate/shared';

const NL_UNIT_MAP: Record<string, string> = {
  h: 'u',
  w: 'w',
  m: 'm',
  y: 'j',
};

const ES_UNIT_MAP: Record<string, string> = {
  h: 'h',
  w: 's',
  m: 'm',
  y: 'a',
};

function swapUnit(label: string, map: Record<string, string>): string {
  // Match a leading number followed by a single-letter unit, e.g. `3h`,
  // `12h`, `24h`, `1w`. Replace the trailing letter with its localized
  // counterpart. Anything that doesn't match the pattern (e.g. `All`)
  // is returned unchanged here and handled by the caller's special-case.
  const m = label.match(/^(\d+)([a-z])$/i);
  if (!m) return label;
  const [, num, unit] = m;
  const mapped = map[unit!.toLowerCase()] ?? unit!;
  return `${num}${mapped}`;
}

export function localizedRangeLabel(range: ChartRange, locale: string): string {
  const base = CHART_RANGE_SPECS[range].label;
  if (locale === 'nl') {
    if (base === 'All') return 'Alles';
    return swapUnit(base, NL_UNIT_MAP);
  }
  if (locale === 'es') {
    if (base === 'All') return 'Todo';
    return swapUnit(base, ES_UNIT_MAP);
  }
  return base;
}
