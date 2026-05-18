/**
 * GET /api/debug/dump
 *
 * Single-curl diagnostics endpoint. Bundles the most useful diagnostic
 * tables into one JSON response for quick triage in chat sessions.
 *
 * Query parameters:
 * - `hours` (default 24, max 168): How many hours of history to include.
 * - `tables` (optional): Comma-separated list of table names to include.
 *   Valid: tick_metrics, pool_blocks, alert_events, bid_events,
 *   reward_events, app_config, daemon_info. Omit to include all.
 *
 * Sensitive config fields (tokens, passwords) are redacted.
 * Behind the existing Basic Auth like all other /api/* routes.
 *
 * Implements #179.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../state/types.js';
import type { ConfigRepo } from '../../state/repos/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DebugDumpQuery {
  hours?: string;
  tables?: string;
}

interface DaemonInfo {
  build: number;
  git_sha: string;
  uptime_seconds: number;
  node_version: string;
  platform: string;
  run_mode: string | null;
  action_mode: string | null;
  last_tick_at: number | null;
}

interface DebugDumpResponse {
  generated_at: string;
  generated_at_ms: number;
  hours: number;
  tables_included: string[];
  tick_metrics?: unknown[];
  pool_blocks?: unknown[];
  alert_events?: unknown[];
  bid_events?: unknown[];
  reward_events?: unknown[];
  app_config?: Record<string, unknown>;
  daemon_info?: DaemonInfo;
}

// ---------------------------------------------------------------------------
// Sensitive fields to redact from config
// ---------------------------------------------------------------------------

const REDACTED_CONFIG_FIELDS = new Set([
  'telegram_bot_token',
  'telegram_chat_id',
  'ddns_credential',
  'ddns_username',
  'bitcoind_rpc_password',
  'bitcoind_rpc_user',
  'bitcoind_rpc_url',
  'block_found_sound_custom_blob',
]);

const ALL_TABLES = [
  'tick_metrics',
  'pool_blocks',
  'alert_events',
  'bid_events',
  'reward_events',
  'app_config',
  'daemon_info',
] as const;

type TableName = (typeof ALL_TABLES)[number];

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DebugDumpDeps {
  readonly db: Kysely<Database>;
  readonly configRepo: ConfigRepo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const startTimeMs = Date.now();

function getDaemonInfo(db: Kysely<Database>): DaemonInfo {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../../../..');

  let build = 0;
  try {
    build =
      parseInt(
        readFileSync(resolve(repoRoot, 'BUILD_NUMBER'), 'utf8').trim(),
        10,
      ) || 0;
  } catch {
    // packaged form
  }

  let hash = process.env['GIT_SHA']?.trim() ?? '';
  if (!hash) {
    try {
      hash = execSync('git rev-parse --short HEAD', {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim();
    } catch {
      // not a git checkout
    }
  }

  return {
    build,
    git_sha: hash ? hash.slice(0, 7) : 'dev',
    uptime_seconds: Math.round((Date.now() - startTimeMs) / 1000),
    node_version: process.version,
    platform: `${process.platform}/${process.arch}`,
    run_mode: null, // filled in from runtime_state query
    action_mode: null,
    last_tick_at: null,
  };
}

function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (REDACTED_CONFIG_FIELDS.has(key)) {
      redacted[key] = value ? '[REDACTED]' : null;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

function parseTableFilter(raw: string | undefined): Set<TableName> {
  if (!raw || raw.trim() === '') return new Set(ALL_TABLES);
  const requested = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => (ALL_TABLES as readonly string[]).includes(t)) as TableName[];
  return new Set(requested.length > 0 ? requested : ALL_TABLES);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function registerDebugDumpRoute(
  app: FastifyInstance,
  deps: DebugDumpDeps,
): Promise<void> {
  app.get<{ Querystring: DebugDumpQuery }>(
    '/api/debug/dump',
    async (req): Promise<DebugDumpResponse> => {
      const now = Date.now();

      // Parse hours (default 24, clamped to [1, 168])
      const rawHours = parseInt(req.query.hours ?? '24', 10);
      const hours = Math.max(1, Math.min(168, Number.isFinite(rawHours) ? rawHours : 24));
      const sinceMs = now - hours * 60 * 60 * 1000;

      // Parse table filter
      const tables = parseTableFilter(req.query.tables);

      const response: DebugDumpResponse = {
        generated_at: new Date(now).toISOString(),
        generated_at_ms: now,
        hours,
        tables_included: [...tables],
      };

      // tick_metrics
      if (tables.has('tick_metrics')) {
        const rows = await deps.db
          .selectFrom('tick_metrics')
          .selectAll()
          .where('tick_at', '>=', sinceMs)
          .orderBy('tick_at', 'asc')
          .execute();
        response.tick_metrics = rows;
      }

      // pool_blocks
      if (tables.has('pool_blocks')) {
        const rows = await deps.db
          .selectFrom('pool_blocks')
          .selectAll()
          .where('timestamp_ms', '>=', sinceMs)
          .orderBy('timestamp_ms', 'asc')
          .execute();
        response.pool_blocks = rows;
      }

      // alert_events (alerts table)
      if (tables.has('alert_events')) {
        const rows = await deps.db
          .selectFrom('alerts')
          .selectAll()
          .where('created_at', '>=', sinceMs)
          .orderBy('created_at', 'asc')
          .execute();
        response.alert_events = rows;
      }

      // bid_events
      if (tables.has('bid_events')) {
        const rows = await deps.db
          .selectFrom('bid_events')
          .selectAll()
          .where('occurred_at', '>=', sinceMs)
          .orderBy('occurred_at', 'asc')
          .execute();
        response.bid_events = rows;
      }

      // reward_events
      if (tables.has('reward_events')) {
        const rows = await deps.db
          .selectFrom('reward_events')
          .selectAll()
          .where('detected_at', '>=', sinceMs)
          .orderBy('detected_at', 'asc')
          .execute();
        response.reward_events = rows;
      }

      // app_config (redacted)
      if (tables.has('app_config')) {
        const config = await deps.configRepo.get();
        if (config) {
          response.app_config = redactConfig(config as unknown as Record<string, unknown>);
        } else {
          response.app_config = { error: 'config not seeded' };
        }
      }

      // daemon_info
      if (tables.has('daemon_info')) {
        const info = getDaemonInfo(deps.db);

        // Enrich with runtime_state
        const runtimeRow = await sql<{
          run_mode: string | null;
          action_mode: string | null;
          last_tick_at: number | null;
        }>`SELECT run_mode, action_mode, last_tick_at FROM runtime_state WHERE id = 1`
          .execute(deps.db)
          .then((r) => (r as unknown as { rows: Array<Record<string, unknown>> }).rows?.[0])
          .catch(() => null);

        if (runtimeRow) {
          info.run_mode = (runtimeRow as Record<string, unknown>)['run_mode'] as string | null;
          info.action_mode = (runtimeRow as Record<string, unknown>)['action_mode'] as string | null;
          info.last_tick_at = (runtimeRow as Record<string, unknown>)['last_tick_at'] as number | null;
        }

        response.daemon_info = info;
      }

      return response;
    },
  );
}
