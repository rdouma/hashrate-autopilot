/**
 * Daemon entry point.
 *
 * Boots the process, loads config + secrets, and either:
 *   - Runs the operational tick loop until SIGINT/SIGTERM (normal path), or
 *   - Stands up the first-run wizard server when config/secrets are absent
 *     and transitions in-place to operational mode after the wizard
 *     submits (no external process manager required — see #57 followup
 *     for why the original "exit and let supervisor restart" approach
 *     didn't work on plain `start.sh` deployments).
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createBitcoindClient } from '@braiins-hashrate/bitcoind-client';
import { BlockVersionService } from './services/block-version.js';
import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { applyEnvOverridesToConfig } from './config/env-overrides.js';
import type { AppConfig, Secrets } from './config/schema.js';
import { loadSecretsAnySource } from './config/secret-sources.js';
import { createSetupModeServer, type SetupModeServer } from './setup-mode.js';
import { SecretsRepo } from './state/repos/secrets.js';
import { createHttpServer } from './http/server.js';
import { AccountSpendService } from './services/account-spend.js';
import { RetentionService } from './services/retention.js';
import { BtcPriceService } from './services/btc-price.js';
import { BtcPriceRefresher } from './services/btc-price-refresher.js';
import { BraiinsService } from './services/braiins-service.js';
import { DatumPoller } from './services/datum.js';
import { HashpriceCache } from './services/hashprice-cache.js';
import { HashpriceRefresher } from './services/hashprice-refresher.js';
import { createOceanClient } from './services/ocean.js';
import { PayoutObserver } from './services/payout-observer.js';
import { PoolHealthTracker } from './services/pool-health.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from './state/db.js';
import { BidEventsRepo } from './state/repos/bid_events.js';
import { ClosedBidsCacheRepo } from './state/repos/closed_bids_cache.js';
import { ConfigRepo } from './state/repos/config.js';
import { DecisionsRepo } from './state/repos/decisions.js';
import { OwnedBidsRepo } from './state/repos/owned_bids.js';
import { RuntimeStateRepo } from './state/repos/runtime_state.js';
import { TickMetricsRepo } from './state/repos/tick_metrics.js';
import { Controller } from './controller/tick.js';
import { TickLoop } from './controller/loop.js';
import type { TickResult } from './controller/tick.js';
import { cheapestAskForDepth } from './controller/orderbook.js';
import type { State } from './controller/types.js';

const DEFAULT_TICK_INTERVAL_MS = Number.parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const HTTP_PORT = Number.parseInt(process.env['HTTP_PORT'] ?? '3010', 10);
const HTTP_HOST = process.env['HTTP_HOST'] ?? '0.0.0.0';
const DASHBOARD_STATIC = process.env['DASHBOARD_STATIC'] ?? 'packages/dashboard/dist';

function defaultAgeKeyPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'] ?? `${homedir()}/.config`;
  return `${xdg}/braiins-hashrate/age.key`;
}

interface BootDeps {
  readonly handle: DatabaseHandle;
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly bidEventsRepo: BidEventsRepo;
  readonly closedBidsCacheRepo: ClosedBidsCacheRepo;
  readonly secretsRepo: SecretsRepo;
  readonly secretsPath: string;
  readonly ageKeyPath: string;
}

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const secretsPath = process.env['SECRETS_PATH'] ?? resolve(projectRoot, '.env.sops.yaml');
  const dbPath = process.env['DB_PATH'] ?? resolve(projectRoot, 'data/state.db');
  const ageKeyPath = process.env['SOPS_AGE_KEY_FILE'] ?? defaultAgeKeyPath();

  log(`starting daemon  (node ${process.version}, pid ${process.pid})`);
  log(`  secrets:  ${secretsPath}`);
  log(`  db:       ${dbPath}`);
  log(`  age key:  ${ageKeyPath}`);
  log(`  tick:     ${DEFAULT_TICK_INTERVAL_MS} ms`);

  // Open the DB first — needed in both operational and NEEDS_SETUP
  // boot paths (the wizard writes config + secrets through repos
  // backed by the same handle).
  const handle = await openDatabase({ path: dbPath });
  const deps: BootDeps = {
    handle,
    configRepo: new ConfigRepo(handle.db),
    runtimeRepo: new RuntimeStateRepo(handle.db),
    ownedBidsRepo: new OwnedBidsRepo(handle.db),
    decisionsRepo: new DecisionsRepo(handle.db),
    tickMetricsRepo: new TickMetricsRepo(handle.db),
    bidEventsRepo: new BidEventsRepo(handle.db),
    closedBidsCacheRepo: new ClosedBidsCacheRepo(handle.db),
    secretsRepo: new SecretsRepo(handle.db),
    secretsPath,
    ageKeyPath,
  };

  // Try every secret source in priority order: env > SOPS file > db.
  // Returns null if none provide a complete `Secrets`; combined with
  // a missing config row that's the NEEDS_SETUP signal.
  const secretsResult = await loadSecretsAnySource({
    sopsPath: secretsPath,
    ageKeyPath,
    secretsRepo: deps.secretsRepo,
    env: process.env,
  });
  const dbCfg = await deps.configRepo.get();

  if (!secretsResult || !dbCfg) {
    const missing: string[] = [];
    if (!secretsResult) missing.push('secrets');
    if (!dbCfg) missing.push('config');
    log(`NEEDS_SETUP — missing: ${missing.join(', ')}; serving wizard only`);
    log(
      'WARNING: setup endpoints are unauthenticated. Restrict access ' +
        '(firewall, Tailscale, Tor) until the wizard has run.',
    );

    let setupServer: SetupModeServer | null = null;
    let setupShuttingDown = false;
    const setupShutdown = async (signal: string): Promise<void> => {
      if (setupShuttingDown) return;
      setupShuttingDown = true;
      log(`received ${signal} (setup mode); closing wizard server`);
      forceExitAfter(8_000);
      try {
        await setupServer?.stop();
      } catch (err) {
        log(`setup: error stopping setup server: ${(err as Error).message}`);
      }
      try {
        await closeDatabase(deps.handle);
      } catch (err) {
        log(`setup: error closing database: ${(err as Error).message}`);
      }
      log('setup: shutdown complete');
      process.exit(0);
    };
    const setupSigint = () => void setupShutdown('SIGINT');
    const setupSigterm = () => void setupShutdown('SIGTERM');
    process.on('SIGINT', setupSigint);
    process.on('SIGTERM', setupSigterm);

    const transition = async (): Promise<void> => {
      // Wizard wrote config + secrets to db; close the wizard server
      // and boot operational without restarting the process. Polling
      // /api/health from the wizard tab observes mode flip to
      // OPERATIONAL once createHttpServer is listening on the same
      // port the setup server just released.
      log('setup: transitioning in-place to operational mode');
      // Drop the setup-mode signal handlers — bootOperational will
      // install its own. Otherwise both fire on shutdown and the
      // setup handler closes the DB out from under the operational
      // shutdown.
      process.off('SIGINT', setupSigint);
      process.off('SIGTERM', setupSigterm);
      if (setupServer) {
        try {
          await setupServer.stop();
        } catch (err) {
          log(`setup: error stopping setup server: ${(err as Error).message}`);
        }
      }
      const reloaded = await loadSecretsAnySource({
        sopsPath: secretsPath,
        ageKeyPath,
        secretsRepo: deps.secretsRepo,
        env: process.env,
      });
      const reloadedCfg = await deps.configRepo.get();
      if (!reloaded || !reloadedCfg) {
        log('FATAL: post-setup reload returned null secrets or config');
        process.exit(1);
      }
      log(`setup: reloaded secrets from ${reloaded.source}`);
      await bootOperational(deps, reloaded.secrets, reloadedCfg);
    };

    setupServer = await createSetupModeServer({
      configRepo: deps.configRepo,
      secretsRepo: deps.secretsRepo,
      staticRoot: resolve(projectRoot, DASHBOARD_STATIC),
      log,
      onSetupComplete: () => {
        // Defer briefly so the POST /api/setup response flushes
        // before we close the listener out from under it.
        setTimeout(() => {
          transition().catch((err) => {
            log(`FATAL: in-place transition failed: ${(err as Error).stack ?? err}`);
            process.exit(1);
          });
        }, 200);
      },
    });
    const addr = await setupServer.start(HTTP_PORT, HTTP_HOST);
    log(`setup server listening on ${addr}`);
    return;
  }

  log(`secrets:  loaded from ${secretsResult.source}`);
  await bootOperational(deps, secretsResult.secrets, dbCfg);
}

async function bootOperational(
  deps: BootDeps,
  secrets: Secrets,
  dbCfgIn: AppConfig,
): Promise<void> {
  const {
    handle,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
    bidEventsRepo,
    closedBidsCacheRepo,
    secretsPath,
    ageKeyPath,
  } = deps;
  let dbCfg = dbCfgIn;

  // Seed bitcoind credentials from secrets into config on first boot
  // so they become dashboard-editable (issue #14). Only runs when secrets
  // carries all three fields — the wizard no longer collects them
  // there, so wizard-driven installs typically skip this entirely.
  if (
    !dbCfg.bitcoind_rpc_url &&
    secrets.bitcoind_rpc_url &&
    secrets.bitcoind_rpc_user &&
    secrets.bitcoind_rpc_password
  ) {
    await configRepo.upsert({
      ...dbCfg,
      bitcoind_rpc_url: secrets.bitcoind_rpc_url,
      bitcoind_rpc_user: secrets.bitcoind_rpc_user,
      bitcoind_rpc_password: secrets.bitcoind_rpc_password,
    });
    dbCfg = (await configRepo.get())!;
    log('bitcoind credentials seeded from secrets into config');
  }

  // Overlay env-var overrides on top of the db config (#59). The
  // dashboard still edits the db row directly, so its view stays
  // authoritative for the operator; env-var overrides only take
  // effect on (re)boot, which matches docker-compose semantics.
  const cfg = applyEnvOverridesToConfig(dbCfg);

  log(`config:   target=${cfg.target_hashrate_ph} PH/s  floor=${cfg.minimum_floor_hashrate_ph} PH/s`);

  await runtimeRepo.initializeIfMissing();
  // boot_mode decides how run_mode is set at startup. LAST_MODE keeps whatever
  // the operator last set, demoting PAUSED to DRY_RUN (we never auto-boot into
  // PAUSED — that's only a reactive state).
  const priorRuntime = await runtimeRepo.get();
  const priorMode = priorRuntime?.run_mode ?? 'DRY_RUN';
  let bootMode: 'DRY_RUN' | 'LIVE' | 'PAUSED';
  switch (cfg.boot_mode) {
    case 'ALWAYS_LIVE':
      bootMode = 'LIVE';
      break;
    case 'LAST_MODE':
      bootMode = priorMode === 'PAUSED' ? 'DRY_RUN' : priorMode;
      break;
    case 'ALWAYS_DRY_RUN':
    default:
      bootMode = 'DRY_RUN';
      break;
  }
  await runtimeRepo.patch({ run_mode: bootMode });
  log(`run mode set to ${bootMode} on boot (boot_mode=${cfg.boot_mode}, was=${priorMode})`);

  const braiinsClient = createBraiinsClient({
    ownerToken: secrets.braiins_owner_token,
    ...(secrets.braiins_read_only_token
      ? { readOnlyToken: secrets.braiins_read_only_token }
      : {}),
  });
  const braiins = new BraiinsService({ client: braiinsClient });
  const poolTracker = new PoolHealthTracker();

  // Optional Datum Gateway stats poller (issue #19). Reads datum_api_url
  // live from config on every poll, so dashboard edits take effect on
  // the next tick without a restart. Returns null when the URL is empty,
  // which the dashboard surfaces as a "not configured" empty state.
  const datumPoller = new DatumPoller(async () => {
    const c = await configRepo.get();
    return c?.datum_api_url ?? null;
  });
  if (cfg.datum_api_url) {
    log(`datum:    polling ${cfg.datum_api_url}`);
  } else {
    log('datum:    disabled (datum_api_url empty)');
  }

  // Bitcoind client is needed for both the payout observer AND the
  // block-header version lookup that powers the BIP-110 crown
  // marker on the chart (#94). Construct once if RPC creds are
  // present, even when payout_source != 'bitcoind' - electrs-only
  // operators with bitcoind RPC creds still get the crown.
  const bitcoindRpcUrl = cfg.bitcoind_rpc_url || secrets.bitcoind_rpc_url || '';
  const bitcoindRpcUser = cfg.bitcoind_rpc_user || secrets.bitcoind_rpc_user || '';
  const bitcoindRpcPass = cfg.bitcoind_rpc_password || secrets.bitcoind_rpc_password || '';
  const bitcoindClient =
    bitcoindRpcUrl && bitcoindRpcUser && bitcoindRpcPass
      ? createBitcoindClient({ url: bitcoindRpcUrl, username: bitcoindRpcUser, password: bitcoindRpcPass })
      : null;

  let payoutObserver: PayoutObserver | null = null;
  if (cfg.payout_source !== 'none' && cfg.btc_payout_address && bitcoindClient) {
    payoutObserver = new PayoutObserver({
      client: bitcoindClient,
      getAddress: () => cfg.btc_payout_address,
      electrsHost: cfg.payout_source === 'electrs' ? cfg.electrs_host : null,
      electrsPort: cfg.payout_source === 'electrs' ? cfg.electrs_port : null,
      log: (m) => log(m),
      db: handle.db,
    });
    if (cfg.payout_source === 'electrs') {
      log(`payout: using Electrs at ${cfg.electrs_host}:${cfg.electrs_port}`);
    } else {
      log('payout: using bitcoind scantxoutset (CPU-heavy, polled hourly)');
    }
  } else {
    log('payout: disabled (payout_source=none or RPC creds missing)');
  }

  // BIP-110 crown marker (#94): block-header version lookup with a
  // persistent cache. bitcoind preferred; falls back to electrs by
  // height when bitcoind isn't available. Returns null when neither
  // is configured and the chart degrades to the standard marker.
  const blockVersionService = new BlockVersionService({
    db: handle.db,
    bitcoind: bitcoindClient,
    electrs: null, // electrs lookup added later if needed; bitcoind covers Umbrel
    log: (m) => log(m),
  });

  // Hashprice cache — read by the controller for the dynamic cap and
  // cheap-hashrate scaling. Warm path is the dashboard's finance poll;
  // a boot-time fetch below guarantees a value on tick 1 so the
  // dynamic cap doesn't silently collapse if the dashboard isn't open
  // (issue #28). Stale readings beyond HASHPRICE_STALENESS_MS are
  // treated as unknown so the cap gate refuses to price without a
  // current break-even reference.
  const hashpriceCache = new HashpriceCache();
  const HASHPRICE_STALENESS_MS = 60 * 60 * 1000;

  // Ocean stats client — shared between the tick observe path (for
  // `state.ocean_hashrate_ph`, issue #36) and the /api/ocean HTTP
  // route. The internal 60 s cache means both callers share one
  // underlying HTTP round-trip per tick instead of firing two.
  const oceanClient = createOceanClient();

  // BTC/USD oracle is constructed early so observe() can capture
  // the latest reading per tick into tick_metrics (#89). The HTTP
  // server reuses the same instance below.
  const btcPriceService = new BtcPriceService();
  // Warm the cache at boot so the very first tick's getLatest() has
  // something to return - otherwise the first row after every restart
  // writes btc_usd_price = null until the dashboard's polling thread
  // (or the operator hitting /api/btc-price) lands its first fetch
  // ~60s in.
  //
  // Strategy: try the live oracle first (fresh data is always
  // preferable). If that fails AND the most recent persisted price
  // in tick_metrics is fresh (within BOOT_FALLBACK_MAX_AGE_MS),
  // seed the cache with it - covers the case where the daemon
  // restarts during a transient oracle outage. Crucially, the age
  // gate means a long downtime (oracle was reachable at last shutdown
  // but daemon stayed off for hours/days/years) does NOT seed a
  // stale price - we'd rather write a null tick than paint an
  // outlier on the chart.
  const BOOT_FALLBACK_MAX_AGE_MS = 15 * 60_000; // 15 minutes
  void (async () => {
    const cfg = await configRepo.get();
    const source = cfg?.btc_price_source ?? 'none';
    if (source === 'none') return;
    try {
      const fresh = await btcPriceService.fetchPrice(source);
      if (fresh) return; // live fetch succeeded; cache is warm
    } catch {
      /* fall through to DB fallback */
    }
    // Live fetch failed - try the most recent persisted price as a
    // fallback, but only if it's fresh enough that using it as
    // "current" is operationally indistinguishable from the live
    // value.
    try {
      const latest = await tickMetricsRepo.latestBtcPrice();
      if (latest && Date.now() - latest.tick_at <= BOOT_FALLBACK_MAX_AGE_MS) {
        btcPriceService.seedFromPersisted(latest.usd_per_btc, latest.source, latest.tick_at);
        log(
          `[btc-price] live fetch failed at boot; seeded from persisted snapshot ${Math.round((Date.now() - latest.tick_at) / 1000)}s old (source=${latest.source})`,
        );
      } else if (latest) {
        log(
          `[btc-price] live fetch failed at boot; persisted snapshot is ${Math.round((Date.now() - latest.tick_at) / 60_000)}m old, too stale to seed (threshold ${BOOT_FALLBACK_MAX_AGE_MS / 60_000}m). First tick will write null until next live fetch succeeds.`,
        );
      }
    } catch {
      /* DB query failed; nothing more we can do at boot */
    }
  })();

  const controller = new Controller({
    braiins,
    braiinsClient,
    poolTracker,
    datumPoller,
    oceanClient,
    btcPriceService,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
    bidEventsRepo,
    now: () => Date.now(),
    getHashprice: () => hashpriceCache.getFresh(HASHPRICE_STALENESS_MS),
  });
  // Restore floor-tracking state so the escalation timer keeps counting
  // across daemon restarts (#11).
  await controller.hydrate();

  const loop = new TickLoop({
    controller,
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
    onTick: (r: TickResult) => logTick(r),
    onError: (err) => log(`[tick] error: ${(err as Error)?.message ?? err}`),
  });

  // Boot-time hashprice fetch (issue #28). When the operator has
  // configured both a payout address and the dynamic cap, seed the
  // cache from Ocean before the tick loop starts so decide()'s first
  // tick has a break-even reference available. If Ocean is down at
  // boot, we log and continue — the cap gate in decide() will block
  // trading until a later fetch succeeds, matching the operator's
  // "until hashprice is known, all trades are off" requirement.
  if (cfg.btc_payout_address && cfg.max_overpay_vs_hashprice_sat_per_eh_day) {
    try {
      const stats = await oceanClient.fetchStats(cfg.btc_payout_address);
      if (stats?.hashprice_sat_per_ph_day != null) {
        hashpriceCache.set(stats.hashprice_sat_per_ph_day);
        log(`hashprice: seeded from Ocean at boot (${stats.hashprice_sat_per_ph_day} sat/PH/day)`);
      } else {
        log('hashprice: Ocean fetched but returned no hashprice — dynamic cap gate will block trading until next fetch succeeds');
      }
    } catch (err) {
      log(`hashprice: boot fetch failed (${(err as Error)?.message ?? err}) — dynamic cap gate will block trading until next fetch succeeds`);
    }
  }

  // Keep the hashprice cache warm independently of the dashboard (issue #33).
  // The dashboard's finance poll also writes the cache, but without an
  // in-daemon refresher a headless run eventually starves it: the cache
  // goes stale past the 60-min freshness window and decide()'s dynamic-cap
  // guard silently refuses all proposals. 10-min cadence is well below
  // the freshness gate so one or two transient Ocean failures can't starve
  // the cache. Service is a no-op until the operator configures both a
  // payout address and the dynamic cap (matching the boot-time fetch).
  const hashpriceRefresher = new HashpriceRefresher(
    configRepo,
    oceanClient,
    hashpriceCache,
    { log: (m) => log(m) },
  );
  hashpriceRefresher.start();

  // Same shape as the hashprice refresher above, for the BTC/USD
  // oracle. Without it, the BtcPriceService cache was driven entirely
  // by dashboard activity (the `/api/btc-price` route was the only
  // path that called fetchPrice). When the dashboard wasn't being
  // polled - operator's laptop suspended, browser tab idle - the
  // cache went stale and observe.ts wrote the same stale value
  // every tick, producing a 2h flat BTC/USD line that lined up
  // exactly with the operator's sleep schedule.
  const btcPriceRefresher = new BtcPriceRefresher(
    configRepo,
    btcPriceService,
    { log: (m) => log(m) },
  );
  btcPriceRefresher.start();

  // Account-lifetime spend tracker — sums counters_committed.amount_consumed_sat
  // across every Braiins bid (active + historical). Terminal bids are
  // persisted in closed_bids_cache so steady-state refreshes only
  // paginate the tail, not every bid the account has ever owned.
  const accountSpend = new AccountSpendService(braiinsClient, closedBidsCacheRepo);
  // (btcPriceService constructed earlier so the controller can use it.)

  // Append-only log retention. Periodically prunes tick_metrics +
  // decisions rows older than the configured cutoffs. Runs once on
  // boot + every hour thereafter (issue #21).
  const retentionService = new RetentionService(
    configRepo,
    tickMetricsRepo,
    decisionsRepo,
    { log: (m) => log(m) },
  );
  retentionService.start();

  // HTTP server (dashboard API + static).
  const httpServer = await createHttpServer({
    controller,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
    bidEventsRepo,
    payoutObserver,
    oceanClient,
    accountSpend,
    btcPriceService,
    hashpriceCache,
    blockVersionService,
    bitcoindClient,
    secrets: {
      bitcoind_rpc_url: secrets.bitcoind_rpc_url ?? '',
      bitcoind_rpc_user: secrets.bitcoind_rpc_user ?? '',
      bitcoind_rpc_password: secrets.bitcoind_rpc_password ?? '',
    },
    db: handle.db,
    password: secrets.dashboard_password,
    tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
    secretsPath,
    ageKeyPath,
    staticRoot: DASHBOARD_STATIC,
    log: (m) => log(`[http] ${m}`),
  });
  const addr = await httpServer.start(HTTP_PORT, HTTP_HOST);
  log(`http: listening on ${addr} (dashboard password from secrets)`);

  // Shutdown wiring must precede loop.start so the first tick can be stopped.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}; draining loop`);
    // Hard force-exit fence: Docker's default stop grace is 10 s, so
    // if anything (a stuck Braiins API call inside the in-flight
    // tick, a slow http.close, etc.) doesn't return within 8 s we
    // exit anyway. The DB will have been WAL-flushed by the time
    // we got this far for any tick that completed; the worst case
    // is losing the in-flight tick's writes, which the next tick
    // would have produced anyway.
    forceExitAfter(8_000);
    payoutObserver?.stop();
    retentionService.stop();
    hashpriceRefresher.stop();
    btcPriceRefresher.stop();
    await loop.stop();
    try {
      await httpServer.stop();
    } catch (err) {
      log(`error stopping http: ${String(err)}`);
    }
    try {
      await closeDatabase(handle);
    } catch (err) {
      log(`error closing database: ${String(err)}`);
    }
    log('shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  loop.start();
  payoutObserver?.start();
  log(`daemon ready (${bootMode}). Ctrl+C to stop.`);
}

