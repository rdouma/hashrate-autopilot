/**
 * Alert-manager: single owner of the alerts table write path.
 *
 * Two responsibilities:
 *
 * 1. **Recording** - when an event detector observes a transition into
 *    a bad state (or out of one), it calls `recordAlert(...)`. The
 *    manager inserts the row, schedules the first delivery attempt,
 *    and (if not muted/snoozed) POSTs immediately.
 *
 * 2. **Retry loop** - `processDueRetries(nowMs)` is called once per
 *    daemon tick. It pulls every alert whose `next_retry_at_ms` has
 *    come due and re-attempts delivery, or transitions to `gave_up`
 *    after 5 total attempts.
 *
 * The 9 event detectors that call `recordAlert` live in their own
 * services (pool-health for stratum, etc) and feed in transitions
 * via a per-tick `AlertManagerEvaluator`. This file owns only the
 * write/retry semantics; *what* fires alerts is upstream of here.
 *
 * Design note: the manager never returns Telegram-specific objects.
 * The NotificationSink interface stays the only seam between alert
 * orchestration and channel I/O (#100 design intent: future second
 * sink slots in here without touching detectors).
 */

import type { NotificationSink } from './notifier.js';
import type {
  AlertsRepo,
  AlertInsert,
  AlertRow,
} from '../state/repos/alerts.js';
import type { AlertSeverity } from '../state/types.js';
import { getAlertCopy } from '../i18n/alert-copy.js';

export interface RecordAlertArgs {
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly body: string;
  /** Stable identifier for the event class, e.g. 'datum_unreachable'. */
  readonly event_class: string;
  /** When set, marks this alert as the recovery for an earlier alert id. */
  readonly paired_alert_id?: number;
}

export interface AlertManagerOptions {
  readonly alertsRepo: AlertsRepo;
  readonly sink: NotificationSink;
  /** Returns the latest config snapshot. The manager re-reads on every
   *  decision so live edits to mute / retry-interval take effect on
   *  the next tick without a restart. */
  readonly getConfig: () => AlertManagerConfig;
  readonly now?: () => number;
}

export interface AlertManagerConfig {
  readonly notifications_muted: boolean;
  readonly notification_retry_interval_minutes: number;
  /** #131: locale for the Telegram severity prefix; default 'en'. */
  readonly notification_locale?: string;
}

const MAX_TOTAL_ATTEMPTS = 5;

export class AlertManager {
  private readonly alertsRepo: AlertsRepo;
  private readonly sink: NotificationSink;
  private readonly getConfig: () => AlertManagerConfig;
  private readonly now: () => number;

