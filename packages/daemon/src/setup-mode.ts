/**
 * NEEDS_SETUP HTTP server.
 *
 * Boots a slim Fastify app exposing only what the first-run web
 * onboarding wizard (#57) needs:
 *
 *   GET  /api/health        (no auth) → `{ status, mode: 'NEEDS_SETUP' }`
 *   GET  /api/setup-info    (no auth) → defaults + any pre-existing
 *                                       config to pre-fill the form
 *   POST /api/setup         (no auth) → write config + secrets, hand
 *                                       off to operational boot
 *
 * Every other `/api/*` path returns `412 Precondition Failed` with
 * `{ needs_setup: true }` - clients see immediately that the daemon
 * isn't ready yet and can route to the wizard. Static dashboard
 * assets (and the SPA index.html fallback) are served just like in
 * operational mode so the wizard URL renders end-to-end.
 *
 * After a successful POST /api/setup, this server writes both rows
 * and invokes `onSetupComplete`. The default behaviour is an
 * in-place handoff: the daemon's main entrypoint stops this server,
 * re-loads from db, and brings the operational HTTP server up on
 * the same port - no process restart, no external supervisor
 * required. (The earlier shipped behaviour was `process.exit(0)` on
 * the assumption a process manager would relaunch us; that broke on
 * plain `start.sh` deployments where there's no supervisor.)
 *
 * Setup endpoints are intentionally unauthenticated - the dashboard
 * password is one of the values the wizard *creates*, so requiring
 * auth would be a chicken-and-egg. Operators on public networks
 * should restrict access (firewall, Tailscale, etc.) until the
 * wizard has run; the appliance platforms (Umbrel, Start9) handle
 * this naturally via Tor / LAN-only exposure.
 */

import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

import {
  AppConfigInvariantsSchema,
  APP_CONFIG_DEFAULTS,
  SecretsSchema,
} from './config/schema.js';
import type { ConfigRepo } from './state/repos/config.js';
import type { SecretsRepo } from './state/repos/secrets.js';

export interface SetupModeServerDeps {
  readonly configRepo: ConfigRepo;
  readonly secretsRepo: SecretsRepo;
  readonly staticRoot?: string | undefined;
  readonly log?: (msg: string) => void;
  /**
   * Called after a successful POST /api/setup. The daemon entrypoint
   * provides one that stops this server and hands off to operational
   * boot in-place (no process restart). The default below is a
   * fail-safe - used only when no callback is provided (e.g. tests):
   * it logs and stays running, so the test runner isn't torn down.
   */
  readonly onSetupComplete?: () => void;
}

const defaultOnSetupComplete = (log?: (msg: string) => void) => () => {
  log?.('setup: complete - no onSetupComplete handler provided; staying in setup mode');
};

const SetupRequestSchema = z.object({
  config: AppConfigInvariantsSchema,
  secrets: SecretsSchema,
});

export interface SetupModeServer {
  readonly app: FastifyInstance;
  start(port: number, host?: string): Promise<string>;
  stop(): Promise<void>;
}

