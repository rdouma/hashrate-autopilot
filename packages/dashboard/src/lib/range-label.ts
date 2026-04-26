// Localizes the chart-range label CHART_RANGE_SPECS hands us. Source
// labels are no-space single-letter abbreviations (`3h`, `1w`, `1y`,
// `All`) - everywhere else on the dashboard the unit is glued to the
// number (`5,8 dagen`, `2,93 PH/s`), so the range buttons follow the
// same convention. Dutch swaps `h` (hour) for `u` (uur). Spanish
// keeps the same single-letter abbreviations as English. Both locales
// translate the `All` button.

import type { ChartRange } from '@braiins-hashrate/shared';
import { CHART_RANGE_SPECS } from '@braiins-hashrate/shared';

export function localizedRangeLabel(range: ChartRange, locale: string): string {
  const base = CHART_RANGE_SPECS[range].label;
  if (locale === 'nl') {
    if (base === 'All') return 'Alle';
    return base.replace(/h$/, 'u');
  }
  if (locale === 'es') {
    if (base === 'All') return 'Todo';
    return base;
  }
  return base;
}
