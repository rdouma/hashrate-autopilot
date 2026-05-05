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

import type { BitcoindClient } from '@braiins-hashrate/bitcoind-client';

import type { Controller } from '../controller/tick.js';
import type { BidEventsRepo } from '../state/repos/bid_events.js';
import type { ConfigRepo } from '../state/repos/config.js';
import type { DecisionsRepo } from '../state/repos/decisions.js';
import type { OwnedBidsRepo } from '../state/repos/owned_bids.js';
import type { RuntimeStateRepo } from '../state/repos/runtime_state.js';
import type { TickMetricsRepo } from '../state/repos/tick_metrics.js';
import type { Database } from '../state/types.js';
import type { AccountSpendService } from '../services/account-spend.js';
import type { BlockVersionService } from '../services/block-version.js';
import type { BtcPriceService } from '../services/btc-price.js';
import type { HashpriceCache } from '../services/hashprice-cache.js';
import type { OceanClient } from '../services/ocean.js';
import type { PayoutObserver } from '../services/payout-observer.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerBidEventsRoute } from './routes/bid-events.js';
import { registerBip110ScanRoute } from './routes/bip110-scan.js';
import { registerBitcoindTestRoute } from './routes/bitcoind-test.js';
import { registerBlockFoundSoundRoute } from './routes/block-found-sound.js';
import { registerBtcPriceRoute } from './routes/btc-price.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerDecisionsRoutes } from './routes/decisions.js';
import { registerFinanceRoute } from './routes/finance.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerOceanRoute } from './routes/ocean.js';
import { registerOperatorRoutes } from './routes/operator.js';
import { registerPayoutsRoute } from './routes/payouts.js';
import { registerRewardEventsRoute } from './routes/reward-events.js';
import { registerRunModeRoute } from './routes/run-mode.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerStatusRoute } from './routes/status.js';
import { registerStorageEstimateRoute } from './routes/storage-estimate.js';

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
  /** #94: block-header version lookup for the BIP-110 crown marker. Optional - chart degrades to standard markers when absent. */
  readonly blockVersionService: BlockVersionService | null;
  /** #95: bitcoind RPC client for the BIP 110 scanner endpoint. Null when bitcoind RPC creds are not configured (scanner returns rpc_available: false). */
  readonly bitcoindClient: BitcoindClient | null;
  /** Sops/env secrets snapshot — fallback for empty `config` row fields. The BIP 110 scanner uses this to build a fresh client per request so saved Config edits take effect without a daemon restart. */
  readonly secrets: {
    readonly bitcoind_rpc_url?: string;
    readonly bitcoind_rpc_user?: string;
    readonly bitcoind_rpc_password?: string;
  };
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
  // /api/health is exempt — appliance hosts (Umbrel, Start9, #67) and
  // the dashboard's mode probe both need to reach it without creds.
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url.startsWith('/api/')) return done();
    if (req.url.startsWith('/api/health')) return done();
    app.basicAuth(req, reply, done);
  });

  // Public health + mode probe (#67 + #57 wizard detection). Mirrored
  // by the NEEDS_SETUP server so the same URL works in both daemon
  // boot phases.
  app.get('/api/health', async () => ({ status: 'ok', mode: 'OPERATIONAL' }));

  await registerStatusRoute(app, deps);
  await registerDecisionsRoutes(app, deps);
  await registerConfigRoutes(app, deps);
  await registerRunModeRoute(app, deps);
  await registerOperatorRoutes(app, deps);
  await registerActionRoutes(app, deps);
  await registerMetricsRoute(app, deps);
  await registerBidEventsRoute(app, deps);
  await registerBip110ScanRoute(app, { configRepo: deps.configRepo, secrets: deps.secrets });
  await registerBitcoindTestRoute(app);
  await registerPayoutsRoute(app, { payoutObserver: deps.payoutObserver });
  await registerStatsRoute(app, { db: deps.db, bidEventsDb: deps.db });
  await registerStorageEstimateRoute(app, { db: deps.db });
  await registerRewardEventsRoute(app, { db: deps.db });
  await registerBlockFoundSoundRoute(app, { db: deps.db });
  await registerOceanRoute(app, {
    oceanClient: deps.oceanClient,
    configRepo: deps.configRepo,
    tickMetricsRepo: deps.tickMetricsRepo,
    blockVersionService: deps.blockVersionService,
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
