import type { FastifyInstance } from 'fastify';

import { AppConfigInvariantsSchema, type AppConfig } from '../../config/schema.js';
import type { HttpServerDeps } from '../server.js';
import type { ConfigResponse } from '../types.js';

export async function registerConfigRoutes(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get('/api/config', async (_req, reply): Promise<ConfigResponse | { error: string }> => {
    const config = await deps.configRepo.get();
    if (!config) {
      reply.code(503);
      return { error: 'config not seeded - run setup CLI' };
    }
    return { config };
  });

  app.put<{ Body: AppConfig }>(
    '/api/config',
    async (req, reply): Promise<ConfigResponse | { error: string; details?: string }> => {
      const parsed = AppConfigInvariantsSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422);
        return {
          error: 'schema validation failed',
          details: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('\n'),
        };
      }
      // Snapshot the previous config BEFORE upsert so the
      // onConfigSaved callback can diff and decide what to kick
      // (e.g. DDNS updater on hostname/credential change).
      const prev = await deps.configRepo.get().catch(() => null);
      await deps.configRepo.upsert(parsed.data);
      if (deps.onConfigSaved) {
        // Best-effort - don't fail the save if a side-effect throws,
        // but log the error so an "I saved config but DDNS didn't
        // move" report is correlatable against the daemon log.
        try {
          await deps.onConfigSaved(parsed.data, prev);
        } catch (err) {
          deps.log?.(
            `[config] onConfigSaved threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return { config: parsed.data };
    },
  );
}
