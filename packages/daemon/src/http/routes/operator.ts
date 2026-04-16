import type { FastifyInstance } from 'fastify';

import type { HttpServerDeps } from '../server.js';

export interface UpdateOperatorAvailableBody {
  readonly available: boolean;
}

export async function registerOperatorRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.post<{ Body: UpdateOperatorAvailableBody }>(
    '/api/operator-available',
    async (req, reply): Promise<{ operator_available: boolean } | { error: string }> => {
      const value = req.body?.available;
      if (typeof value !== 'boolean') {
        reply.code(422);
        return { error: 'body must be { available: boolean }' };
      }
      await deps.runtimeRepo.patch({ operator_available: value ? 1 : 0 });
      return { operator_available: value };
    },
  );
}
