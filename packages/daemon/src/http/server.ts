/**
 * HTTP server for the dashboard.
 *
 * - Fastify + Basic Auth (password from secrets.dashboard_password).
 * - Routes under `/api/*` for data + control.
 * - In production also serves the built dashboard from `<dist>/public`.
 *
 * Deliberately single-process with the control loop (architecture §3): the
 * same Node process owns SQLite writes, so sharing it with an HTTP server
 * avoids coordination headaches.
 */

import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Kysely } from 'kysely';

import type { Controller } from '../controller/tick.js';
import type { BidEventsRepo } from '../state/repos/bid_events.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { DecisionsRepo } from '../state/repos/decisions.js';
import type { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import type { Database } from '../state/types.js';
import type { AccountSpendService } from '../services/account-spend.js';
import type { BtcPriceService } from '../services/btc-price.js';
import type { HashpriceCache } from '../services/hashprice-cache.js';
import type { OceanClient } from '../services/ocean.js';
import type { PayoutObserver } from '../services/payout-observer.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerBidEventsRoute } from './routes/bid-events.js';
import { registerBtcPriceRoute } from './routes/btc-price.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerDecisionsRoutes } from './routes/decisions.js';
import { registerFinanceRoute } from './routes/finance.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerOceanRoute } from './routes/ocean.js';
import { registerOperatorRoutes } from './routes/operator.js';
import { registerPayoutsRoute } from './routes/payouts.js';
import { registerRunModeRoute } from './routes/run-mode.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerSimulateRoute } from './routes/simulate.js';
import { registerStatusRoute } from './routes/status.js';

export interface HttpServerDeps {
  readonly controller: Controller;
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly bidEventsRepo: BidEventsRepo;
  readonly payoutObserver: PayoutObserver | null;
  readonly oceanClient: OceanClient | null;
  readonly accountSpend: AccountSpendService | null;
  readonly btcPriceService: BtcPriceService;
  readonly hashpriceCache: HashpriceCache;
  readonly db: Kysely<Database>;
  readonly password: string;
  readonly tickIntervalMs: number;
  readonly secretsPath: string;
  readonly ageKeyPath: string;
  readonly staticRoot?: string | undefined;
  readonly log?: (msg: string) => void;
}

export interface HttpServer {
  readonly app: FastifyInstance;
  start(port: number, host?: string): Promise<string>;
  stop(): Promise<void>;
}

export async function createHttpServer(deps: HttpServerDeps): Promise<HttpServer> {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  // CORS only matters for dev: dashboard Vite dev server on :5173 calling
  // daemon on :3000. In prod they're same-origin.
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyBasicAuth, {
    validate: async (_username, password) => {
      if (password !== deps.password) {
        throw new Error('unauthorised');
      }
    },
    // No `authenticate` option — we don't want the WWW-Authenticate
    // header in 401 responses. That header triggers the browser's
    // native auth dialog, which conflicts with our React login page.
  });

  // Guard all /api/* routes with Basic Auth. basicAuth expects the
  // callback-style Fastify middleware signature (req, reply, done).
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url.startsWith('/api/')) return done();
    app.basicAuth(req, reply, done);
  });

  await registerStatusRoute(app, deps);
  await registerDecisionsRoutes(app, deps);
  await registerConfigRoutes(app, deps);
  await registerRunModeRoute(app, deps);
  await registerOperatorRoutes(app, deps);
  await registerActionRoutes(app, deps);
  await registerMetricsRoute(app, deps);
  await registerBidEventsRoute(app, deps);
  await registerPayoutsRoute(app, { payoutObserver: deps.payoutObserver });
  await registerStatsRoute(app, { db: deps.db, bidEventsDb: deps.db });
  await registerSimulateRoute(app, { db: deps.db });
  await registerOceanRoute(app, {
    oceanClient: deps.oceanClient,
    configRepo: deps.configRepo,
  });
  await registerFinanceRoute(app, {
    ownedBidsRepo: deps.ownedBidsRepo,
    configRepo: deps.configRepo,
    payoutObserver: deps.payoutObserver,
    oceanClient: deps.oceanClient,
    accountSpend: deps.accountSpend,
    hashpriceCache: deps.hashpriceCache,
    tickMetricsRepo: deps.tickMetricsRepo,
  });
  await registerBtcPriceRoute(app, {
    btcPriceService: deps.btcPriceService,
    configRepo: deps.configRepo,
  });

  // Serve built dashboard if present.
  if (deps.staticRoot) {
    try {
      await readdir(deps.staticRoot);
      await app.register(fastifyStatic, {
        root: resolve(deps.staticRoot),
        prefix: '/',
        // Hashed asset files (index-XXXXX.js/css) are safe to cache long.
        // HTML is NOT — a stale index.html points at outdated bundle
        // hashes and perma-breaks the dashboard on rebuild.
        maxAge: '1y',
        immutable: true,
        setHeaders(res, path) {
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      });
      app.setNotFoundHandler((_req, reply) => {
        // SPA fallback: any unknown path returns index.html, uncached.
        reply
          .type('text/html')
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .sendFile('index.html');
      });
    } catch {
      // Static dir missing — run the API without the UI (dev mode).
      deps.log?.(`dashboard static not found at ${deps.staticRoot}; API-only`);
    }
  }

  return {
    app,
    async start(port: number, host = '0.0.0.0'): Promise<string> {
      const addr = await app.listen({ port, host });
      return addr;
    },
    async stop(): Promise<void> {
      await app.close();
    },
  };
}