function logTick(r: TickResult): void {
  const { state, gated } = r;
  const bestAsk = fmtSat(state.market?.best_ask_sat ?? null);
  const bestBid = fmtSat(state.market?.best_bid_sat ?? null);
  const poolOk = state.pool.reachable ? 'ok' : 'DOWN';

  log(
    `tick ── ${state.run_mode}  ` +
      `mkt best_bid=${bestBid} best_ask=${bestAsk}  ` +
      `pool=${poolOk}  own=${state.owned_bids.length}  ` +
      `unknown=${state.unknown_bids.length}  ` +
      `floor_since=${state.below_floor_since ? new Date(state.below_floor_since).toISOString() : 'ok'}`,
  );

  if (gated.length === 0) {
    log(`    (no proposals — ${inferNoActionReason(state)})`);
    return;
  }
  for (const g of gated) {
    const prefix = g.allowed ? '    →' : '    ✗';
    log(`${prefix} ${describeProposal(g.proposal)}${g.allowed ? '' : `  BLOCKED:${'reason' in g ? g.reason : '?'}`}`);
  }
}

/**
 * Best-effort explanation of why `decide()` returned an empty proposal
 * set this tick. Mirrors the decision tree in decide.ts so the reason
 * shown in logs matches what actually blocked the tick. Purely for
 * diagnostics — the logic doesn't drive behaviour.
 */
