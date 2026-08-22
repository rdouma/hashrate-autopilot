import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { AlertsRepo } from './alerts.js';

/**
 * #316: conditionSpansSince derives timeline spans from open/recovery
 * alert pairs. These tests pin the pairing, the orphan-bounding (implicit
 * close at the next same-class opener, recent-vs-stale orphans), and the
 * window-overlap filter. A fixed `nowMs` is passed for determinism.
 */
// #376: widened from 6h - a latest-of-class unrecovered opener is a live
// condition (24h blacklist holds are legitimate); the bound only catches
// pathological orphans whose recovery can never fire.
const ORPHAN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

describe('AlertsRepo.conditionSpansSince (#316)', () => {
  let handle: DatabaseHandle;
  let repo: AlertsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new AlertsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  async function insertOpener(eventClass: string, createdAt: number): Promise<number> {
    return repo.insert({
      created_at: createdAt,
      severity: 'IMPORTANT',
      title: 'open',
      body: 'b',
      status: 'BUFFERED',
      event_class: eventClass,
      delivery_status: 'sent',
      delivery_attempts: 1,
      next_retry_at_ms: null,
      paired_alert_id: null,
    });
  }

  async function insertRecovery(
    eventClass: string,
    createdAt: number,
    pairedId: number,
  ): Promise<number> {
    return repo.insert({
      created_at: createdAt,
      severity: 'INFO',
      title: 'recovered',
      body: 'back above floor - was below for 17m',
      status: 'BUFFERED',
      event_class: eventClass,
      delivery_status: 'sent',
      delivery_attempts: 1,
      next_retry_at_ms: null,
      paired_alert_id: pairedId,
    });
  }

  it('returns [] when there are no condition alerts', async () => {
    expect(await repo.conditionSpansSince(0, 10_000, 10_000)).toEqual([]);
  });

  it('pairs an opener with its recovery into a closed span (any length)', async () => {
    const openId = await insertOpener('hashrate_below_floor', 1_000);
    // Recovery far past ORPHAN_MAX_MS: recovered spans are trusted as-is.
    await insertRecovery('hashrate_below_floor_recovery', 1_000 + 10 * 60 * 60 * 1000, openId);

    const spans = await repo.conditionSpansSince(0, Number.MAX_SAFE_INTEGER, 2e12);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      open_id: openId,
      event_class: 'hashrate_below_floor',
      start_ms: 1_000,
      end_ms: 1_000 + 10 * 60 * 60 * 1000,
      // #322: the paired recovery's body rides along so the Timeline
      // can render the recovery as its own row.
      recovery_body: 'back above floor - was below for 17m',
    });
  });

  it('#341: span start_ms is the condition-onset when the opener recorded it', async () => {
    // Opener FIRED at t=16_000 (after a threshold delay) but the condition
    // went bad at t=1_000. The span must start at 1_000 so Started/Duration
    // match the recovery body ("was zero for 15m"), not the 1s fire window.
    const openId = await repo.insert({
      created_at: 16_000,
      condition_started_at: 1_000,
      severity: 'IMPORTANT',
      title: 'open',
      body: 'b',
      status: 'BUFFERED',
      event_class: 'zero_hashrate',
      delivery_status: 'sent',
      delivery_attempts: 1,
      next_retry_at_ms: null,
      paired_alert_id: null,
    });
    await insertRecovery('zero_hashrate_recovery', 16_500, openId);
    const spans = await repo.conditionSpansSince(0, Number.MAX_SAFE_INTEGER, 2e12);
    expect(spans[0]).toMatchObject({ open_id: openId, start_ms: 1_000, end_ms: 16_500 });
    // #341: onset was recorded, so the drawer can compute the threshold
    // (fired_at - start_ms = 15s here) and total exactly, no estimate.
    expect(spans[0]).toMatchObject({ fired_at: 16_000, onset_known: true });
  });

  it('#341: fired_at falls back to created_at and onset_known is false pre-0119', async () => {
    // No condition_started_at on the opener -> the drawer can't know the
    // real onset, so it must flag the span for a config-based estimate.
    await insertOpener('zero_hashrate', 20_000);
    const spans = await repo.conditionSpansSince(0, Number.MAX_SAFE_INTEGER, 21_000);
    expect(spans[0]).toMatchObject({
      start_ms: 20_000,
      fired_at: 20_000,
      onset_known: false,
      // The repo leaves threshold_minutes null; the HTTP route fills it
      // from live config.
      threshold_minutes: null,
    });
  });

  it('recovery_body is null for implicit closes and open spans (#322)', async () => {
    // Orphan closed implicitly by the next same-class opener: no real
    // recovery moment -> no recovery_body.
    await insertOpener('zero_hashrate', 1_000);
    // Recent orphan (still open) -> also null.
    await insertOpener('zero_hashrate', 5_000);
    const spans = await repo.conditionSpansSince(0, Number.MAX_SAFE_INTEGER, 6_000);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.recovery_body).toBeNull();
    expect(spans[1]!.recovery_body).toBeNull();
  });

  it('leaves end_ms null for a RECENT orphan (plausibly still open)', async () => {
    const now = 10_000;
    await insertOpener('solo_overheating', now - 1_000); // 1s ago, < ORPHAN_MAX_MS
    const spans = await repo.conditionSpansSince(0, now, now);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBeNull();
  });

  it('#376: a latest-of-class unrecovered opener stays OPEN well past 6h (the blacklist-hold incident)', async () => {
    const start = 1_000;
    const now = start + 20 * 60 * 60 * 1000; // 20h into a 24h hold
    await insertOpener('target_blacklisted', start);
    const spans = await repo.conditionSpansSince(0, now, now);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBeNull(); // ongoing - never a fake "Recovered"
    expect(spans[0]?.end_estimated).toBe(false);
  });

  it('bounds a PATHOLOGICAL orphan at start + ORPHAN_MAX_MS, flagged estimated', async () => {
    const start = 1_000;
    const now = start + ORPHAN_MAX_MS + 60 * 60 * 1000; // beyond the 7d bound
    await insertOpener('solo_overheating', start);
    const spans = await repo.conditionSpansSince(0, now, now);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBe(start + ORPHAN_MAX_MS);
    expect(spans[0]?.end_estimated).toBe(true);
  });

  it('implicitly closes an orphan at the next same-class opener start', async () => {
    // Mirrors the live bug: two solo_overheating openers, neither recovered.
    await insertOpener('solo_overheating', 1_000);
    await insertOpener('solo_overheating', 5_000);
    const now = 5_000 + 1_000; // second opener is recent
    const spans = await repo.conditionSpansSince(0, now, now);
    const first = spans.find((s) => s.start_ms === 1_000);
    const second = spans.find((s) => s.start_ms === 5_000);
    expect(first?.end_ms).toBe(5_000); // closed at the next episode
    expect(first?.end_estimated).toBe(true); // #376: never labeled "Recovered"
    expect(second?.end_ms).toBeNull(); // newest, recent -> ongoing
  });

  it('a different-class opener does not implicitly close an orphan', async () => {
    const start = 1_000;
    const now = start + ORPHAN_MAX_MS + 60 * 60 * 1000;
    await insertOpener('solo_overheating', start);
    await insertOpener('zero_hashrate', 3_000); // different class
    const spans = await repo.conditionSpansSince(0, now, now);
    const solo = spans.find((s) => s.event_class === 'solo_overheating');
    // Not closed at 3_000; pathological -> bounded at start + ORPHAN_MAX_MS.
    expect(solo?.end_ms).toBe(start + ORPHAN_MAX_MS);
    expect(solo?.end_estimated).toBe(true);
  });

  it('ignores non-condition event_classes (e.g. pool_block_credited)', async () => {
    await insertOpener('pool_block_credited', 1_000);
    expect(await repo.conditionSpansSince(0, 10_000, 10_000)).toEqual([]);
  });

  it('excludes a span that closed before the window opened', async () => {
    const openId = await insertOpener('zero_hashrate', 1_000);
    await insertRecovery('zero_hashrate_recovery', 2_000, openId);
    expect(await repo.conditionSpansSince(5_000, 10_000, 10_000)).toEqual([]);
  });

  it('excludes an opener that starts after the window ends', async () => {
    await insertOpener('zero_hashrate', 9_000);
    expect(await repo.conditionSpansSince(0, 5_000, 9_000)).toEqual([]);
  });

  it('uses the earliest recovery when an opener has two', async () => {
    const openId = await insertOpener('api_unreachable', 1_000);
    await insertRecovery('api_unreachable_recovery', 8_000, openId);
    await insertRecovery('api_unreachable_recovery', 4_000, openId);
    const spans = await repo.conditionSpansSince(0, 10_000, 10_000);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.end_ms).toBe(4_000);
  });
});
