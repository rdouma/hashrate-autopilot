/**
 * Pool-luck step marker dot positioning.
 *
 * Extracted from HashrateChart.tsx's `visibleLuckStepMarkers` so the
 * directional invariant the operator's flagged repeatedly can be
 * locked in by tests.
 *
 * v2 (2026-06-11, operator screenshot at build 653): v1 picked the
 * directional EXTREMUM over the window (max for FOUND, min for AGED
 * OUT). That fails for AGED OUT because the 24h/7d/30d luck line
 * DECAYS continuously between events - the window minimum is almost
 * always the far end of the decay, not the step, so the dot drifted
 * right and down, visually disconnected from the step it belonged
 * to. (FOUND looked fine only because a step UP against decay really
 * is the local maximum.)
 *
 * v2 finds the STEP itself: the largest single-tick delta in the
 * event's direction. The luckBefore→window[0] transition counts as a
 * candidate (the step can land exactly at afterIdx). The dot goes on
 * the step's post-step tick - i.e. exactly where the line visibly
 * jumps:
 *
 *   FOUND  ('in' only)  ⇒ tick after the largest upward jump
 *   AGED   ('out' only) ⇒ tick after the largest downward drop
 *   mixed              ⇒ first value differing from luckBefore
 *
 * Distinguishing a real step from decay/noise: the winning delta must
 * exceed NOISE_FACTOR × the median absolute tick-delta of the window.
 * When no delta qualifies (Ocean hasn't published the post-event
 * value yet), fall back to luckBefore at offset 0 - the honest "event
 * landed, effect not yet observed" placement.
 *
 * Returns the *offset within the window* of the chosen tick and the
 * luck value to place the dot at (always a value the line actually
 * passes through at that tick, so the dot sits ON the line). Null
 * when the window has no usable samples AND luckBefore is null.
 */
export type LuckEventKind = 'in' | 'out';

export interface PickLuckDotResult {
  /** Offset within the window (0-indexed). 0 means afterIdx itself. */
  readonly offset: number;
  /** Luck value to place the dot at. */
  readonly luck: number;
}

const NOISE_FACTOR = 1.5;

export function pickLuckStepDot(
  events: ReadonlyArray<{ kind: LuckEventKind }>,
  luckBefore: number | null,
  windowValues: ReadonlyArray<number | null>,
): PickLuckDotResult | null {
  const hasIn = events.some((e) => e.kind === 'in');
  const hasOut = events.some((e) => e.kind === 'out');

  // Collapse to the non-null samples, remembering original offsets.
  const samples: Array<{ offset: number; v: number }> = [];
  for (let i = 0; i < windowValues.length; i += 1) {
    const v = windowValues[i];
    if (v !== null && v !== undefined) samples.push({ offset: i, v });
  }

  if (samples.length === 0) {
    return luckBefore !== null ? { offset: 0, luck: luckBefore } : null;
  }

  // Mixed kinds in the same tick group - direction is ambiguous.
  // Legacy semantic: first value that differs from luckBefore; first
  // sample when luckBefore is null.
  if (hasIn === hasOut) {
    if (luckBefore === null) {
      const s = samples[0]!;
      return { offset: s.offset, luck: s.v };
    }
    for (const s of samples) {
      if (s.v !== luckBefore) return { offset: s.offset, luck: s.v };
    }
    return { offset: 0, luck: luckBefore };
  }

  // Build the delta chain: implicit luckBefore→samples[0] transition
  // first (the step often lands exactly at afterIdx), then each
  // consecutive sample pair. Each delta candidate carries the offset
  // of its POST-step sample, which is where the dot belongs.
  const deltas: Array<{ offset: number; v: number; d: number }> = [];
  if (luckBefore !== null) {
    deltas.push({
      offset: samples[0]!.offset,
      v: samples[0]!.v,
      d: samples[0]!.v - luckBefore,
    });
  }
  for (let i = 1; i < samples.length; i += 1) {
    deltas.push({
      offset: samples[i]!.offset,
      v: samples[i]!.v,
      d: samples[i]!.v - samples[i - 1]!.v,
    });
  }

  if (deltas.length === 0) {
    // Single sample, no luckBefore: nothing to compare against - the
    // sample itself is the only honest anchor.
    const s = samples[0]!;
    return { offset: s.offset, luck: s.v };
  }

  // Noise floor: median absolute delta of the window. The luck line
  // decays a little every tick; a real step is much larger than the
  // per-tick drift.
  // Lower median (floor((n-1)/2)): with very small windows the upper
  // middle can BE the step delta, which would set the threshold above
  // the step itself and reject it.
  const absDeltas = deltas.map((x) => Math.abs(x.d)).sort((a, b) => a - b);
  const median = absDeltas[Math.floor((absDeltas.length - 1) / 2)] ?? 0;
  const threshold = median * NOISE_FACTOR;

  // Largest delta in the event's direction (first occurrence wins
  // ties so the dot lands at the START of a multi-tick step).
  const directional = hasIn ? 1 : -1;
  let best: { offset: number; v: number; d: number } | null = null;
  for (const cand of deltas) {
    const magnitude = cand.d * directional;
    if (magnitude <= 0) continue;
    if (best === null || magnitude > best.d * directional) best = cand;
  }

  if (best !== null && Math.abs(best.d) > threshold) {
    return { offset: best.offset, luck: best.v };
  }

  // No step distinguishable from decay noise: Ocean hasn't published
  // the post-event value yet (or the event's effect was swallowed).
  // Anchor at luckBefore on afterIdx when we have it, else the first
  // sample - both sit on (or immediately adjacent to) the line.
  if (luckBefore !== null) {
    return { offset: 0, luck: luckBefore };
  }
  const s = samples[0]!;
  return { offset: s.offset, luck: s.v };
}