function inferNoActionReason(state: State): string {
  if (!state.market) return 'no market snapshot';
  if (state.unknown_bids.length > 0) return 'unknown bids force PAUSE';
  const asks = state.market.orderbook.asks ?? [];
  if (asks.length === 0) return 'orderbook has no asks';

  const cfg = state.config;
  const fillable = cheapestAskForDepth(asks, cfg.target_hashrate_ph);
  if (fillable.price_sat === null) return 'orderbook has no open supply at any level';

  const dynamicCapConfigured = cfg.max_overpay_vs_hashprice_sat_per_eh_day !== null;
  const hashpriceSatPerEh =
    state.hashprice_sat_per_ph_day !== null ? state.hashprice_sat_per_ph_day * 1000 : null;
  if (dynamicCapConfigured && hashpriceSatPerEh === null) {
    return 'hashprice unknown/stale, dynamic-cap guard is holding trading';
  }

  const dynamicCap =
    dynamicCapConfigured && hashpriceSatPerEh !== null
      ? hashpriceSatPerEh + (cfg.max_overpay_vs_hashprice_sat_per_eh_day ?? 0)
      : null;
  const effectiveCap =
    dynamicCap !== null ? Math.min(cfg.max_bid_sat_per_eh_day, dynamicCap) : cfg.max_bid_sat_per_eh_day;

  if (state.owned_bids.length === 0) {
    return 'no owned bid yet — CREATE pending';
  }
  const primary = state.owned_bids[0]!;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  if (Math.abs(primary.price_sat - effectiveCap) < tickSize) {
    return 'bid already at effective cap — nothing to do';
  }
  return 'bid within tolerance of effective cap — nothing to do';
}