  constructor(opts: AlertManagerOptions) {
    this.alertsRepo = opts.alertsRepo;
    this.sink = opts.sink;
    this.getConfig = opts.getConfig;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Record a new alert and (unless muted or snoozed) attempt
   * delivery immediately. Returns the alert id so the caller can
   * pair a future recovery row to it.
   */
  async recordAlert(args: RecordAlertArgs): Promise<number> {
    const cfg = this.getConfig();
    const nowMs = this.now();

    // Set next_retry_at_ms far enough in the future that the
    // concurrent processDueRetries() on this same tick won't pick
    // up the row before the initial attemptDelivery() finishes.
    // If the initial attempt fails, attemptDelivery() overwrites
    // next_retry_at_ms with the real retry schedule.
    const firstRetryAt = this.computeNextRetry(1, nowMs, cfg) ?? nowMs + 60_000;
    const insert: AlertInsert = {
      created_at: nowMs,
      severity: args.severity,
      title: args.title,
      body: args.body,
      status: 'BUFFERED',
      event_class: args.event_class,
      delivery_status: 'pending',
      delivery_attempts: 0,
      next_retry_at_ms: firstRetryAt,
      paired_alert_id: args.paired_alert_id ?? null,
    };
    const id = await this.alertsRepo.insert(insert);

    await this.attemptDelivery({ id, severity: args.severity, body: this.formatBody(args), nowMs, cfg });
    return id;
  }

  /**
   * Per-tick driver: deliver any alerts whose retry timer has come
   * due, transitioning to `gave_up` after 5 total attempts.
   */
  async processDueRetries(): Promise<void> {
    const nowMs = this.now();
    const cfg = this.getConfig();
    const due = await this.alertsRepo.nextDueRetries(nowMs);

    for (const row of due) {
      await this.attemptDelivery({
        id: row.id,
        severity: row.severity,
        body: this.formatBodyFromRow(row),
        nowMs,
        cfg,
      });
    }
  }

  private async attemptDelivery(args: {
    id: number;
    severity: AlertSeverity;
    body: string;
    nowMs: number;
    cfg: AlertManagerConfig;
  }): Promise<void> {
    // Re-read the alert so we see the current attempts count and
    // can compute retry scheduling on top of it.
    const row = await this.alertsRepo.getById(args.id);
    if (!row) return;

    if (args.cfg.notifications_muted) {
      const next = this.computeNextRetry(row.delivery_attempts + 1, args.nowMs, args.cfg);
      await this.alertsRepo.markMuted(row.id, args.nowMs, next);
      return;
    }

    // #109: every Telegram message gets a single Mark-as-seen button
    // so the operator can ack from the chat without opening the
    // dashboard. The snooze button was removed 2026-05-09 - the
    // operator's call: "actually, just remove the whole concept of a
    // snooze. It's utter bullshit. I think it's over the top." The
    // event-class state machine already silences re-fires while a
    // bad state is open, so a manual "shut up about this" knob added
    // surface area without buying the operator anything.
    const action_buttons = [
      { text: '✓ Mark as seen', callback_data: `ack:${row.id}` },
    ];
    const result = await this.sink.send(args.body, {
      alert_id: row.id,
      action_buttons,
    });

    if (result.ok) {
      await this.alertsRepo.markDelivered({
        id: row.id,
        attempt_at_ms: args.nowMs,
        delivery_meta_json: result.delivery_meta_json,
      });
      return;
    }

    const attemptsAfter = row.delivery_attempts + 1;
    if (attemptsAfter >= MAX_TOTAL_ATTEMPTS) {
      await this.alertsRepo.markFailed({
        id: row.id,
        attempt_at_ms: args.nowMs,
        next_retry_at_ms: null,
        delivery_status: 'gave_up',
      });
      // One final "giving up" message, best-effort and not retried itself.
      await this.sink.send(this.givingUpBody(row, args.nowMs));
      return;
    }

    await this.alertsRepo.markFailed({
      id: row.id,
      attempt_at_ms: args.nowMs,
      next_retry_at_ms: this.computeNextRetry(attemptsAfter, args.nowMs, args.cfg),
      delivery_status: 'failed',
    });
  }

  private computeNextRetry(
    attemptsAfter: number,
    nowMs: number,
    cfg: AlertManagerConfig,
  ): number | null {
    if (attemptsAfter >= MAX_TOTAL_ATTEMPTS) return null;
    return nowMs + cfg.notification_retry_interval_minutes * 60_000;
  }

  /**
   * The Telegram sink runs with `parse_mode: 'HTML'`. Bold the title
   * for at-a-glance scanning; HTML-escape the dynamic body so a
   * worker name or error string with `<` or `&` in it doesn't blow
   * up Telegram's parser. Severity is conveyed by the emoji + bracket
   * label prefix on the title (🔴 [IMPORTANT] / ⚠️ [WARNING] / ℹ️ [INFO]
   * / ✅ [RESOLVED]) - operator can scan the chat list at a glance
   * without opening each message.
   */
  private formatBody(args: RecordAlertArgs): string {
    return formatTelegramBody(
      args.severity,
      args.title,
      args.body,
      args.paired_alert_id != null,
      this.getConfig().notification_locale,
    );
  }

  private formatBodyFromRow(row: AlertRow): string {
    return formatTelegramBody(
      row.severity,
      row.title,
      row.body,
      row.paired_alert_id != null,
      this.getConfig().notification_locale,
    );
  }

  private givingUpBody(row: AlertRow, _nowMs: number): string {
    const locale = this.getConfig().notification_locale;
    return formatTelegramBody(
      row.severity,
      row.title,
      getAlertCopy(locale).giving_up_body,
      // Giving-up messages are retries of an original firing, never a
      // recovery row themselves - paired_alert_id is null by
      // construction here even if the original alert pointed somewhere.
      false,
      locale,
    );
  }
}

/**
 * Prefix the bold title with an emoji + bracket label so the operator
 * can scan severity at a glance both inside the message and from
 * Telegram's chat-list preview. Bracket label survives forwarding /
 * copy-paste even when emoji rendering varies across clients.
 *
 * Recovery rows (paired_alert_id != null) always render as ✅
 * [RESOLVED] regardless of the underlying severity column - the
 * row's INFO severity is structural ("not actionable, no retry
 * ladder"), the operator-facing label is "the bad thing is fixed".
 */
export function formatTelegramBody(
  severity: AlertSeverity,
  title: string,
  body: string,
  isRecovery: boolean,
  locale?: string | null,
): string {
  const copy = getAlertCopy(locale);
  const prefix = isRecovery
    ? copy.prefix_resolved
    : severity === 'IMPORTANT'
      ? copy.prefix_important
      : severity === 'WARNING'
        ? copy.prefix_warning
        : copy.prefix_info;
  return `<b>${prefix} ${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