export async function createSetupModeServer(
  deps: SetupModeServerDeps,
): Promise<SetupModeServer> {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  // Same CORS treatment as the operational server so the dashboard's
  // dev mode (Vite on :5173 → daemon on :3010) works end-to-end.
  await app.register(fastifyCors, { origin: true, credentials: true });

  // ---------------------------------------------------------------
  // Setup endpoints - unauthenticated.
  // ---------------------------------------------------------------

  // Public mode probe - the dashboard hits this on every page load
  // to decide between the wizard and the normal status flow, and
  // appliance hosts (Umbrel, Start9) consume it as the basic
  // liveness check (#67). Always 200 + `{ status: 'ok', mode }`.
  app.get('/api/health', async () => ({
    status: 'ok',
    mode: 'NEEDS_SETUP',
  }));

  // Bootstrap data the wizard pre-fills its form from. If config
  // already exists (re-setup after losing secrets) we surface it so
  // the operator doesn't have to re-enter every field; otherwise we
  // surface the schema defaults with two override layers:
  //   1. BHA_* env overrides (payout_source, electrs_host, etc.)
  //   2. Appliance-detected BITCOIN_RPC_* creds (#60)
  // BHA_* wins because it's the operator's explicit intent (e.g.
  // BHA_PAYOUT_SOURCE=electrs in docker-compose.yml). The bitcoind
  // detection only fills in gaps the BHA layer didn't cover.
  app.get('/api/setup-info', async () => {
    const existing = await deps.configRepo.get();
    const detected = detectBitcoindEnv(process.env);
    const env = process.env;
    const envPayoutSource = env['BHA_PAYOUT_SOURCE']?.trim() || null;
    const envElectrsHost = env['BHA_ELECTRS_HOST']?.trim() || null;
    const envElectrsPort = env['BHA_ELECTRS_PORT']?.trim() || null;
    const envDatumApiUrl = env['BHA_DATUM_API_URL']?.trim() || null;
    return {
      has_existing_config: existing !== null,
      has_existing_secrets: await deps.secretsRepo.exists(),
      defaults: {
        ...APP_CONFIG_DEFAULTS,
        destination_pool_url: 'stratum+tcp://your-public-host:23334',
        destination_pool_worker_name: '',
        btc_payout_address: '',
        bitcoind_rpc_url: detected.url ?? APP_CONFIG_DEFAULTS.bitcoind_rpc_url,
        bitcoind_rpc_user: detected.user ?? APP_CONFIG_DEFAULTS.bitcoind_rpc_user,
        bitcoind_rpc_password: detected.password ?? APP_CONFIG_DEFAULTS.bitcoind_rpc_password,
        electrs_host: envElectrsHost ?? APP_CONFIG_DEFAULTS.electrs_host,
        electrs_port: envElectrsPort ? Number(envElectrsPort) : APP_CONFIG_DEFAULTS.electrs_port,
        payout_source: envPayoutSource ?? (detected.url ? 'bitcoind' : APP_CONFIG_DEFAULTS.payout_source),
        datum_api_url: envDatumApiUrl ?? APP_CONFIG_DEFAULTS.datum_api_url,
      },
      current_config: existing,
      detected_bitcoind: detected,
    };
  });

  app.post('/api/setup', async (req, reply) => {
    const parsed = SetupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({
        error: 'invalid_setup_payload',
        details: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
      return;
    }
    const { config: parsedConfig, secrets } = parsed.data;

    // Merge env-detected values the wizard form may not have collected
    // (hidden sections, auto-configured dependencies).
    const envDatum = process.env['BHA_DATUM_API_URL']?.trim() || null;
    const detected = detectBitcoindEnv(process.env);
    const config = {
      ...parsedConfig,
      ...(envDatum && !parsedConfig.datum_api_url ? { datum_api_url: envDatum } : {}),
      ...(detected.url && !parsedConfig.bitcoind_rpc_url ? { bitcoind_rpc_url: detected.url } : {}),
      ...(detected.user && !parsedConfig.bitcoind_rpc_user ? { bitcoind_rpc_user: detected.user } : {}),
      ...(detected.password && !parsedConfig.bitcoind_rpc_password ? { bitcoind_rpc_password: detected.password } : {}),
    };

    deps.log?.('setup: writing config + secrets to db');
    await deps.configRepo.upsert(config);
    await deps.secretsRepo.upsert(secrets);

    reply.send({ ok: true });

    // Hand off to the daemon entrypoint's transition logic. The
    // entrypoint waits ~200 ms (so this response flushes) before
    // closing this server and bringing operational boot up on the
    // same port. The dashboard polls /api/health until mode flips
    // to OPERATIONAL, then redirects.
    (deps.onSetupComplete ?? defaultOnSetupComplete(deps.log))();
  });

  // ---------------------------------------------------------------
  // Catch-all: any other /api/* path returns 412 + needs_setup.
  // The static-files / SPA fallback below handles non-/api paths.
  // ---------------------------------------------------------------

  // Static assets first - Fastify serves these via fastifyStatic and
  // its built-in not-found handling routes anything else to our
  // setNotFoundHandler.
  if (deps.staticRoot) {
    try {
      await readdir(deps.staticRoot);
      await app.register(fastifyStatic, {
        root: resolve(deps.staticRoot),
        prefix: '/',
        maxAge: '1y',
        immutable: true,
        setHeaders(res, path) {
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      });
    } catch {
      deps.log?.(`dashboard static not found at ${deps.staticRoot}; setup API only`);
    }
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply
        .code(412)
        .send({ error: 'needs_setup', needs_setup: true });
      return;
    }
    // SPA fallback - let the dashboard handle the route, including
    // the /setup wizard route itself.
    reply
      .type('text/html')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .sendFile('index.html');
  });

  return {
    app,
    async start(port: number, host = '0.0.0.0'): Promise<string> {
      return app.listen({ port, host });
    },
    async stop(): Promise<void> {
      await app.close();
    },
  };
}

/**
 * Look at the process environment for the standard env-var triples
 * Umbrel and Start9 inject when an app declares a Bitcoin Knots
 * dependency. Returns whichever pieces we found - the wizard uses
 * this to prefill the bitcoind section so an operator who already
 * runs bitcoind on the same appliance doesn't have to re-enter creds.
 *
 * Both platforms use the same env var names in 2025, so a single
 * lookup covers both. We accept a pair of common synonyms for the
 * URL (`BITCOIN_RPC_URL` directly, or split `BITCOIN_RPC_HOST` +
 * `BITCOIN_RPC_PORT`) so different deployment manifests don't have
 * to rename their existing variables.
 *
 * Returns nulls (not the empty string) for missing fields so the
 * wizard can distinguish "not detected" from "detected as empty".
 */
export interface DetectedBitcoindEnv {
  readonly url: string | null;
  readonly user: string | null;
  readonly password: string | null;
}

export function detectBitcoindEnv(env: NodeJS.ProcessEnv): DetectedBitcoindEnv {
  const url =
    env['BITCOIN_RPC_URL']?.trim() ||
    (env['BITCOIN_RPC_HOST']?.trim() && env['BITCOIN_RPC_PORT']?.trim()
      ? `http://${env['BITCOIN_RPC_HOST']}:${env['BITCOIN_RPC_PORT']}`
      : '') ||
    null;
  const user = env['BITCOIN_RPC_USER']?.trim() || null;
  // Both BITCOIN_RPC_PASS and BITCOIN_RPC_PASSWORD show up in the
  // wild; accept either.
  const password =
    env['BITCOIN_RPC_PASSWORD']?.trim() || env['BITCOIN_RPC_PASS']?.trim() || null;
  return { url: url || null, user, password };
}
