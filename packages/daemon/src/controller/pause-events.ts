/**
 * #287 follow-up: pure decision for Braiins-side BID_PAUSED /
 * BID_RESUMED audit events, extracted from TickRunner so it can be
 * unit-tested without the full observe→execute pipeline.
 *
 * The detector compares the primary bid's paused-state between two
 * consecutive ticks. The tricky case is a restart: if the bid was
 * already paused when the daemon came back up, that tick re-baselines
 * (prev === null) and never emits the pause. Its eventual resume would
 * then be an *orphan* - a BID_RESUMED with no recorded pause-start -
 * which the dashboard rendered as "paused since the beginning of
 * time", shading the whole chart even while hashrate was delivering
 * (operator bug, 2026-06-13). So a resume only emits when the matching
 * pause was logged in this process; pauses always emit.
 */

export interface PauseObservation {
  readonly orderId: string;
  readonly paused: boolean;
}

export interface PauseEventDecision {
  /** Event to write, or null to emit nothing this tick. */
  readonly emitKind: 'BID_PAUSED' | 'BID_RESUMED' | null;
  /** Carry forward: order id of an emitted-but-not-yet-resumed pause. */
  readonly nextPauseEmittedOrderId: string | null;
}

export function decidePauseEvent(
  prev: PauseObservation | null,
  cur: PauseObservation | null,
  pauseEmittedOrderId: string | null,
): PauseEventDecision {
  // No observable transition: same bid both ticks with a flipped
  // paused flag is the only thing that fires. A null on either side
  // (no primary bid, or first tick after restart) re-baselines
  // silently; an order-id change is a different bid, not a transition.
  if (
    prev === null ||
    cur === null ||
    prev.orderId !== cur.orderId ||
    prev.paused === cur.paused
  ) {
    return { emitKind: null, nextPauseEmittedOrderId: pauseEmittedOrderId };
  }
  if (cur.paused) {
    // active -> paused: always emit, and remember we logged it.
    return { emitKind: 'BID_PAUSED', nextPauseEmittedOrderId: cur.orderId };
  }
  // paused -> active: emit only if we logged the matching pause.
  const emit = pauseEmittedOrderId === cur.orderId;
  return { emitKind: emit ? 'BID_RESUMED' : null, nextPauseEmittedOrderId: null };
}
