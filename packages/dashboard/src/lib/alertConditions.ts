/**
 * #316: shared display helpers for alerted condition classes, used by
 * the History rows, the detail drawer, and the chart onset/recovery
 * markers so they all read the same label and color.
 */
import { t } from '@lingui/core/macro';

import { conditionSpanClass } from '@hashrate-autopilot/shared';
import { getChartColor, type ChartColorKey } from './chartColors';

/** Short, translated label for a condition's *onset* (entering the state). */
export function conditionLabel(openClass: string): string {
  switch (openClass) {
    case 'hashrate_below_floor': return t`below floor`;
    case 'zero_hashrate': return t`zero hashrate`;
    case 'datum_unreachable': return t`DATUM unreachable`;
    case 'api_unreachable': return t`marketplace API down`;
    case 'wallet_runway': return t`low wallet runway`;
    case 'solo_overheating': return t`Bitaxe overheating`;
    case 'marketplace_empty': return t`marketplace empty`;
    case 'sustained_paused': return t`bid paused (sustained)`;
    case 'bid_churn_hold': return t`bidding held (bid churn)`;
    case 'target_blacklisted': return t`pool blacklisted`;
    case 'mutation_failed': return t`bid actions failing`;
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
    case 'marketplace_empty': return t`marketplace filled`;
    case 'sustained_paused': return t`bid resumed`;
    case 'bid_churn_hold': return t`bidding resumed`;
    case 'target_blacklisted': return t`blacklist expired`;
    case 'mutation_failed': return t`bid actions working again`;
    default: return t`recovered`;
  }
}

/**
 * Band color for a condition class, resolved against the operator's chart
 * color overrides (#334). Pass the overrides bag from `useChartColorOverrides()`;
 * defaults to `{}` (built-in colors) for non-React callers.
 */
export function conditionColor(
  openClass: string,
  overrides: Partial<Record<ChartColorKey, string>> = {},
): string {
  const c = conditionSpanClass(openClass);
  return c ? getChartColor(c.colorSlot as ChartColorKey, overrides) : '#fb923c';
}
