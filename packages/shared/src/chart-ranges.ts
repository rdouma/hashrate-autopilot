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
export type BidEventKind = 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID' | 'MODE_CHANGE' | 'BID_PAUSED' | 'BID_RESUMED';

// Deliberately excludes MODE_CHANGE / BID_PAUSED / BID_RESUMED (#287):
// those are History rows, never chart markers, so the per-range marker filters and the
// "all kinds" chart helpers don't carry them.
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
 * Pick a bucket size proportional to the data span. The bucket grows
 * smoothly with the span instead of jumping in discrete steps - target
 * is ~1440 buckets across the chart (≈ one per pixel of typical chart
 * width). Returns the 0-sentinel below the tick interval so
 * listAggregated takes its raw fast path.
 *
 * Examples:
 *
 *     24h    →  60s computed  →  0 (raw, ~1440 ticks)
 *     30h    →  75s
 *     48h    →  2 min
 *     7d     →  7 min
 *     30d    →  30 min
 *     365d   →  ~6h
 *
 * History: this used to be a 4-tier ladder (raw / 30 min / 1 h / 1 d).
 * Crossing 24h jumped the bucket size 30× from 60s to 1800s, which the
 * operator hit while scrolling 24h→26h - the chart's appearance
 * changed dramatically for an 8% change in visible span. Proportional
 * scaling matches the intuition that a small zoom should produce a
 * small visual change. The metrics route applies this to every
 * viewport request and to bounded presets (using the lesser of the
 * preset window and the actual data span) so charts don't
 * over-collapse when history is shorter than the preset.
 */
export function pickBucketForSpan(spanMs: number): number {
  if (spanMs <= 0) return 0;
  const TICK_INTERVAL_MS = 60_000;
  const TARGET_BUCKETS = 1440;
  const bucketMs = Math.ceil(spanMs / TARGET_BUCKETS);
  // Below the tick interval, bucketing adds nothing and the SQL
  // aggregation path would just produce one-row buckets equivalent
  // to raw rows but more expensive. 0 signals raw mode to
  // listAggregated.
  if (bucketMs <= TICK_INTERVAL_MS) return 0;
  return bucketMs;
}

// ---------------------------------------------------------------------------
// Viewport types for drag-to-pan / wheel-to-zoom (#169)
// ---------------------------------------------------------------------------

export interface ChartViewport {
  since_ms: number;
  until_ms: number;
}

export function presetToViewport(range: ChartRange): ChartViewport {
  const spec = CHART_RANGE_SPECS[range];
  const now = Date.now();
  if (spec.windowMs === null) {
    return { since_ms: 0, until_ms: now };
  }
  return { since_ms: now - spec.windowMs, until_ms: now };
}

export function viewportToNearestPreset(vp: ChartViewport): ChartRange | null {
  const duration = vp.until_ms - vp.since_ms;
  const now = Date.now();
  const isLive = Math.abs(vp.until_ms - now) < 120_000;
  if (!isLive) return null;
  for (const key of CHART_RANGES) {
    const spec = CHART_RANGE_SPECS[key];
    if (spec.windowMs !== null && Math.abs(duration - spec.windowMs) < 60_000) {
      return key;
    }
  }
  // "All" has no fixed windowMs. Match if since_ms is at epoch OR if the
  // duration exceeds the widest fixed preset (1y). The loop above already
  // catches viewports that are close to 1y, so anything wider is All
  // territory - this handles both the legacy epoch-based All viewport and
  // the new data-extent-based one.
  const YEAR = 365 * DAY;
  if (vp.since_ms <= 0 || duration > YEAR * 1.1) return 'all';
  return null;
}

export function showEventKindsForSpan(spanMs: number): readonly BidEventKind[] {
  if (spanMs <= 24 * HOUR) return ALL_BID_EVENT_KINDS;
  if (spanMs <= 7 * DAY) return RARE_KINDS;
  return [];
}
