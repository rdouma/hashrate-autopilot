/**
 * #316: shared display helpers for alerted condition classes, used by
 * the History rows, the detail drawer, and the chart onset/recovery
 * markers so they all read the same label and color.
 */
import { t } from '@lingui/core/macro';

import { conditionSpanClass } from '@hashrate-autopilot/shared';
import { CHART_COLOR_DEFAULTS, type ChartColorKey } from './chartColors';

/** Short, translated label for a condition's *onset* (entering the state). */
export function conditionLabel(openClass: string): string {
  switch (openClass) {
    case 'hashrate_below_floor': return t`below floor`;
    case 'zero_hashrate': return t`zero hashrate`;
    case 'datum_unreachable': return t`DATUM unreachable`;
    case 'api_unreachable': return t`marketplace API down`;
    case 'wallet_runway': return t`low wallet runway`;
    case 'solo_overheating': return t`Bitaxe overheating`;
    default: return openClass;
  }
}

/** Translated label for a condition's *recovery* (returning to normal). */
export function conditionRecoveryLabel(openClass: string): string {
  switch (openClass) {
    case 'hashrate_below_floor': return t`above floor again`;
    case 'zero_hashrate': return t`hashrate restored`;
    case 'datum_unreachable': return t`DATUM reachable again`;
    case 'api_unreachable': return t`marketplace API back`;
    case 'wallet_runway': return t`wallet runway restored`;
    case 'solo_overheating': return t`Bitaxe cooled down`;
    default: return t`recovered`;
  }
}

/** The configured (default) band color for a condition class. */
export function conditionColor(openClass: string): string {
  const c = conditionSpanClass(openClass);
  return c ? CHART_COLOR_DEFAULTS[c.colorSlot as ChartColorKey] : '#fb923c';
}
