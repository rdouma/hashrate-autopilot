/**
 * Daemon entry point.
 *
 * Boots the process, loads config + secrets, constructs the controller
 * with all its dependencies, and runs the observe→decide→gate→execute
 * tick loop until SIGINT / SIGTERM.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createBitcoindClient } from '@braiins-hashrate/bitcoind-client';
import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { loadSecrets } from './config/secrets.js';
import { createHttpServer } from './http/server.js';
import { AccountSpendService } from './services/account-spend.js';
import { RetentionService } from './services/retention.js';
import { BtcPriceService } from './services/btc-price.js';
import { BraiinsService } from './services/braiins-service.js';
import { DatumPoller } from './services/datum.js';
import { HashpriceCache } from './services/hashprice-cache.js';
import { createOceanClient } from './services/ocean.js';
import { PayoutObserver } from './services/payout-observer.js';
import { PoolHealthTracker } from './services/pool-health.js';
import { closeDatabase, openDatabase } from './state/db.js';
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

const DEFAULT_TICK_INTERVAL_MS = Number.parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const HTTP_PORT = Number.parseInt(process.env['HTTP_PORT'] ?? '3010', 10);
const HTTP_HOST = process.env['HTTP_HOST'] ?? '0.0.0.0';
const DASHBOARD_STATIC = process.env['DASHBOARD_STATIC'] ?? 'packages/dashboard/dist';

function defaultAgeKeyPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'] ?? `${homedir()}/.config`;
  return `${xdg}/braiins-hashrate/age.key`;
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

  // Fail-closed on config problems.
  const secrets = await loadSecrets(secretsPath, {
    env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyPath },
  });

  const handle = await openDatabase({ path: dbPath });
  const configRepo = new ConfigRepo(handle.db);
  const runtimeRepo = new RuntimeStateRepo(handle.db);
  const ownedBidsRepo = new OwnedBidsRepo(handle.db);
  const decisionsRepo = new DecisionsRepo(handle.db);
  const tickMetricsRepo = new TickMetricsRepo(handle.db);
  const bidEventsRepo = new BidEventsRepo(handle.db);
  const closedBidsCacheRepo = new ClosedBidsCacheRepo(handle.db);

  let cfg = await configRepo.get();
  if (!cfg) throw new Error('config row missing — run `pnpm -w run setup` first');

  // Seed bitcoind credentials from secrets into config on first boot
  // so they become dashboard-editable (issue #14).
  if (!cfg.bitcoind_rpc_url && secrets.bitcoind_rpc_url) {
    await configRepo.upsert({
      ...cfg,
      bitcoind_rpc_url: secrets.bitcoind_rpc_url,
      bitcoind_rpc_user: secrets.bitcoind_rpc_user,
      bitcoind_rpc_password: secrets.bitcoind_rpc_password,
    });
    cfg = (await configRepo.get())!;
    log('bitcoind credentials seeded from secrets into config');
  }

  // payout_source auto-detection moved to migration 0022 (runs once).
  // No per-boot override — operator's choice sticks.

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

  let payoutObserver: PayoutObserver | null = null;
  if (cfg.payout_source !== 'none' && cfg.btc_payout_address) {
    const rpcUrl = cfg.bitcoind_rpc_url || secrets.bitcoind_rpc_url;
    const rpcUser = cfg.bitcoind_rpc_user || secrets.bitcoind_rpc_user;
    const rpcPass = cfg.bitcoind_rpc_password || secrets.bitcoind_rpc_password;
    const bitcoindClient = createBitcoindClient({
      url: rpcUrl,
      username: rpcUser,
      password: rpcPass,
    });
    payoutObserver = new PayoutObserver({
      client: bitcoindClient,
      getAddress: () => cfg.btc_payout_address,
      electrsHost: cfg.payout_source === 'electrs' ? cfg.electrs_host : null,
      electrsPort: cfg.payout_source === 'electrs' ? cfg.electrs_port : null,
      log: (m) => log(m),
    });
    if (cfg.payout_source === 'electrs') {
      log(`payout: using Electrs at ${cfg.electrs_host}:${cfg.electrs_port}`);
    } else {
      log('payout: using bitcoind scantxoutset (CPU-heavy, polled hourly)');
    }
  } else {
    log('payout: disabled (payout_source=none)');
  }

  // Hashprice cache — read by the controller for the dynamic cap and
  // cheap-hashrate scaling. Warm path is the dashboard's finance poll;
  // a boot-time fetch below guarantees a value on tick 1 so the
  // dynamic cap doesn't silently collapse if the dashboard isn't open
  // (issue #28). Stale readings beyond HASHPRICE_STALENESS_MS are
  // treated as unknown so the cap gate refuses to price without a
  // current break-even reference.
  const hashpriceCache = new HashpriceCache();
  const HASHPRICE_STALENESS_MS = 60 * 60 * 1000;

  const controller = new Controller({
    braiins,
    braiinsClient,
    poolTracker,
    datumPoller,
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

  // Ocean stats client — null if no payout address configured (the
  // finance panel just won't have an "expected income" figure then).
  const oceanClient = createOceanClient();

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

  // Account-lifetime spend tracker — sums counters_committed.amount_consumed_sat
  // across every Braiins bid (active + historical). Terminal bids are
  // persisted in closed_bids_cache so steady-state refreshes only
  // paginate the tail, not every bid the account has ever owned.
  const accountSpend = new AccountSpendService(braiinsClient, closedBidsCacheRepo);

  // BTC/USD price oracle — purely a dashboard display convenience.
  const btcPriceService = new BtcPriceService();

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
    payoutObserver?.stop();
    retentionService.stop();
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
    `tick ── ${state.run_mode}/${state.action_mode}  ` +
      `mkt best_bid=${bestBid} best_ask=${bestAsk}  ` +
      `pool=${poolOk}  own=${state.owned_bids.length}  ` +
      `unknown=${state.unknown_bids.length}  ` +
      `floor_since=${state.below_floor_since ? new Date(state.below_floor_since).toISOString() : 'ok'}`,
  );

  if (gated.length === 0) {
    log(`    (no proposals — nothing to do)`);
    return;
  }
  for (const g of gated) {
    const prefix = g.allowed ? '    →' : '    ✗';
    log(`${prefix} ${describeProposal(g.proposal)}${g.allowed ? '' : `  BLOCKED:${'reason' in g ? g.reason : '?'}`}`);
  }
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

main().catch((err) => {
  console.error('daemon startup failed:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
