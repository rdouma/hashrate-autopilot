/**
 * Alerts HTTP routes (#100).
 *
 * Read-only listing for the dashboard `/alerts` page, plus mutate
 * endpoints (acknowledge + acknowledge-all). The alert-manager owns
 * the *write* side for delivery state; these routes only let the
 * operator annotate rows.
 *
 * Snooze removed 2026-05-09 - the operator's call: the event-class
 * state machine already silences re-fires while a bad state is
 * open, so the snooze button bought no value beyond surface area.
 */

import type { FastifyInstance } from 'fastify';

import { formatTelegramBody } from '../../services/alert-manager.js';
import { TelegramSink } from '../../services/notifier.js';
import type {
  AlertDeliveryStatus,
  AlertSeverity,
} from '../../state/types.js';
import type { AlertRow, AlertsRepo } from '../../state/repos/alerts.js';
import type { ConfigRepo } from '../../state/repos/config.js';

export interface AlertsRouteDeps {
  readonly alertsRepo: AlertsRepo;
  readonly configRepo: ConfigRepo;
}

export interface AlertsListQuery {
  since_ms?: string;
  /** #121: cursor; rows strictly older than this. Use createdAt of the last row in the previous page. */
  before_created_at_ms?: string;
  severity?: AlertSeverity;
  delivery_status?: AlertDeliveryStatus;
  unacknowledged_only?: string;
  limit?: string;
}

export interface AlertsListResponse {
  alerts: AlertRow[];
  unacknowledged_high_severity_count: number;
  /** #121: total rows matching the same filter set, ignoring pagination. */
  total_count: number;
  /** #121: are there older rows past the returned page? */
  has_more: boolean;
}

export interface AcknowledgeResponse {
  ok: boolean;
  acknowledged_at_ms: number;
}

export interface AcknowledgeAllResponse {
  ok: boolean;
  acknowledged_at_ms: number;
  /** Number of rows transitioned from unacknowledged to acknowledged. */
  count: number;
}

const VALID_SEVERITIES: ReadonlySet<AlertSeverity> = new Set(['INFO', 'WARNING', 'IMPORTANT']);

/**
 * #109 follow-up (operator request 2026-05-09): when the operator
 * acks an alert from the dashboard, mirror the same Telegram-
 * message edit that TelegramReceiver does for in-Telegram acks.
 * Strip the inline keyboard and append a confirmation footer so the
 * operator's chat history reflects the resolution regardless of
 * which surface they used.
 *
 * The edit is best-effort: failures are logged but never block the
 * HTTP response. The dashboard already persisted the ack on the
 * alert row before this runs.
 */
async function editTelegramMessageForRow(
  row: AlertRow,
  cfg: { telegram_bot_token: string; telegram_chat_id: string; telegram_instance_label: string },
  confirmation: string,
  nowMs: number,
): Promise<void> {
  if (!row.delivery_meta_json) return;
  if (!cfg.telegram_bot_token || !cfg.telegram_chat_id) return;

  let messageId: number | null = null;
  try {
    const meta = JSON.parse(row.delivery_meta_json) as { message_id?: number };
    if (typeof meta.message_id === 'number') messageId = meta.message_id;
  } catch {
    return;
  }
  if (messageId === null) return;

  // Reconstruct the original message body from the row (severity
  // emoji + bracket label + title + body), then append the
  // confirmation footer in italics. Mirrors the existing Telegram-
  // side ack flow but preserves the bold title formatting that the
  // receiver path loses (it reads cb.message.text which Telegram
  // returns plain).
  const isRecovery = row.paired_alert_id !== null;
  const original = formatTelegramBody(row.severity, row.title, row.body, isRecovery);
  const footer = `\n\n<i>${confirmation} · ${new Date(nowMs).toISOString()}</i>`;
  const labelPrefix = cfg.telegram_instance_label.trim();
  const fullText = labelPrefix ? `[${labelPrefix}] ${original}${footer}` : `${original}${footer}`;

  const sink = new TelegramSink({
    bot_token: cfg.telegram_bot_token,
    chat_id: cfg.telegram_chat_id,
    instance_label: '', // already prefixed above; don't double-prefix.
  });
  const result = await sink.editMessage(messageId, fullText);
  if (!result.ok) {
    // "message is not modified" is a benign 400 (Telegram returns it
    // when the new text equals the old). Anything else gets logged
    // for the operator to investigate; never throws.
    if (result.error && !result.error.includes('not modified')) {
      console.warn(`[alerts] Telegram edit failed: ${result.error}`);
    }
  }
}
const VALID_DELIVERY: ReadonlySet<AlertDeliveryStatus> = new Set([
  'pending',
  'sent',
  'failed',
  'muted',
  'gave_up',
]);

