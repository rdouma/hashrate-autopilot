import { describe, expect, it, vi } from 'vitest';

import { AlertManager } from './alert-manager.js';
import type { AlertRow, AlertsRepo } from '../state/repos/alerts.js';
import type { NotificationSink } from './notifier.js';

function makeRepoStub(): AlertsRepo & { rows: AlertRow[] } {
  const rows: AlertRow[] = [];
  let nextId = 1;
  const repo = {
    rows,
    insert: vi.fn(async (args) => {
      const id = nextId++;
      rows.push({
        id,
        created_at: args.created_at,
        severity: args.severity,
        title: args.title,
        body: args.body,
        status: args.status,
        sent_at: null,
        event_class: args.event_class,
        delivery_status: args.delivery_status,
        delivery_attempts: args.delivery_attempts,
        last_attempt_at_ms: null,
        next_retry_at_ms: args.next_retry_at_ms,
        paired_alert_id: args.paired_alert_id,
        delivery_meta_json: null,
        acknowledged_at_ms: null,
      });
      return id;
    }),
    getById: vi.fn(async (id: number) => rows.find((r) => r.id === id) ?? null),
    list: vi.fn(),
    markAcknowledged: vi.fn(),
    markDelivered: vi.fn(async ({ id, attempt_at_ms, delivery_meta_json }) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.delivery_status = 'sent';
      row.sent_at = attempt_at_ms;
      row.last_attempt_at_ms = attempt_at_ms;
      row.next_retry_at_ms = null;
      row.delivery_meta_json = delivery_meta_json;
      row.delivery_attempts += 1;
    }),
    markFailed: vi.fn(async ({ id, attempt_at_ms, next_retry_at_ms, delivery_status }) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.delivery_status = delivery_status;
      row.last_attempt_at_ms = attempt_at_ms;
      row.next_retry_at_ms = next_retry_at_ms;
      row.delivery_attempts += 1;
    }),
    markMuted: vi.fn(async (id, attemptAt, nextRetry) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.delivery_status = 'muted';
      row.last_attempt_at_ms = attemptAt;
      row.next_retry_at_ms = nextRetry;
      row.delivery_attempts += 1;
    }),
    nextDueRetries: vi.fn(async (nowMs: number) =>
      rows.filter(
        (r) =>
          r.next_retry_at_ms !== null &&
          r.next_retry_at_ms <= nowMs &&
          ['pending', 'failed', 'muted'].includes(r.delivery_status),
      ),
    ),
    countUnacknowledgedHighSeverity: vi.fn(),
  } as unknown as AlertsRepo & { rows: AlertRow[] };
  return repo;
}

function makeSink(send: NotificationSink['send']): NotificationSink {
  return { send, verify: vi.fn() };
}

describe('AlertManager.recordAlert', () => {
  it('inserts an alert and posts immediately on success', async () => {
    const repo = makeRepoStub();
    const sink = makeSink(
      vi.fn().mockResolvedValue({ ok: true, delivery_meta_json: '{"message_id":1}', error: null }),
    );
    const mgr = new AlertManager({
      alertsRepo: repo,
      sink,
      getConfig: () => ({ notifications_muted: false, notification_retry_interval_minutes: 30 }),
      now: () => 1_000_000,
    });
    const id = await mgr.recordAlert({
      severity: 'IMPORTANT',
      title: 'Stratum unreachable',
      body: 'Datum SV1 down for 10 min',
      event_class: 'datum_unreachable',
    });
    expect(id).toBe(1);
    expect(repo.rows[0]!.delivery_status).toBe('sent');
    expect(repo.rows[0]!.delivery_meta_json).toBe('{"message_id":1}');
  });

  it('records as muted when notifications_muted is true', async () => {
    const repo = makeRepoStub();
    const sink = makeSink(vi.fn());
    const mgr = new AlertManager({
      alertsRepo: repo,
      sink,
      getConfig: () => ({ notifications_muted: true, notification_retry_interval_minutes: 30 }),
      now: () => 2_000_000,
    });
    await mgr.recordAlert({
      severity: 'IMPORTANT',
      title: 'X',
      body: 'Y',
      event_class: 'datum_unreachable',
    });
    expect(sink.send).not.toHaveBeenCalled();
    expect(repo.rows[0]!.delivery_status).toBe('muted');
  });

  it('schedules a retry when delivery fails', async () => {
    const repo = makeRepoStub();
    const sink = makeSink(
      vi.fn().mockResolvedValue({ ok: false, delivery_meta_json: null, error: 'timeout' }),
    );
    const mgr = new AlertManager({
      alertsRepo: repo,
      sink,
      getConfig: () => ({ notifications_muted: false, notification_retry_interval_minutes: 30 }),
      now: () => 3_000_000,
    });
    await mgr.recordAlert({
      severity: 'WARNING',
      title: 'X',
      body: 'Y',
      event_class: 'beta_exit',
    });
    expect(repo.rows[0]!.delivery_status).toBe('failed');
    expect(repo.rows[0]!.next_retry_at_ms).toBe(3_000_000 + 30 * 60_000);
  });
});

describe('AlertManager.processDueRetries', () => {
  it('transitions to gave_up after 5 total attempts', async () => {
    const repo = makeRepoStub();
    const sink = makeSink(
      vi.fn().mockResolvedValue({ ok: false, delivery_meta_json: null, error: 'still bad' }),
    );
    let now = 1_000_000;
    const mgr = new AlertManager({
      alertsRepo: repo,
      sink,
      getConfig: () => ({ notifications_muted: false, notification_retry_interval_minutes: 30 }),
      now: () => now,
    });
    await mgr.recordAlert({
      severity: 'IMPORTANT',
      title: 'X',
      body: 'Y',
      event_class: 'datum_unreachable',
    });
    // Attempts 2..5
    for (let i = 0; i < 4; i++) {
      now += 30 * 60_000;
      await mgr.processDueRetries();
    }
    expect(repo.rows[0]!.delivery_attempts).toBe(5);
    expect(repo.rows[0]!.delivery_status).toBe('gave_up');
    expect(repo.rows[0]!.next_retry_at_ms).toBeNull();
    // The "giving up" final message is the 6th sink.send call:
    // 1 initial + 4 retries + 1 farewell.
    expect(sink.send).toHaveBeenCalledTimes(6);
    const last = (sink.send as unknown as { mock: { calls: string[][] } }).mock
      .calls[5]![0];
    expect(last).toMatch(/no further notifications/i);
  });

  // The "skips delivery while snooze is active" test was removed
  // 2026-05-09 along with the snooze concept itself. processDueRetries
  // no longer reads snoozed_until_ms; legacy rows with the column
  // populated retry as if it weren't set.
});
