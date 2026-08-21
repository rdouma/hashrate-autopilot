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

import { verifyPassword } from '../config/password-hash.js';
import fastifyCompress from '@fastify/compress';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Kysely } from 'kysely';

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { Controller } from '../controller/tick.js';
import type { AlertsRepo } from '../state/repos/alerts.js';
import type { BidEventsRepo } from '../state/repos/bid_events.js';
import type { IpChangeEventsRepo } from '../state/repos/ip_change_events.js';
import type { SystemEventsRepo } from '../state/repos/system_events.js';
import type { EventNotesRepo } from '../state/repos/event_notes.js';
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
import { registerAlertsRoutes } from './routes/alerts.js';
import { registerBidEventsRoute } from './routes/bid-events.js';
import { registerEventNotesRoutes } from './routes/event-notes.js';
import { registerIpChangesRoute } from './routes/ip-changes.js';
import { registerBuildRoute } from './routes/build.js';
import { registerBip110ScanRoute } from './routes/bip110-scan.js';
import { registerBitcoindTestRoute } from './routes/bitcoind-test.js';
import { registerElectrsTestRoute } from './routes/electrs-test.js';
import { registerBlockFoundSoundRoute } from './routes/block-found-sound.js';
import { registerBtcPriceRoute } from './routes/btc-price.js';
import { registerDiagnosticsRoute } from './routes/diagnostics.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerDecisionsRoutes } from './routes/decisions.js';
import { registerDepositsRoute } from './routes/deposits.js';
import { registerFinanceRoute } from './routes/finance.js';
import { registerMetricsRoute } from './routes/metrics.js';
import { registerNotificationsTestRoute } from './routes/notifications-test.js';
import { registerNotificationsTestEventRoute } from './routes/notifications-test-event.js';
import { registerOceanRoute } from './routes/ocean.js';
import { registerPayoutsRoute } from './routes/payouts.js';
import { registerPayoutLedgerRoute } from './routes/payout-ledger.js';
import { registerRewardEventsRoute } from './routes/reward-events.js';
import { registerRunModeRoute } from './routes/run-mode.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerStatusRoute } from './routes/status.js';
import { registerStorageEstimateRoute } from './routes/storage-estimate.js';
import { registerDdnsRoute } from './routes/ddns.js';
import { registerDdnsTestRoute } from './routes/ddns-test.js';
import { registerPoolUrlTestRoute } from './routes/pool-url-test.js';
import { registerDatumTestRoute } from './routes/datum-test.js';
import { registerStaleUrlsRoute } from './routes/stale-urls.js';
import type { BraiinsClient } from '@hashrate-autopilot/braiins-client';
import type { PublicIpService } from '../services/public-ip.js';
import type { DdnsUpdaterService } from '../services/ddns-updater.js';
import type { AxeOSPoller } from '../services/axeos-poller.js';
import type { BraiinsDepositsRepo } from '../state/repos/braiins_deposits.js';
import type { SoloMinersRepo } from '../state/repos/solo_miners.js';
import { registerSoloMinersRoute } from './routes/solo-miners.js';
import type { RewardEventsRepo } from '../state/repos/reward_events.js';
import { registerDebugDumpRoute } from './routes/debug-dump.js';