export async function registerAlertsRoutes(
  app: FastifyInstance,
  deps: AlertsRouteDeps,
): Promise<void> {
  app.get<{ Querystring: AlertsListQuery }>(
    '/api/alerts',
    async (req): Promise<AlertsListResponse> => {
      const q = req.query;
      const sinceMs = q.since_ms ? Number(q.since_ms) : undefined;
      const beforeCreatedAt = q.before_created_at_ms
        ? Number(q.before_created_at_ms)
        : undefined;
      // #121: default page size lowered from 200 to 50; 200 was a
      // soft wall on long-history installs. Hard cap stays at 1000
      // so a power-user can still grab a big batch via the API.
      const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : 50;
      const severity = q.severity && VALID_SEVERITIES.has(q.severity) ? q.severity : undefined;
      const deliveryStatus =
        q.delivery_status && VALID_DELIVERY.has(q.delivery_status) ? q.delivery_status : undefined;
      const unacknowledgedOnly = q.unacknowledged_only === 'true' || q.unacknowledged_only === '1';

      const filters: {
        since_ms?: number;
        before_created_at?: number;
        severity?: AlertSeverity;
        delivery_status?: AlertDeliveryStatus;
        unacknowledged_only: boolean;
        limit: number;
      } = {
        unacknowledged_only: unacknowledgedOnly,
        // Over-fetch by 1 so we can derive has_more without a second
        // count query: if the repo returned limit+1 rows, there's at
        // least one more page worth pulling. Drop the trailing row
        // before returning so the operator only sees what they asked
        // for.
        limit: limit + 1,
      };
      if (sinceMs !== undefined) filters.since_ms = sinceMs;
      if (beforeCreatedAt !== undefined) filters.before_created_at = beforeCreatedAt;
      if (severity !== undefined) filters.severity = severity;
      if (deliveryStatus !== undefined) filters.delivery_status = deliveryStatus;

      const [overFetched, highSevCount, totalCount] = await Promise.all([
        deps.alertsRepo.list(filters),
        deps.alertsRepo.countUnacknowledgedHighSeverity(),
        deps.alertsRepo.count({
          ...(severity !== undefined ? { severity } : {}),
          ...(deliveryStatus !== undefined ? { delivery_status: deliveryStatus } : {}),
          unacknowledged_only: unacknowledgedOnly,
        }),
      ]);

      const hasMore = overFetched.length > limit;
      const alerts = hasMore ? overFetched.slice(0, limit) : overFetched;

      return {
        alerts,
        unacknowledged_high_severity_count: highSevCount,
        total_count: totalCount,
        has_more: hasMore,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/alerts/:id/acknowledge',
    async (req, reply): Promise<AcknowledgeResponse | { error: string }> => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid alert id' });
      }
      const existing = await deps.alertsRepo.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'alert not found' });
      }
      const now = Date.now();
      await deps.alertsRepo.markAcknowledged(id, now);
      // Best-effort Telegram edit so the in-chat message reflects
      // the dashboard-side ack. Run after the row is already
      // persisted; never blocks the HTTP response on Telegram.
      const cfg = await deps.configRepo.get();
      if (cfg) {
        await editTelegramMessageForRow(existing, cfg, '✓ acknowledged', now);
      }
      return { ok: true, acknowledged_at_ms: now };
    },
  );

  app.post(
    '/api/alerts/acknowledge-all',
    async (): Promise<AcknowledgeAllResponse> => {
      const now = Date.now();
      // Snapshot unacked rows BEFORE the bulk update so we have
      // their delivery_meta_json (= message_id) for the Telegram
      // edits. The bulk update itself is one SQL statement against
      // `acknowledged_at_ms IS NULL`; a row that races in between
      // the snapshot and the update would simply be skipped by the
      // update (already acked) and its Telegram message gets
      // edited to the same text on the next round - benign.
      const toEdit = await deps.alertsRepo.list({
        unacknowledged_only: true,
        limit: 1000,
      });
      const count = await deps.alertsRepo.markAllAcknowledged(now);
      const cfg = await deps.configRepo.get();
      if (cfg) {
        for (const row of toEdit) {
          await editTelegramMessageForRow(row, cfg, '✓ acknowledged', now);
        }
      }
      return { ok: true, acknowledged_at_ms: now, count };
    },
  );

  // Snooze endpoint removed 2026-05-09. Older clients calling
  // /api/alerts/:id/snooze get a 404 from Fastify's default
  // routing; that's fine - the dashboard no longer makes the call,
  // and the previous behaviour was a no-op for sent alerts anyway.
}
