/**
 * #149: HTTP routes for the operator's solo-mining device list and
 * the daemon's live snapshot of their AxeOS readings.
 *
 *   GET    /api/solo-miners            - device list + live snapshot
 *   POST   /api/solo-miners            - create a device
 *   PUT    /api/solo-miners/:id        - update an existing device
 *   DELETE /api/solo-miners/:id        - remove a device (cascades samples)
 *
 * The live snapshot is read from the in-memory `AxeOSPoller`, not
 * SQLite, so the Status card paints fresh values without a DB
 * round-trip - matching the pattern of the rest of the metric
 * surfaces (BTC oracle, DDNS, etc.). When `solo_mining_enabled` is
 * off the snapshot is `enabled: false, entries: []` regardless of
 * what's in the `solo_miners` table.
 */

import type { FastifyInstance } from 'fastify';

import type { AxeOSPoller, SoloMinerSnapshot } from '../../services/axeos-poller.js';
import { AxeOSScanner } from '../../services/axeos-scanner.js';
import type { SoloMinerRow, SoloMinersRepo } from '../../state/repos/solo_miners.js';

export interface SoloMinersDeps {
  readonly soloMinersRepo: SoloMinersRepo;
  readonly axeOSPoller: AxeOSPoller;
}

export interface SoloMinersListResponse {
  readonly devices: ReadonlyArray<SoloMinerRow>;
  readonly snapshot: SoloMinerSnapshot;
}

export interface CreateBody {
  label?: string;
  ip?: string;
  enabled?: boolean;
}

export interface UpdateBody {
  label?: string;
  ip?: string;
  enabled?: boolean;
  sort_order?: number;
}

// Permissive IP-or-hostname pattern. We don't enforce strict IPv4
// format because operators sometimes use a router-resolved hostname
// (`bitaxe-bedroom.local`) or an IPv6 literal. The AxeOS client
// will fail cleanly on a bogus value and the device will surface
// as unreachable.
const HOST_RE = /^[A-Za-z0-9.:_-]+$/;

export async function registerSoloMinersRoute(
  app: FastifyInstance,
  deps: SoloMinersDeps,
): Promise<void> {
  app.get('/api/solo-miners', async (): Promise<SoloMinersListResponse> => {
    const devices = await deps.soloMinersRepo.list();
    const snapshot = deps.axeOSPoller.getSnapshot();
    return { devices, snapshot };
  });

  app.post<{ Body?: CreateBody }>('/api/solo-miners', async (req, reply) => {
    const body = req.body ?? {};
    const label = (body.label ?? '').trim();
    const ip = (body.ip ?? '').trim();
    if (!label) {
      reply.code(400);
      return { ok: false, error: 'label is required' };
    }
    if (!ip || !HOST_RE.test(ip)) {
      reply.code(400);
      return { ok: false, error: 'ip must be an IPv4/IPv6 address or hostname' };
    }
    try {
      const created = await deps.soloMinersRepo.create({
        label,
        ip,
        enabled: body.enabled ?? true,
      });
      return { ok: true, device: created };
    } catch (e) {
      // UNIQUE(ip) collision is the most likely failure.
      reply.code(409);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  app.put<{ Body?: UpdateBody; Params: { id: string } }>(
    '/api/solo-miners/:id',
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        reply.code(400);
        return { ok: false, error: 'id must be a positive integer' };
      }
      const body = req.body ?? {};
      const patch: UpdateBody = {};
      if (body.label !== undefined) {
        const trimmed = body.label.trim();
        if (!trimmed) {
          reply.code(400);
          return { ok: false, error: 'label cannot be empty' };
        }
        patch.label = trimmed;
      }
      if (body.ip !== undefined) {
        const trimmed = body.ip.trim();
        if (!trimmed || !HOST_RE.test(trimmed)) {
          reply.code(400);
          return { ok: false, error: 'ip must be an IPv4/IPv6 address or hostname' };
        }
        patch.ip = trimmed;
      }
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.sort_order !== undefined) patch.sort_order = body.sort_order;

      try {
        const updated = await deps.soloMinersRepo.update(id, patch);
        if (!updated) {
          reply.code(404);
          return { ok: false, error: `no solo miner with id ${id}` };
        }
        return { ok: true, device: updated };
      } catch (e) {
        reply.code(409);
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/solo-miners/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400);
      return { ok: false, error: 'id must be a positive integer' };
    }
    await deps.soloMinersRepo.delete(id);
    return { ok: true };
  });

  // GET /api/solo-miners/series?since=<ms> - per-tick aggregated
  // series for the chart right-axis options. Returns one row per
  // tick_at with summed hashrate (GH/s), summed power (W), max
  // temperature (°C) across {temp_c, vr_temp_c}, and the active
  // device count. Default `since` (param missing or non-numeric) =
  // now() - 24h. `since=0` is honored as "everything" - the
  // dashboard's "All" chart range sends 0 to mean since-the-dawn-of-time.
  app.get<{ Querystring: { since?: string } }>(
    '/api/solo-miners/series',
    async (req) => {
      const sinceRaw = Number.parseInt(req.query.since ?? '', 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw >= 0
        ? sinceRaw
        : Date.now() - 24 * 60 * 60 * 1000;
      const rows = await deps.soloMinersRepo.fleetSeriesSince(since);
      return { rows };
    },
  );

  // GET /api/solo-miners/best-diff-events?since=<ms> - record-breaking
  // best difficulty events for chart trophy markers. Same `since=0`
  // semantics as /series above.
  app.get<{ Querystring: { since?: string } }>(
    '/api/solo-miners/best-diff-events',
    async (req) => {
      const sinceRaw = Number.parseInt(req.query.since ?? '', 10);
      const since = Number.isFinite(sinceRaw) && sinceRaw >= 0
        ? sinceRaw
        : Date.now() - 24 * 60 * 60 * 1000;
      const events = await deps.soloMinersRepo.bestDiffEventsSince(since);
      return { events };
    },
  );

  // /24 scan for AxeOS-shaped responders.
  //
  // POST /api/solo-miners/scan - kicks off a background sweep at
  //   concurrency 8 with a 1500ms per-IP timeout. Returns immediately
  //   with the initial status. 409 if a scan is already running.
  //   Optional body: { cidr } - operator-supplied /24 override. Needed
  //   on Umbrel where the daemon container sees the docker bridge
  //   subnet, not the host LAN where the Bitaxes actually live (#156).
  // GET /api/solo-miners/scan/status - current scan state for the
  //   dashboard's progress-bar poll. {state, cidr, done, total,
  //   candidates, error, started_at, finished_at}.
  //
  // Two-step (kick-off + poll status) so the dashboard can show a
  // progress bar and stream candidate discoveries as they happen
  // instead of blocking on a single 30-60s request - previous one-shot
  // implementation was the source of the empty-result intermittency
  // operators saw on Umbrel.
  const scanner = new AxeOSScanner({ repo: deps.soloMinersRepo });
  app.post<{ Body?: { cidr?: string } }>(
    '/api/solo-miners/scan',
    async (req, reply) => {
      const cidr = typeof req.body?.cidr === 'string' ? req.body.cidr : undefined;
      const result = scanner.start(cidr);
      if (!result.ok && result.error === 'scan already in progress') {
        reply.code(409);
      }
      return result;
    },
  );
  app.get('/api/solo-miners/scan/status', async () => {
    return scanner.getStatus();
  });
}