export interface HttpServerDeps {
  readonly controller: Controller;
  /** #373: churn breaker / blacklist CREATE-hold guard (resume endpoint). */
  readonly bidGuard?: import('../services/bid-guard.js').BidGuardService;
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly poolBlocksRepo: import('../state/repos/pool_blocks.js').PoolBlocksRepo;
  readonly bidEventsRepo: BidEventsRepo;
  /** #250: public-IP change events for the DDNS card + chart markers. */
  readonly ipChangeEventsRepo: IpChangeEventsRepo;
  readonly systemEventsRepo: SystemEventsRepo;
  readonly eventNotesRepo: EventNotesRepo;
  readonly alertsRepo: AlertsRepo;
  readonly payoutObserver: PayoutObserver | null;
  readonly oceanClient: OceanClient | null;
  readonly accountSpend: AccountSpendService | null;
  readonly btcPriceService: BtcPriceService;
  readonly hashpriceCache: HashpriceCache;
  /** #335: chain-tip poller for the "block height" tile. Null when no bitcoind RPC is configured (the tile hides). */
  readonly chainTipPoller: import('../services/chain-tip-poller.js').ChainTipPoller | null;
  /** #94: block-header version lookup for the BIP-110 crown marker. Optional - chart degrades to standard markers when absent. */
  readonly blockVersionService: BlockVersionService | null;
  /** #95: bitcoind RPC client for the BIP 110 scanner endpoint. Null when bitcoind RPC creds are not configured (scanner returns rpc_available: false). */
  readonly bitcoindClient: BitcoindClient | null;
  /** #111: public-IP poll service - feeds the DDNS updater and the diagnostics card. */
  readonly publicIpService: PublicIpService;
  /** #111: DDNS updater service. */
  readonly ddnsUpdater: DdnsUpdaterService;
  /** #149: solo-mining devices repository. */
  readonly soloMinersRepo: SoloMinersRepo;
  /** #179: reward_events repo for the debug dump endpoint. */
  readonly rewardEventsRepo: RewardEventsRepo;
  /** #323: Ocean earnpay payout store - source of truth for lifetime collected. */
  readonly oceanPayoutsRepo: import('../state/repos/ocean_payouts.js').OceanPayoutsRepo;
  /** #323: earnpay sync service - provides the collected status for the P&L panel. */
  readonly oceanPayoutsService: import('../services/ocean-payouts-service.js').OceanPayoutsService;
  /** #149: AxeOS poller - exposes the in-memory live snapshot used by the Solo miners card. */
  readonly axeOSPoller: AxeOSPoller;
  /** #260 follow-up: Braiins deposit history for the debug-dump endpoint. */
  readonly braiinsDepositsRepo: BraiinsDepositsRepo;
  /**
   * Fires after a successful PUT /api/config. main.ts wires this to
   * refresh the live config reference + kick the DDNS updater when
   * any DDNS-relevant field changed, so edits to provider /
   * hostname / credential propagate within a second instead of
   * waiting up to ~5 min for the next periodic ticker fire.
   */
  readonly onConfigSaved?: (
    newCfg: import('../config/schema.js').AppConfig,
    prevCfg: import('../config/schema.js').AppConfig | null,
  ) => void | Promise<void>;
  /** #113: Braiins client - used by the stale-URL cancel endpoint to call Braiins's cancelBid. */
  readonly braiinsClient: BraiinsClient;
  /** Sops/env secrets snapshot - fallback for empty `config` row fields. The BIP 110 scanner uses this to build a fresh client per request so saved Config edits take effect without a daemon restart. */
  readonly secrets: {
    readonly bitcoind_rpc_url?: string;
    readonly bitcoind_rpc_user?: string;
    readonly bitcoind_rpc_password?: string;
  };
  readonly db: Kysely<Database>;
  readonly password: string;
  /** #331: the SecretsRepo (with crypto) - used by the #332 rotation routes. */
  readonly secretsRepo: import('../state/repos/secrets.js').SecretsRepo;
  /** #332: where the running secrets came from; credential edits are only allowed for 'db'. */
  readonly secretSource: 'env' | 'sops' | 'db';
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

/**
 * Same-origin CORS policy (#358). Exported so the tests exercise the
 * policy the server actually registers rather than a re-implementation.
 *
 * A request is same-origin when the host in its `Origin` header matches
 * the `Host` it arrived on. Requests with no `Origin` (curl, scripts,
 * monitoring) get no CORS headers and are unaffected - CORS is enforced
 * by browsers, never by the server.
 */
export const sameOriginCorsDelegator =
  () =>
  (
    req: { headers: { origin?: string | undefined; host?: string | undefined } },
    cb: (err: Error | null, opts: { origin: boolean; credentials: boolean }) => void,
  ): void => {
    const origin = req.headers.origin;
    if (!origin) {
      cb(null, { origin: false, credentials: true });
      return;
    }
    let sameOrigin: boolean;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      // Malformed Origin header - treat as cross-origin.
      sameOrigin = false;
    }
    cb(null, { origin: sameOrigin, credentials: true });
  };

