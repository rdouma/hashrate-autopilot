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
 * paired_alert_id, delivery_meta_json, acknowledged_at_ms,
 * event_class. The legacy v1.0 columns (severity, status, sent_at)
 * stay so existing rows are still readable. The `snoozed_until_ms`
 * column from #100 was dropped in #148 (migration 0084) - snooze
 * was retired in cc62951.
 */

import type { Kysely } from 'kysely';

import {
  CONDITION_OPEN_CLASSES,
  CONDITION_RECOVERY_CLASSES,
} from '@hashrate-autopilot/shared';

import type {
  AlertDeliveryStatus,
  AlertSeverity,
  AlertStatus,
  Database,
} from '../types.js';

/**
 * A condition span derived from an open/recovery alert pair (#316).
 * `end_ms` is null while the condition is still open. Used by the
 * timeline band layer on both charts and the unified History feed.
 */
export interface AlertConditionSpan {
  /** The opener alert's row id (stable key + jump target). */
  readonly open_id: number;
  readonly event_class: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly body: string;
  readonly start_ms: number;
  /** Recovery timestamp, or null if the condition is still open. */
  readonly end_ms: number | null;
  /**
   * #376: true when `end_ms` is NOT a real recovery - the span was
   * closed implicitly (a newer episode of the same class started) or
   * bounded (pathological orphan past the outer bound). The UI must
   * never label an estimated end "Recovered".
   */
  readonly end_estimated: boolean;
  /**
   * #341: the moment the loud alert notification actually fired
   * (opener.created_at). Distinct from `start_ms`, which is the
   * condition onset (bad_since) when known. The gap between them is
   * the sustained threshold the operator waited out before being
   * paged; the drawer breaks the two apart.
   */
  readonly fired_at: number;
  /**
   * #341: true when the firing row recorded condition-onset
   * (condition_started_at, migration 0119+). When true the threshold
   * and total are EXACT (fired_at - start_ms / end_ms - start_ms).
   * When false the onset is unknown (pre-0119 row) and the drawer
   * estimates from `threshold_minutes` + a footnote.
   */
  readonly onset_known: boolean;
  /**
   * #341: current-config sustained threshold for this class, in
   * minutes, used to ESTIMATE the pre-firing wait when onset_known is
   * false. Null for classes with no minutes-based sustained threshold
   * (wallet runway is day-based, overheating is temperature-based).
   * Filled by the HTTP route from live config, not the repo.
   */
  readonly threshold_minutes: number | null;
  /**
   * #322: the paired recovery alert's body ("Hashrate back at or above
   * floor - was below for 17m."), or null when the span was closed
   * implicitly (next same-class episode / orphan bound) or is still
   * open. Non-null recovery_body marks a REAL recovery moment - the
   * Timeline renders those as their own rows at end_ms.
   */
  readonly recovery_body: string | null;
}

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
  /** #341: condition-onset (bad_since) for firing rows; null otherwise. */
  condition_started_at?: number | null;
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
  paired_alert_id: number | null;
  delivery_meta_json: string | null;
  acknowledged_at_ms: number | null;
  condition_started_at: number | null;
}

