/**
 * Repository for the `alerts` table.
 *
 * Single owner of the alerts read/write path. The alert-manager
 * service writes rows on every transition into / out of bad state
 * and asks this repo for the work-list of due retries on each tick.
 * The /api/alerts HTTP route reads through it for the dashboard.
 *
 * Schema additions in migration 0062 (#100): delivery_status,
 * delivery_attempts, last_attempt_at_ms, next_retry_at_ms,
 * snoozed_until_ms, paired_alert_id, delivery_meta_json,
 * acknowledged_at_ms, event_class. The legacy v1.0 columns
 * (severity, status, sent_at) stay so existing rows are still
 * readable.
 */

import type { Kysely } from 'kysely';

import type {
  AlertDeliveryStatus,
  AlertSeverity,
  AlertStatus,
  Database,
} from '../types.js';

export interface AlertInsert {
  created_at: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  /** Legacy column - new rows use 'BUFFERED' until first delivery attempt. */
  status: AlertStatus;
  event_class: string | null;
  delivery_status: AlertDeliveryStatus;
  delivery_attempts: number;
  next_retry_at_ms: number | null;
  paired_alert_id: number | null;
}

export interface AlertRow {
  id: number;
  created_at: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  status: AlertStatus;
  sent_at: number | null;
  event_class: string | null;
  delivery_status: AlertDeliveryStatus;
  delivery_attempts: number;
  last_attempt_at_ms: number | null;
  next_retry_at_ms: number | null;
  snoozed_until_ms: number | null;
  paired_alert_id: number | null;
  delivery_meta_json: string | null;
  acknowledged_at_ms: number | null;
}

export interface AlertListFilters {
  /** Lower bound (inclusive) on `created_at`. Default: epoch. */
  readonly since_ms?: number;
  /** Restrict to a single severity, or omit for all. */
  readonly severity?: AlertSeverity;
  /** Restrict to a single delivery status, or omit for all. */
  readonly delivery_status?: AlertDeliveryStatus;
  /** When true, only rows with `acknowledged_at_ms IS NULL`. */
  readonly unacknowledged_only?: boolean;
  /** Soft cap on result size. Default 200. */
  readonly limit?: number;
}

export interface MarkDeliveredArgs {
  readonly id: number;
  readonly attempt_at_ms: number;
  readonly delivery_meta_json: string | null;
}

export interface MarkFailedArgs {
  readonly id: number;
  readonly attempt_at_ms: number;
  readonly next_retry_at_ms: number | null;
  /** Set to 'gave_up' on the 5th failed attempt; otherwise 'failed'. */
  readonly delivery_status: 'failed' | 'gave_up';
}