export async function createHttpServer(deps: HttpServerDeps): Promise<HttpServer> {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  // CORS: same-origin only (#358). Nothing legitimate is cross-origin -
  // in production Fastify serves the dashboard and the API from one
  // origin, and in dev the Vite config proxies /api server-side
  // (changeOrigin), so the browser only ever talks to Vite. The previous
  // `origin: true` reflected ANY origin and, paired with
  // `credentials: true`, told browsers that any website may make
  // credentialed calls here and read the replies. Browsers attach cached
  // HTTP-auth credentials to cross-origin fetches, so while an operator
  // had a live dashboard session another tab could drive authenticated
  // endpoints - most usefully POST /api/electrs/test, which opens a TCP
  // connection to an arbitrary host:port and is thus a scanner for the
  // daemon's network (CodeQL js/request-forgery).
  //
  // Matching on Host rather than an allowlist is deliberate: operators
  // reach the dashboard on a LAN IP, a .local name, a dynamic-DNS
  // hostname, a VPN address or through a reverse proxy, and all of those
  // are same-origin with the page that issued the request. Requests with
  // no Origin header (curl, scripts, monitoring) are untouched - CORS is
  // a browser mechanism and never gated them.
  await app.register(fastifyCors, sameOriginCorsDelegator);

  // Response compression. /api/metrics returns up to multi-MB JSON
  // bodies re-polled every minute; on a remote/Umbrel link the
  // transfer dominates chart latency. JSON compresses ~10x. Small
  // bodies skip compression (threshold) so cheap endpoints don't pay
  // CPU for nothing.
  await app.register(fastifyCompress, {
    global: true,
    threshold: 2048,
    encodings: ['gzip', 'deflate'],
  });

  // #331: `deps.password` may be a scrypt hash (DB-sourced) or plaintext
  // (env / SOPS). verifyPassword handles both. scrypt is deliberately
  // slow, so cache the verdict per presented credential - only one value
  // is ever valid, so the cache stays tiny.
  const authCache = new Map<string, boolean>();
  // #332: the dashboard password can be changed live via /api/security.
  // Keep it in a mutable holder so a change takes effect on the next
  // request (and the old one stops immediately). Clearing the cache is
  // what boots any session still presenting the old password.
  let currentPassword = deps.password;
  const setDashboardPassword = (hashedOrPlain: string): void => {
    currentPassword = hashedOrPlain;
    authCache.clear();
  };
  await app.register(fastifyBasicAuth, {
    validate: async (_username, password) => {
      let ok = authCache.get(password);
      if (ok === undefined) {
        ok = verifyPassword(password, currentPassword);
        // Bound the cache defensively against a brute-force flood that
        // slips past the rate limiter.
        if (authCache.size > 64) authCache.clear();
        authCache.set(password, ok);
      }
      if (!ok) {
        throw new Error('unauthorised');
      }
    },
    // No `authenticate` option - we don't want the WWW-Authenticate
    // header in 401 responses. That header triggers the browser's
    // native auth dialog, which conflicts with our React login page.
  });

  // Per-IP rate limiting. Runs before auth to throttle brute-force
  // credential guessing. 300/min accommodates rapid chart zoom (each
  // step settles into a metrics fetch after 200ms debounce).
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();
  const RATE_WINDOW_MS = 60_000;
  const RATE_LIMIT = 300;
  let lastRatePrune = Date.now();
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url.startsWith('/api/')) return done();
    const ip = req.ip;
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > RATE_LIMIT) {
      reply.code(429).send({ error: 'too many requests' });
      return;
    }
    if (now - lastRatePrune > RATE_WINDOW_MS) {
      lastRatePrune = now;
      for (const [k, v] of rateBuckets) {
        if (now >= v.resetAt) rateBuckets.delete(k);
      }
    }
    done();
  });

  // Guard all /api/* routes with Basic Auth. basicAuth expects the
  // callback-style Fastify middleware signature (req, reply, done).
  // /api/health is exempt - appliance hosts (Umbrel, Start9, #67) and
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

  await registerBuildRoute(app);
  await registerStatusRoute(app, deps);
  await registerDecisionsRoutes(app, deps);
  await registerConfigRoutes(app, deps);
  // #332: in-app credential rotation (password + Braiins tokens).
  await registerSecurityRoutes(app, {
    secretsRepo: deps.secretsRepo,
    secretSource: deps.secretSource,
    getCurrentPassword: () => currentPassword,
    setDashboardPassword,
    ...(deps.log ? { log: deps.log } : {}),
  });
  await registerRunModeRoute(app, deps);
  await registerActionRoutes(app, deps);
  await registerMetricsRoute(app, deps);
  await registerBidEventsRoute(app, deps);
  await registerEventNotesRoutes(app, deps);
  await registerIpChangesRoute(app, deps);
  await registerBip110ScanRoute(app, { configRepo: deps.configRepo, secrets: deps.secrets });
  await registerBitcoindTestRoute(app);
  await registerElectrsTestRoute(app);
  await registerAlertsRoutes(app, {
    alertsRepo: deps.alertsRepo,
    configRepo: deps.configRepo,
  });
  await registerNotificationsTestRoute(app);
  await registerNotificationsTestEventRoute(app, { configRepo: deps.configRepo });
  await registerPayoutsRoute(app, { payoutObserver: deps.payoutObserver });
  await registerStatsRoute(app, { db: deps.db, bidEventsDb: deps.db });
  await registerStorageEstimateRoute(app, { db: deps.db });
  await registerRewardEventsRoute(app, { db: deps.db });
  // #323: earnpay-sourced payout gems for the Price chart (on-chain + Lightning).
  await registerPayoutLedgerRoute(app, {
    oceanPayoutsRepo: deps.oceanPayoutsRepo,
    configRepo: deps.configRepo,
  });
  await registerDepositsRoute(app, { db: deps.db });
  await registerBlockFoundSoundRoute(app, { db: deps.db });
  await registerOceanRoute(app, {
    oceanClient: deps.oceanClient,
    configRepo: deps.configRepo,
    tickMetricsRepo: deps.tickMetricsRepo,
    poolBlocksRepo: deps.poolBlocksRepo,
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
    oceanPayoutsRepo: deps.oceanPayoutsRepo,
    oceanPayoutsService: deps.oceanPayoutsService,
    rewardEventsRepo: deps.rewardEventsRepo,
  });
  await registerBtcPriceRoute(app, {
    btcPriceService: deps.btcPriceService,
    configRepo: deps.configRepo,
  });
  // #272: one-shot support bundle (connectivity matrix + sanitized config).
  await registerDiagnosticsRoute(app, {
    configRepo: deps.configRepo,
    runtimeRepo: deps.runtimeRepo,
    braiinsClient: deps.braiinsClient,
    bitcoindClient: deps.bitcoindClient,
    btcPriceService: deps.btcPriceService,
    db: deps.db,
    tickIntervalMs: deps.tickIntervalMs,
  });
  await registerDdnsRoute(app, {
    configRepo: deps.configRepo,
    publicIpService: deps.publicIpService,
    ddnsUpdater: deps.ddnsUpdater,
    ipChangeEventsRepo: deps.ipChangeEventsRepo,
  });
  await registerDdnsTestRoute(app, {
    ddnsUpdater: deps.ddnsUpdater,
    publicIpService: deps.publicIpService,
  });
  await registerPoolUrlTestRoute(app);
  await registerDatumTestRoute(app);
  await registerStaleUrlsRoute(app, {
    configRepo: deps.configRepo,
    ownedBidsRepo: deps.ownedBidsRepo,
    braiinsClient: deps.braiinsClient,
  });
  await registerSoloMinersRoute(app, {
    soloMinersRepo: deps.soloMinersRepo,
    axeOSPoller: deps.axeOSPoller,
  });
  await registerDebugDumpRoute(app, {
    configRepo: deps.configRepo,
    tickMetricsRepo: deps.tickMetricsRepo,
    poolBlocksRepo: deps.poolBlocksRepo,
    alertsRepo: deps.alertsRepo,
    bidEventsRepo: deps.bidEventsRepo,
    rewardEventsRepo: deps.rewardEventsRepo,
    runtimeRepo: deps.runtimeRepo,
    soloMinersRepo: deps.soloMinersRepo,
    axeOSPoller: deps.axeOSPoller,
    ownedBidsRepo: deps.ownedBidsRepo,
    decisionsRepo: deps.decisionsRepo,
    ipChangeEventsRepo: deps.ipChangeEventsRepo,
    braiinsDepositsRepo: deps.braiinsDepositsRepo,
  });

  // Serve built dashboard if present.
  if (deps.staticRoot) {
    try {
      await readdir(deps.staticRoot);
      await app.register(fastifyStatic, {
        root: resolve(deps.staticRoot),
        prefix: '/',
        // Hashed asset files (index-XXXXX.js/css) are safe to cache long.
        // HTML is NOT - a stale index.html points at outdated bundle
        // hashes and perma-breaks the dashboard on rebuild.
        maxAge: '1y',
        immutable: true,
        // @fastify/static v10 hands the setHeaders callback a FastifyReply
        // (was the raw ServerResponse in v9), so use reply.header(), not
        // res.setHeader().
        setHeaders(reply, path) {
          if (path.endsWith('.html')) {
            reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      });
      // @fastify/static's `immutable: true` wins over the per-file
      // `setHeaders` override above (and over the explicit header on
      // the SPA fallback below): empirically every HTML response still
      // went out as `max-age=31536000, immutable`. A browser that
      // loaded the dashboard once then cached index.html for a YEAR
      // never sees a new build - it keeps requesting the old hashed
      // bundle and silently runs stale code, so shipped fixes look
      // like they "did nothing" until a manual hard-refresh. onSend is
      // the last hook before the response flushes, so it's the
      // authoritative override: force-revalidate every HTML document
      // while leaving the content-hashed /assets/* immutable.
      app.addHook('onSend', (_req, reply, payload, done) => {
        const ct = reply.getHeader('content-type');
        if (typeof ct === 'string' && ct.includes('text/html')) {
          reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        done(null, payload);
      });
      app.setNotFoundHandler((_req, reply) => {
        // SPA fallback: any unknown path returns index.html, uncached
        // (the onSend hook above enforces the no-cache on the way out).
        reply
          .type('text/html')
          .header('Cache-Control', 'no-cache, no-store, must-revalidate')
          .sendFile('index.html');
      });
    } catch {
      // Static dir missing - run the API without the UI (dev mode).
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
