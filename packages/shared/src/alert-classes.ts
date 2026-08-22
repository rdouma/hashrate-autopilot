/**
 * Alert event-class taxonomy (#316).
 *
 * Alerts carry a free-form `event_class` string, and the important
 * conditions arrive as open/recovery pairs by convention:
 * `<openClass>` (the IMPORTANT alert raised when a condition starts)
 * and `<openClass>_recovery` (the INFO alert when it clears, whose
 * `paired_alert_id` points back at the opener). Each pair is therefore
 * a *span* with a start (opener.created_at) and an end
 * (recovery.created_at, or open-ended while the condition persists).
 *
 * This module is the single source of truth for which classes are
 * spans, what they're called, which chart(s) their background band
 * belongs on, and which chart-color slot tints the band. Shared so the
 * daemon (span derivation) and the dashboard (band rendering, History
 * rows, color pickers) agree on the set.
 *
 * Deliberately excluded, because the charts already draw an equivalent
 * band from another source and we must not double-band:
 *   - `marketplace_empty`  -> #167 fillable-null bands on the price chart
 *   - `sustained_paused`   -> #287 BID_PAUSED -> BID_RESUMED bands
 */

export type AlertChartTarget = 'hashrate' | 'price';

export interface ConditionSpanClass {
  /** The IMPORTANT opener event_class. */
  readonly openClass: string;
  /** The INFO recovery event_class (convention: `${openClass}_recovery`). */
  readonly recoveryClass: string;
  /** Which chart(s) the background band renders on. */
  readonly charts: readonly AlertChartTarget[];
  /**
   * chart_color_overrides slot that tints the band + onset/recovery
   * markers. #316/#318: every condition span shares the single
   * `events.alert_condition` slot — the span label carries the meaning,
   * so one color keeps the Config surface small.
   */
  readonly colorSlot: string;
  /** Stable English label; the dashboard translates by `openClass`. */
  readonly label: string;
}

/**
 * The condition spans surfaced on the timeline, in display order.
 * Hashrate-shaped conditions live on the Hashrate chart; connectivity
 * and economic ones span both so they're visible wherever you're
 * looking; the Bitaxe thermal one is hashrate-side. Holds that stop the
 * autopilot from trading at all (#374) span both charts too.
 */
export const CONDITION_SPAN_CLASSES: readonly ConditionSpanClass[] = [
  {
    openClass: 'hashrate_below_floor',
    recoveryClass: 'hashrate_below_floor_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_condition',
    label: 'Below floor',
  },
  {
    openClass: 'zero_hashrate',
    recoveryClass: 'zero_hashrate_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_condition',
    label: 'Zero hashrate',
  },
  {
    openClass: 'datum_unreachable',
    recoveryClass: 'datum_unreachable_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_condition',
    label: 'DATUM unreachable',
  },
  {
    openClass: 'api_unreachable',
    recoveryClass: 'api_unreachable_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_condition',
    label: 'Marketplace API unreachable',
  },
  {
    openClass: 'wallet_runway',
    recoveryClass: 'wallet_runway_recovery',
    charts: ['price'],
    colorSlot: 'events.alert_condition',
    label: 'Low wallet runway',
  },
  {
    openClass: 'solo_overheating',
    recoveryClass: 'solo_overheating_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_condition',
    label: 'Bitaxe overheating',
  },
  // #374: hold / failure conditions. A create hold suppresses *all*
  // trading, so it bands both charts; repeated mutation rejections show
  // up as a stalled bid price, so that one bands the price chart only.
  {
    openClass: 'bid_churn_hold',
    recoveryClass: 'bid_churn_hold_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_condition',
    label: 'Bidding held (bid churn)',
  },
  {
    openClass: 'target_blacklisted',
    recoveryClass: 'target_blacklisted_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_condition',
    label: 'Pool blacklisted by marketplace',
  },
  {
    openClass: 'mutation_failed',
    recoveryClass: 'mutation_failed_recovery',
    charts: ['price'],
    colorSlot: 'events.alert_condition',
    label: 'Bid actions failing',
  },
  // #318: log-only span classes (charts: [] -> they appear as History
  // span rows but draw no chart band, since #167 fillable-null and #287
  // bid-pause bands already cover them on the charts). They share the
  // same single alert-condition color as every other span.
  {
    openClass: 'marketplace_empty',
    recoveryClass: 'marketplace_empty_recovery',
    charts: [],
    colorSlot: 'events.alert_condition',
    label: 'Marketplace empty',
  },
  {
    openClass: 'sustained_paused',
    recoveryClass: 'sustained_paused_recovery',
    charts: [],
    colorSlot: 'events.alert_condition',
    label: 'Bid paused (sustained)',
  },
];

/** All opener classes that define a span, for quick membership tests. */
export const CONDITION_OPEN_CLASSES: readonly string[] = CONDITION_SPAN_CLASSES.map(
  (c) => c.openClass,
);

/** All recovery classes, for quick membership tests. */
export const CONDITION_RECOVERY_CLASSES: readonly string[] = CONDITION_SPAN_CLASSES.map(
  (c) => c.recoveryClass,
);

const BY_OPEN_CLASS = new Map<string, ConditionSpanClass>(
  CONDITION_SPAN_CLASSES.map((c) => [c.openClass, c]),
);

/** Lookup a span class by its opener event_class, or undefined. */
export function conditionSpanClass(openClass: string | null | undefined): ConditionSpanClass | undefined {
  if (!openClass) return undefined;
  return BY_OPEN_CLASS.get(openClass);
}

/**
 * #322: how a condition interval renders on a given chart.
 *
 * - 'band': the class targets this chart - full hatch band + onset /
 *   recovery markers (+ focus beacon when focused).
 * - 'beacon-only': chart-less classes (marketplace_empty /
 *   sustained_paused draw no band of their own - the #167 fillable-null
 *   and #287 bid-pause hatches cover them) still need a landing spot
 *   for the Timeline's "View on chart" jump, so the FOCUSED span gets a
 *   sonar beacon + dashed guide on the price chart, nothing else.
 * - 'none': not rendered here.
 */
export function conditionBandRenderMode(
  openClass: string | null | undefined,
  target: 'price' | 'hashrate',
  focused: boolean,
): 'band' | 'beacon-only' | 'none' {
  const cls = conditionSpanClass(openClass);
  if (!cls) return 'none';
  if (cls.charts.includes(target)) return 'band';
  if (cls.charts.length === 0 && target === 'price' && focused) return 'beacon-only';
  return 'none';
}

/** True if this event_class is a span opener we surface on the timeline. */
export function isConditionOpenClass(eventClass: string | null | undefined): boolean {
  return !!eventClass && BY_OPEN_CLASS.has(eventClass);
}
