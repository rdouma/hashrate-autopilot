/**
 * Time-range presets for the hashrate chart.
 *
 * Backend uses these to pick the aggregation granularity; frontend uses
 * them to populate the range picker and persist the user's choice. Single
 * source of truth so the two sides can never disagree on what "1 w" means.
 *
 * `bucketMs === 0` is the "no aggregation, raw rows" case.
 */

export type ChartRange = '3h' | '6h' | '12h' | '24h' | '1w' | '1m' | '1y' | 'all';

export const CHART_RANGES: readonly ChartRange[] = [
  '3h',
  '6h',
  '12h',
  '24h',
  '1w',
  '1m',
  '1y',
  'all',
] as const;

export const DEFAULT_CHART_RANGE: ChartRange = '24h';

/**
 * The four mutation kinds emitted by the controller and mirrored on
 * the Price chart. Source of truth for the per-range filter below
 * and for any caller that needs to reason about event types without
 * importing the dashboard's API view types.
 */
export type BidEventKind = 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';

export const ALL_BID_EVENT_KINDS: readonly BidEventKind[] = [
  'CREATE_BID',
  'EDIT_PRICE',
  'EDIT_SPEED',
  'CANCEL_BID',
];

export interface ChartRangeSpec {
  readonly range: ChartRange;
  readonly label: string;
  /**
   * Size of the visible window in ms. `null` means "unbounded" (load every
   * row; only applies to `all`).
   */
  readonly windowMs: number | null;
  /**
   * Server-side bucket size in ms. `0` means "raw rows, no aggregation".
   */
  readonly bucketMs: number;
  /**
   * Which event kinds are rendered as markers on the Price chart at
   * this range. Empty array = no markers. EDIT_PRICE is the noisy one
   * - it fires on most ticks during normal operation - so it's
   * dropped from 1w on, leaving the rare-and-interesting
   * CREATE_BID / EDIT_SPEED / CANCEL_BID still visible (#75). At 1m+
   * even the rare ones are too small to read on the X-axis, so the
   * overlay is empty entirely.
   */
  readonly showEventKinds: readonly BidEventKind[];
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The "rare" kinds shown alongside EDIT_PRICE at short ranges and on
// their own at 1w, where EDIT_PRICE would otherwise drown the chart.
const RARE_KINDS: readonly BidEventKind[] = ['CREATE_BID', 'EDIT_SPEED', 'CANCEL_BID'];

export const CHART_RANGE_SPECS: Record<ChartRange, ChartRangeSpec> = {
  '3h': {
    range: '3h',
    label: '3h',
    windowMs: 3 * HOUR,
    bucketMs: 0,
    showEventKinds: ALL_BID_EVENT_KINDS,
  },
  '6h': {
    range: '6h',
    label: '6h',
    windowMs: 6 * HOUR,
    bucketMs: 0,
    showEventKinds: ALL_BID_EVENT_KINDS,
  },
  '12h': {
    range: '12h',
    label: '12h',
    windowMs: 12 * HOUR,
    bucketMs: 0,
    showEventKinds: ALL_BID_EVENT_KINDS,
  },
  '24h': {
    range: '24h',
    label: '24h',
    windowMs: 24 * HOUR,
    bucketMs: 0,
    showEventKinds: ALL_BID_EVENT_KINDS,
  },
  '1w': {
    range: '1w',
    label: '1w',
    windowMs: 7 * DAY,
    // 30-min buckets: 7d / 30min = 336 points across ~784px usable chart
    // width (~0.43 buckets per pixel). 5-min buckets gave 2,016 points
    // (2.6 buckets per pixel), which crushed the line series into a
    // forest of vertical sticks once the EDIT_PRICE markers that had
    // been masking the issue were removed at this range (#76).
    bucketMs: 30 * MINUTE,
    showEventKinds: RARE_KINDS,
  },
  '1m': {
    range: '1m',
    label: '1m',
    windowMs: 30 * DAY,
    bucketMs: HOUR,
    showEventKinds: [],
  },
  '1y': {
    range: '1y',
    label: '1y',
    windowMs: 365 * DAY,
    bucketMs: DAY,
    showEventKinds: [],
  },
  all: {
    range: 'all',
    label: 'All',
    windowMs: null,
    bucketMs: DAY,
    showEventKinds: [],
  },
};

export function parseChartRange(input: unknown): ChartRange | null {
  return typeof input === 'string' && (CHART_RANGES as readonly string[]).includes(input)
    ? (input as ChartRange)
    : null;
}

/**
 * Pick a reasonable bucket size for an arbitrary data span — used by the
 * `all` preset so it adapts to however much history actually exists
 * instead of always bucketing at 1 day (which collapses a day of data
 * into a single point).
 */
export function pickBucketForSpan(spanMs: number): number {
  if (spanMs > 365 * DAY) return DAY;
  if (spanMs > 30 * DAY) return HOUR;
  if (spanMs > 7 * DAY) return 30 * MINUTE;
  return 0; // raw
}