function describeProposal(p: TickResult['gated'][number]['proposal']): string {
  switch (p.kind) {
    case 'CREATE_BID':
      return `CREATE_BID  price=${fmtSat(p.price_sat)} sat/EH/day  speed=${p.speed_limit_ph} PH/s  budget=${fmtSat(p.amount_sat)} sat  (${p.reason})`;
    case 'EDIT_PRICE':
      return `EDIT_PRICE  id=${short(p.braiins_order_id)}  ${fmtSat(p.old_price_sat)} → ${fmtSat(p.new_price_sat)} sat/EH/day  (${p.reason})`;
    case 'EDIT_SPEED':
      return `EDIT_SPEED  id=${short(p.braiins_order_id)}  ${p.old_speed_limit_ph} → ${p.new_speed_limit_ph} PH/s  (${p.reason})`;
    case 'CANCEL_BID':
      return `CANCEL_BID  id=${short(p.braiins_order_id)}  (${p.reason})`;
    case 'PAUSE':
      return `PAUSE  (${p.reason})`;
  }
}

function fmtSat(n: number | null): string {
  if (n === null) return 'n/a';
  return n.toLocaleString('en-US');
}

function short(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts}  ${msg}`);
}

/**
 * Force-exit fence for graceful shutdown. If the shutdown sequence
 * doesn't `process.exit(0)` within `ms` we exit with code 124
 * (matching `timeout(1)`'s convention) — better to lose an in-flight
 * tick than get SIGKILL'd at the Docker grace boundary with the WAL
 * mid-flush. The timer is `unref`'d so it never *prevents* a clean
 * exit on its own.
 */
function forceExitAfter(ms: number): void {
  const t = setTimeout(() => {
    log(`FORCE-EXIT after ${ms} ms grace; shutdown didn't complete in time`);
    process.exit(124);
  }, ms);
  t.unref();
}

main().catch((err) => {
  console.error('daemon startup failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