export class AlertsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(args: AlertInsert): Promise<number> {
    const result = await this.db
      .insertInto('alerts')
      .values({
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
        snoozed_until_ms: null,
        paired_alert_id: args.paired_alert_id,
        delivery_meta_json: null,
        acknowledged_at_ms: null,
      })
      .executeTakeFirstOrThrow();
    return Number(result.insertId);
  }

  async list(filters: AlertListFilters = {}): Promise<AlertRow[]> {
    const limit = filters.limit ?? 200;
    let q = this.db
      .selectFrom('alerts')
      .selectAll()
      .where('created_at', '>=', filters.since_ms ?? 0)
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (filters.severity) q = q.where('severity', '=', filters.severity);
    if (filters.delivery_status)
      q = q.where('delivery_status', '=', filters.delivery_status);
    if (filters.unacknowledged_only) q = q.where('acknowledged_at_ms', 'is', null);

    return q.execute() as Promise<AlertRow[]>;
  }

  async getById(id: number): Promise<AlertRow | null> {
    const row = await this.db
      .selectFrom('alerts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return (row as AlertRow | undefined) ?? null;
  }

  async markAcknowledged(id: number, atMs: number): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({ acknowledged_at_ms: atMs })
      .where('id', '=', id)
      .execute();
  }

  async snooze(id: number, untilMs: number): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({ snoozed_until_ms: untilMs })
      .where('id', '=', id)
      .execute();
  }

  async markDelivered(args: MarkDeliveredArgs): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({
        delivery_status: 'sent',
        sent_at: args.attempt_at_ms,
        last_attempt_at_ms: args.attempt_at_ms,
        next_retry_at_ms: null,
        delivery_meta_json: args.delivery_meta_json,
      })
      .where('id', '=', args.id)
      .execute();
    await this.incrementAttempts(args.id);
  }

  async markFailed(args: MarkFailedArgs): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({
        delivery_status: args.delivery_status,
        last_attempt_at_ms: args.attempt_at_ms,
        next_retry_at_ms: args.next_retry_at_ms,
      })
      .where('id', '=', args.id)
      .execute();
    await this.incrementAttempts(args.id);
  }

  async markMutedOrSnoozed(
    id: number,
    status: 'muted' | 'snoozed',
    attemptAtMs: number,
    nextRetryAtMs: number | null,
  ): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({
        delivery_status: status,
        last_attempt_at_ms: attemptAtMs,
        next_retry_at_ms: nextRetryAtMs,
      })
      .where('id', '=', id)
      .execute();
    await this.incrementAttempts(id);
  }

  /**
   * Rows whose retry timer has come due and which are still in a
   * deliverable state. `pending` covers the very first attempt; `failed`
   * + `muted` + `snoozed` cover retry attempts after a previous miss.
   * `gave_up` and `sent` are excluded.
   *
   * Acknowledged rows are also excluded - if the operator has clicked
   * "mark as seen" on the dashboard, the system MUST stop retrying.
   * Without this filter the operator gets pinged again on every retry
   * tick despite having explicitly confirmed receipt.
   */
  async nextDueRetries(nowMs: number, limit = 32): Promise<AlertRow[]> {
    const rows = await this.db
      .selectFrom('alerts')
      .selectAll()
      .where('next_retry_at_ms', 'is not', null)
      .where('next_retry_at_ms', '<=', nowMs)
      .where('delivery_status', 'in', ['pending', 'failed', 'muted', 'snoozed'])
      .where('acknowledged_at_ms', 'is', null)
      .orderBy('next_retry_at_ms', 'asc')
      .limit(limit)
      .execute();
    return rows as AlertRow[];
  }

  /**
   * Find the most recent alert row for the given event_class that
   * still represents an "open" outage - i.e. no later alert row pairs
   * back to it via `paired_alert_id` (no recovery has fired yet).
   *
   * Used by AlertEvaluator.hydrate() at daemon boot so a process
   * restart while a bad state is still active doesn't fire a duplicate
   * Telegram alert: the evaluator inherits the existing alert row's
   * id rather than recording a fresh one. Combined with the
   * acknowledged-stops-retries filter on nextDueRetries, this means
   * "ack via the dashboard, restart the daemon" is silent.
   */
  async findOpenAlert(eventClass: string): Promise<AlertRow | null> {
    const row = await this.db
      .selectFrom('alerts')
      .selectAll()
      .where('event_class', '=', eventClass)
      .where(({ eb, not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('alerts as recovery')
              .select('recovery.id')
              .whereRef('recovery.paired_alert_id', '=', 'alerts.id'),
          ),
        ),
      )
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return (row as AlertRow | undefined) ?? null;
  }

  /** Count of un-acknowledged alerts at LOUD or WARN severity. Drives the top-nav badge. */
  async countUnacknowledgedHighSeverity(): Promise<number> {
    const row = await this.db
      .selectFrom('alerts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('acknowledged_at_ms', 'is', null)
      .where('severity', 'in', ['LOUD', 'WARN'])
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  private async incrementAttempts(id: number): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set((eb) => ({
        delivery_attempts: eb('delivery_attempts', '+', 1),
      }))
      .where('id', '=', id)
      .execute();
  }
}
