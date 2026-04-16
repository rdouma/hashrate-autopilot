import type { FastifyInstance } from 'fastify';

import type { RunMode } from '@braiins-hashrate/shared';

import type { HttpServerDeps } from '../server.js';
import type { UpdateRunModeBody } from '../types.js';

const VALID_MODES: ReadonlySet<RunMode> = new Set<RunMode>(['DRY_RUN', 'LIVE', 'PAUSED']);

export async function registerRunModeRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.post<{ Body: UpdateRunModeBody }>(
    '/api/run-mode',
    async (req, reply): Promise<{ run_mode: RunMode } | { error: string }> => {
      const candidate = req.body?.run_mode;
      if (!candidate || !VALID_MODES.has(candidate)) {
        reply.code(422);
        return { error: `run_mode must be one of ${[...VALID_MODES].join(', ')}` };
      }
      await deps.runtimeRepo.patch({ run_mode: candidate });
      return { run_mode: candidate };
    },
  );
}
