import { describe, expect, it } from 'vitest';
import { decidePauseEvent } from './pause-events.js';

const A = (paused: boolean) => ({ orderId: 'order-A', paused });
const B = (paused: boolean) => ({ orderId: 'order-B', paused });

describe('decidePauseEvent', () => {
  it('emits BID_PAUSED on active -> paused and tracks the order', () => {
    const d = decidePauseEvent(A(false), A(true), null);
    expect(d.emitKind).toBe('BID_PAUSED');
    expect(d.nextPauseEmittedOrderId).toBe('order-A');
  });

  it('emits BID_RESUMED on paused -> active when the pause was logged', () => {
    const d = decidePauseEvent(A(true), A(false), 'order-A');
    expect(d.emitKind).toBe('BID_RESUMED');
    expect(d.nextPauseEmittedOrderId).toBeNull();
  });

  it('drops an orphan resume: paused -> active with no logged pause', () => {
    // The restart-during-pause case: baseline re-established as paused
    // (no BID_PAUSED emitted), so pauseEmittedOrderId is null. The
    // later resume must NOT emit - this is the band-paints-everything
    // bug at its source.
    const d = decidePauseEvent(A(true), A(false), null);
    expect(d.emitKind).toBeNull();
    expect(d.nextPauseEmittedOrderId).toBeNull();
  });

  it('full real cycle pauses then resumes exactly once', () => {
    const paused = decidePauseEvent(A(false), A(true), null);
    expect(paused.emitKind).toBe('BID_PAUSED');
    const resumed = decidePauseEvent(A(true), A(false), paused.nextPauseEmittedOrderId);
    expect(resumed.emitKind).toBe('BID_RESUMED');
  });

  it('does not emit when there is no transition', () => {
    expect(decidePauseEvent(A(false), A(false), null).emitKind).toBeNull();
    expect(decidePauseEvent(A(true), A(true), 'order-A').emitKind).toBeNull();
  });

  it('re-baselines silently on the first tick (prev null) and after losing the bid (cur null)', () => {
    expect(decidePauseEvent(null, A(true), null).emitKind).toBeNull();
    expect(decidePauseEvent(A(true), null, 'order-A').emitKind).toBeNull();
  });

  it('preserves the tracked pause across a no-transition tick', () => {
    expect(decidePauseEvent(A(true), A(true), 'order-A').nextPauseEmittedOrderId).toBe('order-A');
    expect(decidePauseEvent(null, A(true), 'order-A').nextPauseEmittedOrderId).toBe('order-A');
  });

  it('treats a different order id as no transition, not a resume', () => {
    // Bid A was paused (tracked); a different bid B appears active.
    // That is not A resuming - emit nothing, keep tracking A.
    const d = decidePauseEvent(A(true), B(false), 'order-A');
    expect(d.emitKind).toBeNull();
    expect(d.nextPauseEmittedOrderId).toBe('order-A');
  });

  it('does not emit a resume for a different order than the logged pause', () => {
    // B resumes but only A's pause was logged -> orphan, dropped.
    const d = decidePauseEvent(B(true), B(false), 'order-A');
    expect(d.emitKind).toBeNull();
  });
});
