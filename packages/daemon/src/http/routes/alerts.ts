/**
 * Alerts HTTP routes (#100).
 *
 * Read-only listing for the dashboard `/alerts` page, plus two
 * mutate endpoints (acknowledge + snooze). The alert-manager owns
 * the *write* side for delivery state; these routes only let the
 * operator annotate rows.
 */

import type { FastifyInstance } from 'fastify';

import type {
  AlertDeliveryStatus,
  AlertSeverity,
} from '../../state/types.js';
import type { AlertRow, AlertsRepo } from '../../state/repos/alerts.js';

export interface AlertsRouteDeps {
  readonly alertsRepo: AlertsRepo;
}

export interface AlertsListQuery {
  since_ms?: string;
  severity?: AlertSeverity;
  delivery_status?: AlertDeliveryStatus;
  unacknowledged_only?: string;
  limit?: string;
}

export interface AlertsListResponse {
  alerts: AlertRow[];
  unacknowledged_high_severity_count: number;
}

export interface SnoozeRequest {
  minutes: number;
}

export interface SnoozeResponse {
  ok: boolean;
  snoozed_until_ms: number;
}

export interface AcknowledgeResponse {
  ok: boolean;
  acknowledged_at_ms: number;
}

const VALID_SEVERITIES: ReadonlySet<AlertSeverity> = new Set(['INFO', 'WARN', 'LOUD']);
const VALID_DELIVERY: ReadonlySet<AlertDeliveryStatus> = new Set([
  'pending',
  'sent',
  'failed',
  'muted',
  'snoozed',
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
      const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : 200;
      const severity = q.severity && VALID_SEVERITIES.has(q.severity) ? q.severity : undefined;
      const deliveryStatus =
        q.delivery_status && VALID_DELIVERY.has(q.delivery_status) ? q.delivery_status : undefined;
      const unacknowledgedOnly = q.unacknowledged_only === 'true' || q.unacknowledged_only === '1';

      const filters: {
        since_ms?: number;
        severity?: AlertSeverity;
        delivery_status?: AlertDeliveryStatus;
        unacknowledged_only: boolean;
        limit: number;
      } = { unacknowledged_only: unacknowledgedOnly, limit };
      if (sinceMs !== undefined) filters.since_ms = sinceMs;
      if (severity !== undefined) filters.severity = severity;
      if (deliveryStatus !== undefined) filters.delivery_status = deliveryStatus;

      const [alerts, count] = await Promise.all([
        deps.alertsRepo.list(filters),
        deps.alertsRepo.countUnacknowledgedHighSeverity(),
      ]);

      return { alerts, unacknowledged_high_severity_count: count };
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
      return { ok: true, acknowledged_at_ms: now };
    },
  );

  app.post<{ Params: { id: string }; Body: SnoozeRequest }>(
    '/api/alerts/:id/snooze',
    async (req, reply): Promise<SnoozeResponse | { error: string }> => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: 'invalid alert id' });
      }
      const minutes = Number(req.body?.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        return reply.code(400).send({ error: 'minutes must be between 1 and 1440' });
      }
      const existing = await deps.alertsRepo.getById(id);
      if (!existing) {
        return reply.code(404).send({ error: 'alert not found' });
      }
      const until = Date.now() + minutes * 60_000;
      await deps.alertsRepo.snooze(id, until);
      return { ok: true, snoozed_until_ms: until };
    },
  );
}
