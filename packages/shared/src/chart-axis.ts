/**
 * Time-axis tick utilities shared between the hashrate and price charts.
 *
 * Goal: generate a small set of "round" tick timestamps (e.g. 08:00,
 * 09:00, 10:00) aligned to the *local* clock so the operator never has
 * to read 08:38:55-style arbitrary cuts. Both charts call the same
 * generator + formatter so their X-axes line up tick-for-tick.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Pick a "nice" interval that yields roughly 4–8 labels across the
 * visible span. Candidates are the human-friendly clock divisions —
 * 5/10/15/30 min, 1/2/3/6/12 h, 1/2/7/14/30 days.
 */
export function pickTimeTickInterval(spanMs: number): number {
  if (spanMs <= 0) return HOUR;
  const target = spanMs / 6;
  const candidates = [
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
    30 * DAY,
  ];
  return candidates.find((c) => c >= target) ?? candidates[candidates.length - 1]!;
}

/**
 * Generate tick timestamps in [minMs, maxMs], aligned to round local-time
 * boundaries for `intervalMs`. Uses Date's local-time methods so DST
 * transitions don't drift labels off the hour.
 */
export function localAlignedTimeTicks(
  minMs: number,
  maxMs: number,
  intervalMs: number,
): number[] {
  if (maxMs <= minMs) return [];
  const ticks: number[] = [];

  if (intervalMs >= DAY) {
    const stepDays = Math.max(1, Math.round(intervalMs / DAY));
    const start = new Date(minMs);
    // Next local midnight at-or-after minMs.
    const t = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (t.getTime() < minMs) t.setDate(t.getDate() + 1);
    while (t.getTime() <= maxMs) {
      ticks.push(t.getTime());
      t.setDate(t.getDate() + stepDays);
    }
    return ticks;
  }

  if (intervalMs >= HOUR) {
    const stepHours = Math.max(1, Math.round(intervalMs / HOUR));
    const start = new Date(minMs);
    // Round up to the next aligned hour-of-day boundary.
    const t = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours(),
    );
    if (t.getTime() < minMs) t.setHours(t.getHours() + 1);
    // Snap to a multiple of stepHours within the day.
    while (t.getHours() % stepHours !== 0 && t.getTime() <= maxMs) {
      t.setHours(t.getHours() + 1);
    }
    while (t.getTime() <= maxMs) {
      ticks.push(t.getTime());
      t.setHours(t.getHours() + stepHours);
    }
    return ticks;
  }

  // Sub-hour: align to multiples of `stepMinutes`.
  const stepMinutes = Math.max(1, Math.round(intervalMs / MINUTE));
  const start = new Date(minMs);
  const t = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    start.getHours(),
    Math.ceil(start.getMinutes() / stepMinutes) * stepMinutes,
  );
  if (t.getTime() < minMs) t.setMinutes(t.getMinutes() + stepMinutes);
  while (t.getTime() <= maxMs) {
    ticks.push(t.getTime());
    t.setMinutes(t.getMinutes() + stepMinutes);
  }
  return ticks;
}

/**
 * Format a tick timestamp for display under the X-axis. Sub-day
 * intervals get `HH:mm`; day-and-up get `dd MMM` (no year — the chart
 * never spans more than ~12 months in our worst case).
 */
/**
 * Generate "nice" Y-axis ticks — round numbers that a human would
 * pick (0, 1, 2, 3 or 45,000, 45,500, 46,000, not 45,127, 45,893).
 *
 * Algorithm: find a step size from the 1-2-5 series that yields
 * roughly `targetCount` ticks, then snap min down and max up to
 * multiples of that step.
 */
export function niceYTicks(
  dataMin: number,
  dataMax: number,
  targetCount = 5,
): number[] {
  if (dataMax <= dataMin) return [dataMin];
  const rawStep = (dataMax - dataMin) / Math.max(1, targetCount - 1);
  const step = niceStep(rawStep);
  const lo = Math.floor(dataMin / step) * step;
  const hi = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  // +0.5*step guards against floating-point drift skipping the last tick
  for (let v = lo; v <= hi + step * 0.01; v += step) {
    ticks.push(Math.round(v * 1e10) / 1e10); // kill FP noise
  }
  return ticks;
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let nice: number;
  if (norm <= 1.5) nice = 1;
  else if (norm <= 3.5) nice = 2;
  else if (norm <= 7.5) nice = 5;
  else nice = 10;
  return nice * mag;
}

export function formatTimeTick(
  tickMs: number,
  intervalMs: number,
  locale?: string,
): string {
  const d = new Date(tickMs);
  const showDate = intervalMs >= DAY;
  const opts: Intl.DateTimeFormatOptions = showDate
    ? { day: '2-digit', month: 'short' }
    : { hour: '2-digit', minute: '2-digit', hour12: false };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
