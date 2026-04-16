/**
 * Daemon entry point.
 *
 * Boots the process, loads config + secrets, constructs the controller
 * with all its dependencies, and runs the observe→decide→gate→execute
 * tick loop until SIGINT / SIGTERM.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createBraiinsClient } from '@braiins-hashrate/braiins-client';

import { loadSecrets } from './config/secrets.js';
import { createHttpServer } from './http/server.js';
import { BraiinsService } from './services/braiins-service.js';
import { PoolHealthTracker } from './services/pool-health.js';
import { closeDatabase, openDatabase } from './state/db.js';
import { ConfigRepo } from './state/repos/config.js';
import { DecisionsRepo } from './state/repos/decisions.js';
import { OwnedBidsRepo } from './state/repos/owned_bids.js';
import { RuntimeStateRepo } from './state/repos/runtime_state.js';
import { TickMetricsRepo } from './state/repos/tick_metrics.js';
import { Controller } from './controller/tick.js';
import { TickLoop } from './controller/loop.js';
import type { TickResult } from './controller/tick.js';

const DEFAULT_TICK_INTERVAL_MS = Number.parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const HTTP_PORT = Number.parseInt(process.env['HTTP_PORT'] ?? '3000', 10);
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

  const cfg = await configRepo.get();
  if (!cfg) throw new Error('config row missing — run `pnpm -w run setup` first');
  log(`config:   target=${cfg.target_hashrate_ph} PH/s  floor=${cfg.minimum_floor_hashrate_ph} PH/s`);

  // SPEC §7.1: run_mode always boots in DRY_RUN.
  await runtimeRepo.initializeIfMissing();
  await runtimeRepo.resetRunModeToDryRun();
  log('run mode reset to DRY_RUN (boot)');

  const braiinsClient = createBraiinsClient({
    ownerToken: secrets.braiins_owner_token,
    ...(secrets.braiins_read_only_token
      ? { readOnlyToken: secrets.braiins_read_only_token }
      : {}),
  });
  const braiins = new BraiinsService({ client: braiinsClient });
  const poolTracker = new PoolHealthTracker();

  const controller = new Controller({
    braiins,
    braiinsClient,
    poolTracker,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
    now: () => Date.now(),
  });

  const loop = new TickLoop({
    controller,
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
    onTick: (r: TickResult) => logTick(r),
    onError: (err) => log(`[tick] error: ${(err as Error)?.message ?? err}`),
  });

  // HTTP server (dashboard API + static).
  const httpServer = await createHttpServer({
    controller,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
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
  log('daemon ready (DRY-RUN). Ctrl+C to stop.');
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
