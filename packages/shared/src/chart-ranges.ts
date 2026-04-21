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
   * Whether the events overlay is rendered at this range. Past ~a week
   * the individual markers lose signal.
   */
  readonly showEvents: boolean;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CHART_RANGE_SPECS: Record<ChartRange, ChartRangeSpec> = {
  '3h': {
    range: '3h',
    label: '3 h',
    windowMs: 3 * HOUR,
    bucketMs: 0,
    showEvents: true,
  },
  '6h': {
    range: '6h',
    label: '6 h',
    windowMs: 6 * HOUR,
    bucketMs: 0,
    showEvents: true,
  },
  '12h': {
    range: '12h',
    label: '12 h',
    windowMs: 12 * HOUR,
    bucketMs: 0,
    showEvents: true,
  },
  '24h': {
    range: '24h',
    label: '24 h',
    windowMs: 24 * HOUR,
    bucketMs: 0,
    showEvents: true,
  },
  '1w': {
    range: '1w',
    label: '1 w',
    windowMs: 7 * DAY,
    bucketMs: 5 * MINUTE,
    showEvents: true,
  },
  '1m': {
    range: '1m',
    label: '1 m',
    windowMs: 30 * DAY,
    bucketMs: HOUR,
    showEvents: false,
  },
  '1y': {
    range: '1y',
    label: '1 y',
    windowMs: 365 * DAY,
    bucketMs: DAY,
    showEvents: false,
  },
  all: {
    range: 'all',
    label: 'All',
    windowMs: null,
    bucketMs: DAY,
    showEvents: false,
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
  if (spanMs > 7 * DAY) return 5 * MINUTE;
  return 0; // raw
}