export interface AlertListFilters {
  /** Lower bound (inclusive) on `created_at`. Default: epoch. */
  readonly since_ms?: number;
  /**
   * #121: cursor for descending pagination. When set, returns rows
   * STRICTLY OLDER than this `created_at` value. Combine with
   * `limit` to walk back through history one page at a time.
   */
  readonly before_created_at?: number;
  /** Restrict to a single severity, or omit for all. */
  readonly severity?: AlertSeverity;
  /** Restrict to a single delivery status, or omit for all. */
  readonly delivery_status?: AlertDeliveryStatus;
  /** When true, only rows with `acknowledged_at_ms IS NULL`. */
  readonly unacknowledged_only?: boolean;
  /** Soft cap on result size. Default 50. */
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
        paired_alert_id: args.paired_alert_id,
        delivery_meta_json: null,
        acknowledged_at_ms: null,
        condition_started_at: args.condition_started_at ?? null,
      })
      .executeTakeFirstOrThrow();
    return Number(result.insertId);
  }

  async list(filters: AlertListFilters = {}): Promise<AlertRow[]> {
    const limit = filters.limit ?? 50;
    let q = this.db
      .selectFrom('alerts')
      .selectAll()
      .where('created_at', '>=', filters.since_ms ?? 0)
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (filters.before_created_at !== undefined)
      q = q.where('created_at', '<', filters.before_created_at);
    if (filters.severity) q = q.where('severity', '=', filters.severity);
    if (filters.delivery_status)
      q = q.where('delivery_status', '=', filters.delivery_status);
    if (filters.unacknowledged_only) q = q.where('acknowledged_at_ms', 'is', null);

    return q.execute() as Promise<AlertRow[]>;
  }

  /**
   * #121: total count under the same filter set as `list`, minus
   * pagination (since_ms / limit / before_created_at don't affect
   * the total). Lets the dashboard render "1234 alerts in total"
   * regardless of how far back the operator has scrolled.
   */
  async count(
    filters: Pick<AlertListFilters, 'severity' | 'delivery_status' | 'unacknowledged_only'> = {},
  ): Promise<number> {
    let q = this.db
      .selectFrom('alerts')
      .select((eb) => eb.fn.countAll<number>().as('n'));
    if (filters.severity) q = q.where('severity', '=', filters.severity);
    if (filters.delivery_status)
      q = q.where('delivery_status', '=', filters.delivery_status);
    if (filters.unacknowledged_only) q = q.where('acknowledged_at_ms', 'is', null);
    const row = await q.executeTakeFirstOrThrow();
    return Number(row.n);
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

  /**
   * Bulk-acknowledge every alert that doesn't already carry an
   * `acknowledged_at_ms`. Powers the Alerts page's "mark all as
   * seen" button - operator returns to the dashboard with N pending
   * notifications and wants to clear them in a single click rather
   * than chasing the row-level button N times. Returns the number
   * of rows updated so the dashboard can show a brief confirmation.
   */
  async markAllAcknowledged(atMs: number): Promise<number> {
    const result = await this.db
      .updateTable('alerts')
      .set({ acknowledged_at_ms: atMs })
      .where('acknowledged_at_ms', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0);
  }

  // Snooze removed 2026-05-09 (cc62951; operator request). The
  // `snoozed_until_ms` column itself dropped in #148 (migration 0084).

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

  async markMuted(
    id: number,
    attemptAtMs: number,
    nextRetryAtMs: number | null,
  ): Promise<void> {
    await this.db
      .updateTable('alerts')
      .set({
        delivery_status: 'muted',
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
   * + `muted` cover retry attempts after a previous miss. `gave_up`
   * and `sent` are excluded.
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
      .where('delivery_status', 'in', ['pending', 'failed', 'muted'])
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

  /**
   * Count of un-acknowledged, un-recovered alerts at IMPORTANT or
   * WARNING severity. Drives the top-nav badge.
   *
   * (#166) The recovery-pair exclusion matches the Alerts page's OPEN
   * bucket model: `recovery === null && acknowledged_at_ms === null`.
   * Without it, an alert that auto-recovered (paired with a recovery
   * row) but was never explicitly ack'd by the operator still counts
   * as "unread" - the badge lights up while the page itself shows
   * nothing actionable.
   */
  async countUnacknowledgedHighSeverity(): Promise<number> {
    const row = await this.db
      .selectFrom('alerts')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('acknowledged_at_ms', 'is', null)
      .where('severity', 'in', ['IMPORTANT', 'WARNING'])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('alerts as recovery')
              .select('recovery.id')
              .whereRef('recovery.paired_alert_id', '=', 'alerts.id'),
          ),
        ),
      )
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

  /**
   * #119: prune rows older than the supplied cutoff. Only deletes
   * rows whose retry lifecycle has resolved - 'pending' still
   * represents in-flight work that the AlertManager would
   * reattempt, so age alone shouldn't drop them. Returns the number
   * of rows removed.
   */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const result = await this.db
      .deleteFrom('alerts')
      .where('created_at', '<', cutoffMs)
      .where('delivery_status', 'in', ['sent', 'failed', 'gave_up', 'muted'])
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  /**
   * #316: condition spans overlapping [sinceMs, untilMs], derived from
   * open/recovery alert pairs. An opener (event_class in
   * CONDITION_OPEN_CLASSES) is matched to its recovery via the recovery
   * row's `paired_alert_id`. The alert volume is tiny (tens of openers
   * over months), so we fetch both sides whole and pair in memory.
   *
   * Orphan openers (no recovery row) are the hazard: a daemon restart
   * mid-condition, or a recovery that was never written, leaves an
   * opener that naively reads as "still open" and would paint a band
   * from its start to forever - empirically a 49-day-old solo_overheating
   * orphan tiled the entire Hashrate chart (operator report 2026-06-30).
   * So an orphan's end is bounded:
   *   - by the NEXT same-class opener's start (a new episode means the
   *     old one must have ended), else
   *   - left open (end null = ongoing to now) only if it started within
   *     ORPHAN_MAX_MS of now (plausibly the live condition), else
   *   - capped at start + ORPHAN_MAX_MS (a stale orphan whose real end
   *     we don't know; this keeps it from extending indefinitely).
   * Recovered spans are trusted as-is at any length.
   */
  async conditionSpansSince(
    sinceMs: number,
    untilMs: number,
    nowMs: number = Date.now(),
  ): Promise<AlertConditionSpan[]> {
    if (CONDITION_OPEN_CLASSES.length === 0) return [];

    // #376: an unrecovered opener that is the LATEST of its class is
    // genuinely ongoing - the evaluator hydrates open alerts across
    // restarts and pairs a recovery the moment the condition clears,
    // so "latest + unrecovered" means the condition is live (or the
    // daemon is down mid-condition, which the band should also show).
    // The old 6-hour orphan cap falsely "recovered" the first
    // legitimately long-lived condition (a 24h marketplace blacklist
    // hold) six hours in. A generous outer bound remains only for
    // pathological orphans whose recovery can never fire (e.g. a
    // per-device solo alert whose device was removed).
    const ORPHAN_MAX_MS = 7 * 24 * 60 * 60 * 1000;

    const [openers, recoveries] = await Promise.all([
      this.db
        .selectFrom('alerts')
        .selectAll()
        .where('event_class', 'in', CONDITION_OPEN_CLASSES as string[])
        .where('created_at', '<=', untilMs)
        .orderBy('created_at', 'asc')
        .execute() as Promise<AlertRow[]>,
      this.db
        .selectFrom('alerts')
        .select(['paired_alert_id', 'created_at', 'body'])
        .where('event_class', 'in', CONDITION_RECOVERY_CLASSES as string[])
        .where('paired_alert_id', 'is not', null)
        .execute(),
    ]);

    // Earliest recovery per opener id (a re-fired condition that
    // somehow produced two recoveries should close on the first).
    const recoveryByOpenId = new Map<number, { at: number; body: string }>();
    for (const r of recoveries) {
      const openId = r.paired_alert_id;
      if (openId === null) continue;
      const prev = recoveryByOpenId.get(openId);
      if (prev === undefined || r.created_at < prev.at) {
        recoveryByOpenId.set(openId, { at: r.created_at, body: r.body });
      }
    }

    // Next same-class opener start, used to implicitly close an orphan.
    const nextOpenerStartById = new Map<number, number>();
    const lastStartByClass = new Map<string, { id: number; start: number }>();
    // openers are ascending by created_at; walk descending so "next" is
    // the most recently seen opener of the same class.
    for (let i = openers.length - 1; i >= 0; i--) {
      const o = openers[i]!;
      if (o.event_class === null) continue;
      const seen = lastStartByClass.get(o.event_class);
      if (seen) nextOpenerStartById.set(o.id, seen.start);
      lastStartByClass.set(o.event_class, { id: o.id, start: o.created_at });
    }

    const spans: AlertConditionSpan[] = [];
    for (const o of openers) {
      if (o.event_class === null) continue;
      const recovery = recoveryByOpenId.get(o.id);
      let endMs: number | null;
      let endEstimated = false;
      if (recovery !== undefined) {
        endMs = recovery.at; // trust the recovery fully, any length.
      } else {
        const nextStart = nextOpenerStartById.get(o.id);
        if (nextStart !== undefined) {
          endMs = nextStart; // implicit close at the next episode.
          endEstimated = true;
        } else if (nowMs - o.created_at <= ORPHAN_MAX_MS) {
          endMs = null; // latest of its class, unrecovered -> ongoing.
        } else {
          endMs = o.created_at + ORPHAN_MAX_MS; // pathological orphan -> bounded.
          endEstimated = true;
        }
      }
      // Closed (or bounded) before the window opened -> no overlap.
      if (endMs !== null && endMs < sinceMs) continue;
      spans.push({
        open_id: o.id,
        event_class: o.event_class,
        severity: o.severity,
        title: o.title,
        body: o.body,
        // #341: span starts at condition-onset (bad_since) when the firing
        // row recorded it, so Started/Duration cover the true outage and
        // match the recovery body. Pre-0119 rows fall back to the fire time.
        start_ms: o.condition_started_at ?? o.created_at,
        end_ms: endMs,
        // #341: keep the fire time and the onset distinct so the drawer can
        // show "threshold / fired / duration / total" separately. Onset is
        // known iff the row recorded condition_started_at.
        fired_at: o.created_at,
        onset_known: o.condition_started_at !== null,
        threshold_minutes: null, // enriched by the HTTP route from live config
        recovery_body: recovery !== undefined ? recovery.body : null,
        end_estimated: endEstimated,
      });
    }
    return spans;
  }
}
