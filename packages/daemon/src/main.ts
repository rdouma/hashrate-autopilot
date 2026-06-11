/**
 * Daemon entry point.
 *
 * Boots the process, loads config + secrets, and either:
 *   - Runs the operational tick loop until SIGINT/SIGTERM (normal path), or
 *   - Stands up the first-run wizard server when config/secrets are absent
 *     and transitions in-place to operational mode after the wizard
 *     submits (no external process manager required - see #57 followup
 *     for why the original "exit and let supervisor restart" approach
 *     didn't work on plain `start.sh` deployments).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createBitcoindClient } from '@hashrate-autopilot/bitcoind-client';
import { BlockVersionService } from './services/block-version.js';
import { createBraiinsClient } from '@hashrate-autopilot/braiins-client';

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
import { PublicIpService } from './services/public-ip.js';
import { DdnsUpdaterService } from './services/ddns-updater.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from './state/db.js';
import { AlertsRepo } from './state/repos/alerts.js';
import { BidEventsRepo } from './state/repos/bid_events.js';
import { IpChangeEventsRepo } from './state/repos/ip_change_events.js';
import { BraiinsDepositsRepo } from './state/repos/braiins_deposits.js';
import { SoloMinersRepo } from './state/repos/solo_miners.js';
import { AxeOSPoller } from './services/axeos-poller.js';
import { ClosedBidsCacheRepo } from './state/repos/closed_bids_cache.js';
import { ConfigRepo } from './state/repos/config.js';
import { PoolBlocksRepo } from './state/repos/pool_blocks.js';
import { RewardEventsRepo } from './state/repos/reward_events.js';
import { DecisionsRepo } from './state/repos/decisions.js';
import { OwnedBidsRepo } from './state/repos/owned_bids.js';
import { RuntimeStateRepo } from './state/repos/runtime_state.js';
import { TickMetricsRepo } from './state/repos/tick_metrics.js';
import { Controller } from './controller/tick.js';
import { TickLoop } from './controller/loop.js';
import { AlertEvaluator } from './services/alert-evaluator.js';
import { AlertManager } from './services/alert-manager.js';
import { BraiinsDepositWatcherService } from './services/braiins-deposit-watcher.js';
import { TelegramSink, type SendOptions } from './services/notifier.js';
import { TelegramReceiver } from './services/telegram-receiver.js';
import { runOceanUnpaidCleanup } from './services/ocean-unpaid-cleanup.js';
import { runNetworkDifficultyBackfill } from './services/network-difficulty-backfill.js';
import { runPoolBlocksBackfill } from './services/pool-blocks-backfill.js';
import { runPoolLuckRecompute } from './services/pool-luck-recompute.js';
import { runGapBackfill } from './services/gap-backfill.js';
import type { TickResult } from './controller/tick.js';
import { cheapestAskForDepth } from './controller/orderbook.js';
import type { State } from './controller/types.js';

const DEFAULT_TICK_INTERVAL_MS = Number.parseInt(process.env['TICK_INTERVAL_MS'] ?? '60000', 10);
const HTTP_PORT = Number.parseInt(process.env['HTTP_PORT'] ?? '3010', 10);
const HTTP_HOST = process.env['HTTP_HOST'] ?? '0.0.0.0';
const DASHBOARD_STATIC = process.env['DASHBOARD_STATIC'] ?? 'packages/dashboard/dist';

function defaultAgeKeyPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'] ?? `${homedir()}/.config`;
  const preferred = `${xdg}/hashrate-autopilot/age.key`;
  if (existsSync(preferred)) return preferred;
  const legacy = `${xdg}/braiins-hashrate/age.key`;
  if (existsSync(legacy)) return legacy;
  return preferred;
}

interface BootDeps {
  readonly handle: DatabaseHandle;
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly ownedBidsRepo: OwnedBidsRepo;
  readonly decisionsRepo: DecisionsRepo;
  readonly tickMetricsRepo: TickMetricsRepo;
  readonly bidEventsRepo: BidEventsRepo;
  readonly ipChangeEventsRepo: IpChangeEventsRepo;
  readonly alertsRepo: AlertsRepo;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly rewardEventsRepo: RewardEventsRepo;
  readonly closedBidsCacheRepo: ClosedBidsCacheRepo;
  readonly secretsRepo: SecretsRepo;
  readonly secretsPath: string;
  readonly ageKeyPath: string;
}

// Global crash safety net. The daemon previously had NO
// uncaughtException / unhandledRejection handler, so a single stray
// rejection anywhere (a fire-and-forget promise in any service) would
// terminate the whole process with no log line and no alert - it just
// vanished, and on a systemd box looked like a mysterious "daemon
// died" (the operator could only see the deposit alert that happened
// to fire just before). These handlers log the stack, fire a
// best-effort Telegram alert, and exit(1) so systemd restarts cleanly.
//
// `emergencyNotify` is wired to the live Telegram sink once it exists
// in bootOperational; before that (early startup) we still log + exit.
let emergencyNotify: ((msg: string) => Promise<unknown>) | null = null;
let daemonExiting = false;
let crashing = false;

function installCrashHandlers(): void {
  const onFatal = (kind: string, err: unknown): void => {
    // A late rejection during a clean shutdown is not a crash.
    if (daemonExiting || crashing) return;
    crashing = true;
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`FATAL ${kind} - daemon will exit for restart:`);
    console.error(detail);
    void (async () => {
      try {
        if (emergencyNotify) {
          const short = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
          await Promise.race([
            emergencyNotify(
              `🛑 Hashrate Autopilot crashed (${kind}): ${short} — systemd will restart it.`,
            ),
            new Promise((r) => setTimeout(r, 4_000)),
          ]);
        }
      } catch {
        // Best-effort: never let the alert path block the exit.
      } finally {
        // exit(1) so a systemd Restart=on-failure/always brings it back.
        process.exit(1);
      }
    })();
  };
  process.on('uncaughtException', (err) => onFatal('uncaughtException', err));
  process.on('unhandledRejection', (reason) => onFatal('unhandledRejection', reason));
}

async function main(): Promise<void> {
  installCrashHandlers();
  const projectRoot = process.cwd();
  const secretsPath = process.env['SECRETS_PATH'] ?? resolve(projectRoot, '.env.sops.yaml');
  const dbPath = process.env['DB_PATH'] ?? resolve(projectRoot, 'data/state.db');
  const ageKeyPath = process.env['SOPS_AGE_KEY_FILE'] ?? defaultAgeKeyPath();

  log(`starting daemon  (node ${process.version}, pid ${process.pid})`);
  log(`  secrets:  ${secretsPath}`);
  log(`  db:       ${dbPath}`);
  log(`  age key:  ${ageKeyPath}`);
  log(`  tick:     ${DEFAULT_TICK_INTERVAL_MS} ms`);

  // Open the DB first - needed in both operational and NEEDS_SETUP
  // boot paths (the wizard writes config + secrets through repos
  // backed by the same handle).
  const handle = await openDatabase({ path: dbPath });
  if (handle.migrations.reconciled.length > 0) {
    // Migrations whose schema effect was already present on the DB
    // (e.g., a half-applied state from a crashed prior run) but
    // whose tracking row was missing in `_migrations`. The runner
    // stamped them retroactively. Log loudly so the operator knows
    // self-heal kicked in - this is the kind of thing you want
    // visible in the journal, not silent.
    log(`db: reconciled ${handle.migrations.reconciled.length} already-applied migration(s): ${handle.migrations.reconciled.join(', ')}`);
  }
  const deps: BootDeps = {
    handle,
    configRepo: new ConfigRepo(handle.db),
    runtimeRepo: new RuntimeStateRepo(handle.db),
    ownedBidsRepo: new OwnedBidsRepo(handle.db),
    decisionsRepo: new DecisionsRepo(handle.db),
    tickMetricsRepo: new TickMetricsRepo(handle.db),
    bidEventsRepo: new BidEventsRepo(handle.db),
    ipChangeEventsRepo: new IpChangeEventsRepo(handle.db),
    alertsRepo: new AlertsRepo(handle.db),
    poolBlocksRepo: new PoolBlocksRepo(handle.db),
    rewardEventsRepo: new RewardEventsRepo(handle.db),
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
    log(`NEEDS_SETUP - missing: ${missing.join(', ')}; serving wizard only`);
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
      // Drop the setup-mode signal handlers - bootOperational will
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
    ipChangeEventsRepo,
    alertsRepo,
    poolBlocksRepo,
    rewardEventsRepo,
    closedBidsCacheRepo,
    secretsPath,
    ageKeyPath,
  } = deps;
  let dbCfg = dbCfgIn;

  // Seed bitcoind credentials from secrets into config on first boot
  // so they become dashboard-editable (issue #14). Only runs when secrets
  // carries all three fields - the wizard no longer collects them
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
  // PAUSED - that's only a reactive state).
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
  // #287: surface boot-time mode transitions on the History page. Only
  // when the boot actually changed the mode - a LAST_MODE restart that
  // keeps LIVE stays quiet (restarts already render as offline gap
  // bands on the charts). The classic case this catches: an overnight
  // restart with boot_mode=ALWAYS_DRY_RUN silently dropping the
  // controller out of LIVE.
  if (bootMode !== priorMode) {
    await bidEventsRepo.insert({
      occurred_at: Date.now(),
      source: 'AUTOPILOT',
      kind: 'MODE_CHANGE',
      braiins_order_id: null,
      old_price_sat: null,
      new_price_sat: null,
      speed_limit_ph: null,
      amount_sat: null,
      reason: `boot: ${priorMode} → ${bootMode} (boot_mode=${cfg.boot_mode})`,
      overpay_sat_per_eh_day: null,
      max_overpay_vs_hashprice_sat_per_eh_day: null,
    }).catch((e) => {
      // Pre-0111 schema (CHECK constraint without MODE_CHANGE) or any
      // other insert hiccup must not block boot.
      log(`warn: failed to log boot mode change: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

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

  // Live config wrapper. Defined BEFORE the payout observer (and
  // anything else that needs a live-view of the operator's edits)
  // so closures over cfgRefHolder.value see updates as they land,
  // not the boot-time `cfg` snapshot. Previously the observer's
  // getAddress / getHistoricalEnabled read from the boot const,
  // which meant changing btc_payout_address via the dashboard
  // didn't take effect until daemon restart - the observer kept
  // scanning the old address and the P&L "collected (on-chain)"
  // tile stayed stuck on the old number even though Config showed
  // the new address (#240 follow-up).
  const cfgRefHolder = { value: cfg };

  let payoutObserver: PayoutObserver | null = null;
  // Construction conditions:
  // - payout_source must be enabled
  // - we need an address to scan
  // - we need EITHER bitcoind RPC creds (the original scantxoutset
  //   path) OR an electrs host:port pair (the per-UTXO path added
  //   for v1.5.2). Until v1.5.3 this branch also required
  //   `bitcoindClient`, which silently disabled the entire observer
  //   on Umbrel installs that don't declare bitcoind as a
  //   dependency - even though electrs alone is sufficient. That
  //   was the actual cause of the flat-zero lifetime-earnings line
  //   on Umbrel after the v1.5.1/v1.5.2 fixes.
  const hasElectrs =
    cfg.payout_source === 'electrs' && !!cfg.electrs_host && !!cfg.electrs_port;
  const hasBitcoind = !!bitcoindClient;
  if (cfg.payout_source !== 'none' && cfg.btc_payout_address && (hasBitcoind || hasElectrs)) {
    payoutObserver = new PayoutObserver({
      client: bitcoindClient,
      // #240 follow-up: live-read via cfgRefHolder so a dashboard-
      // edited btc_payout_address takes effect on the observer's
      // next scan without a daemon restart. The boot-time `cfg`
      // capture used to snapshot the address - subsequent edits
      // changed the DB row but the observer kept polling the old
      // value.
      getAddress: () => cfgRefHolder.value.btc_payout_address,
      // electrs host/port are still read off the boot-time cfg
      // because changing the electrs endpoint mid-run isn't a
      // supported edit (would need a full observer rewire). Address
      // is the operator-facing knob.
      electrsHost: cfg.payout_source === 'electrs' ? cfg.electrs_host : null,
      electrsPort: cfg.payout_source === 'electrs' ? cfg.electrs_port : null,
      log: (m) => log(m),
      db: handle.db,
      // #170: live-read the backfill toggle each cycle so flipping it
      // in the dashboard takes effect without a daemon restart.
      getHistoricalEnabled: () => cfgRefHolder.value.include_historical_payouts,
      // When new reward_events rows land, immediately backfill
      // tick_metrics.paid_total_sat across history so the chart's
      // lifetime-earnings line shows the correct timeline without
      // needing a second daemon restart. Idempotent + safe to run
      // concurrently with steady-state ticks.
      onRewardsChanged: async () => {
        log('[payout] reward_events changed, kicking pool-luck-recompute to backfill paid_total_sat');
        await runPoolLuckRecompute({
          db: handle.db,
          poolBlocksRepo,
          log: (m) => log(m),
        });
      },
    });
    if (cfg.payout_source === 'electrs') {
      log(`payout: observer ENABLED via Electrs at ${cfg.electrs_host}:${cfg.electrs_port}${hasBitcoind ? ' (with bitcoind side-scan)' : ' (electrs-only)'}`);
    } else {
      log('payout: observer ENABLED via bitcoind scantxoutset (CPU-heavy, polled hourly)');
    }
  } else {
    // Explicit-cause logging: silent observer-disabled was a load-
    // bearing surprise on Umbrel, where the construction guard fell
    // through silently and the chart's lifetime-earnings line stayed
    // flat zero. Spell out the exact reason the operator can grep
    // for in the daemon log.
    const reasons: string[] = [];
    if (cfg.payout_source === 'none') reasons.push('payout_source=none');
    if (!cfg.btc_payout_address) reasons.push('btc_payout_address empty');
    if (!hasBitcoind && !hasElectrs) {
      reasons.push(
        cfg.payout_source === 'electrs'
          ? 'electrs selected but electrs_host/electrs_port empty'
          : 'no bitcoind RPC creds and electrs not configured',
      );
    }
    log(`payout: observer DISABLED (${reasons.join(', ') || 'unknown'})`);
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

  // Hashprice cache - read by the controller for the dynamic cap and
  // cheap-hashrate scaling. Warm path is the dashboard's finance poll;
  // a boot-time fetch below guarantees a value on tick 1 so the
  // dynamic cap doesn't silently collapse if the dashboard isn't open
  // (issue #28). Stale readings beyond HASHPRICE_STALENESS_MS are
  // treated as unknown so the cap gate refuses to price without a
  // current break-even reference.
  const hashpriceCache = new HashpriceCache();
  const HASHPRICE_STALENESS_MS = 60 * 60 * 1000;

  // Ocean stats client - shared between the tick observe path (for
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
    poolBlocksRepo,
    rewardEventsRepo,
    now: () => Date.now(),
    getHashprice: () => hashpriceCache.getFresh(HASHPRICE_STALENESS_MS),
  });
  // Restore floor-tracking state so the escalation timer keeps counting
  // across daemon restarts (#11).
  await controller.hydrate();

  // #108: backfill pool-blocks from Ocean if needed so the historical
  // pool-luck plot has data on a fresh install. Idempotent on re-boot;
  // bounded to ~14 days so a long downtime fills the gap without
  // hammering Ocean. Failures here are logged but never abort boot
  // (the empty table just degrades to "no historical luck", same as
  // pre-#108 behaviour).
  // One-shot revert: a previous build's recompute populated
  // ocean_unpaid_sat with a wrong pool_block × share_log
  // reconstruction. Null those values out before the chart reads
  // them. Idempotent across boots.
  await runOceanUnpaidCleanup({ db: handle.db, log: (m) => log(m) }).catch(
    (err) => log(`[ocean-unpaid-cleanup] ${(err as Error).message}`),
  );

  // Boot chain order (#241):
  //   1. pool-blocks-backfill - pull Ocean's pool_blocks for the
  //      lookback window so the per-tick gap-fill below can compute
  //      pool_blocks_*_count and pool_luck_* at synthetic-tick times.
  //   2. gap-backfill - if there's an offline gap in tick_metrics,
  //      insert synthetic ticks across it (per-tick when bitcoindClient
  //      is wired so each tick carries the correct epoch difficulty,
  //      falls back to a single-marker estimate without it).
  //   3. pool-luck-recompute - walk every tick_metrics row (including
  //      the newly-inserted synthetics) and populate
  //      pool_blocks_*_count / pool_luck_* / paid_total_sat from the
  //      pool_blocks + reward_events ground truth. This is what turns
  //      the in-gap synthetics into a luck line that step-changes on
  //      each in-gap pool block instead of flat-interpolating.
  // Each stage gets its own `.catch` so an earlier-stage error
  // doesn't silently swallow the next stage. Previously a single
  // shared `.catch` at the end meant: pool-blocks-backfill throws ->
  // gap-backfill and pool-luck-recompute never run -> the chart
  // looks identical to a daemon that didn't restart, and we ship
  // four iterations of "fixes" thinking the code is buggy when
  // actually it's never executing.
  // #240 follow-up: boot-time payout-state refresh. Two scenarios:
  //
  // 1. Address mismatch (the obvious one). Operator changed
  //    btc_payout_address on an older build (before the live-cfg
  //    fix in build 564) so reward_events ends up populated with
  //    OLD-address payouts. On restart, cfg loads the NEW address
  //    but reward_events still has the OLD-address rows. P&L
  //    "collected (on-chain)" (reads reward_events.sum) shows the
  //    wrong number. Detect via runtime_state.last_backfilled_
  //    payout_address. On mismatch: DELETE reward_events, NULL
  //    tick_metrics.paid_total_sat, kick scanOnce + backfill,
  //    stamp the new address.
  //
  // 2. No mismatch but reward_events may still be stale or empty.
  //    A user with a long-standing address (operator's #240 user
  //    is the canonical case - never changed address but never saw
  //    their incoming payout because the original install's
  //    backfill predated the coinbase-filter fix). On every boot,
  //    additively re-run runHistoricalBackfill so new TXs that
  //    weren't found on prior boots (because of a code bug, an
  //    electrs hiccup, scan-depth limits, transient errors) get
  //    picked up. No DELETE in this path - existing rows are
  //    preserved, only new ones inserted.
  //
  // Both paths skip if payoutObserver is null (payout_source=none
  // or no electrs/bitcoind), and the additive path no-ops on
  // bitcoind-only setups (runHistoricalBackfill returns an
  // "electrs not configured" error string; logged, not thrown).
  void (async () => {
    if (!cfgRefHolder.value.btc_payout_address) return;
    const runtime = await runtimeRepo.get().catch(() => null);
    const lastAddr = runtime?.last_backfilled_payout_address ?? null;
    const currAddr = cfgRefHolder.value.btc_payout_address;
    const mismatch = lastAddr !== currAddr;

    if (mismatch) {
      log(
        `[payout] boot detected address mismatch (was ${lastAddr ?? '<null>'}, ` +
          `now ${currAddr}); clearing reward_events and kicking ` +
          `historical backfill against the new address`,
      );
      try {
        await handle.db.deleteFrom('reward_events').execute();
        await handle.db
          .updateTable('tick_metrics')
          .set({ paid_total_sat: null })
          .execute();
        if (payoutObserver) {
          payoutObserver.resetSnapshot();
          void payoutObserver.scanOnce().catch((e) =>
            log(`[payout] boot address-mismatch scanOnce failed: ${(e as Error).message}`),
          );
          const r = await payoutObserver.runHistoricalBackfill();
          log(
            `[payout] boot address-mismatch backfill: ${r.txSeen} txs, ` +
              `${r.withMatchingOutputs} with matching outputs, ` +
              `${r.inserted} inserted${r.error ? `, error: ${r.error}` : ''}`,
          );
        }
        // Stamp the address regardless of whether backfill produced
        // rows. If runHistoricalBackfill threw, the catch below
        // intercepts and we DON'T stamp - next boot retries.
        await runtimeRepo.patch({ last_backfilled_payout_address: currAddr });
      } catch (err) {
        log(`[payout] boot address-mismatch refresh failed: ${(err as Error).message}`);
      }
      return;
    }

    // Address unchanged. Additively re-run the historical backfill
    // anyway so users who never changed addresses still get fresh
    // discoveries from electrs (e.g., a payout TX that landed
    // between this boot and the previous one, or one that the
    // earlier boot's backfill missed due to a code bug). Existing
    // rows are preserved - the backfill's INSERT ... ON CONFLICT
    // DO NOTHING is idempotent on tx_hash + output_index.
    if (!payoutObserver) return;
    try {
      const r = await payoutObserver.runHistoricalBackfill();
      log(
        `[payout] boot additive historical backfill: ${r.txSeen} txs, ` +
          `${r.withMatchingOutputs} with matching outputs, ` +
          `${r.inserted} inserted${r.error ? `, error: ${r.error}` : ''}`,
      );
    } catch (err) {
      log(`[payout] boot additive backfill failed: ${(err as Error).message}`);
    }
  })();

  void runPoolBlocksBackfill({
    oceanClient,
    poolBlocksRepo,
    db: handle.db,
    log: (m) => log(m),
  })
    .catch((err) => log(`[pool-blocks] backfill failed: ${(err as Error).message}`))
    .then(() =>
      runGapBackfill({
        db: handle.db,
        poolBlocksRepo,
        ...(bitcoindClient ? { bitcoindClient } : {}),
        log: (m) => log(m),
      }),
    )
    .catch((err) => log(`[gap-backfill] failed: ${(err as Error).message}\n${(err as Error).stack ?? ''}`))
    .then(() =>
      runPoolLuckRecompute({
        db: handle.db,
        poolBlocksRepo,
        log: (m) => log(m),
      }),
    )
    .catch((err) => log(`[pool-luck-recompute] failed: ${(err as Error).message}`));

  // #230: fill NULL `network_difficulty` ticks from bitcoind block
  // headers. Pre-existing rows that predate the daemon-side
  // observation hold the chart's difficulty line back from extending
  // through full history; this backfill walks the gap. Boot-time,
  // idempotent, never overwrites a non-null value. Silent skip when
  // bitcoind isn't configured / reachable.
  if (bitcoindClient) {
    void runNetworkDifficultyBackfill({
      bitcoindClient,
      tickMetricsRepo,
      log: (m) => log(m),
    }).catch((err) =>
      log(`[network-difficulty-backfill] ${(err as Error).message}`),
    );
  }

  // #100: Telegram notifier wiring. Sink credentials are re-read from
  // the latest config snapshot on every send so live edits to bot
  // token / chat id take effect on the next tick without a restart.
  // Resolution: prefer config when non-empty, fall back to secrets.
  const buildSink = () => {
    const latestCfg = configRepo;
    return new TelegramSink({
      bot_token:
        cfgRefHolder.value.telegram_bot_token ||
        secrets.telegram_bot_token ||
        '',
      chat_id: cfgRefHolder.value.telegram_chat_id || '',
      instance_label: cfgRefHolder.value.telegram_instance_label || '',
    });
    void latestCfg;
  };
  // Forward `opts` through to the freshly-built sink so the
  // alert-manager's alert_id + action_buttons (Mark as seen / Snooze)
  // make it onto the outbound Telegram payload as reply_markup. The
  // first cut of this wrapper dropped opts and inline keyboards
  // silently disappeared; #109 buttons never rendered as a result.
  const dynamicSink = {
    send: (body: string, opts?: SendOptions) => buildSink().send(body, opts),
    verify: () => buildSink().verify(),
  };
  // Now that a Telegram sink exists, let the global crash handler send
  // a last-gasp alert before the process exits for restart.
  emergencyNotify = (msg: string) => dynamicSink.send(msg);
  const alertManager = new AlertManager({
    alertsRepo,
    sink: dynamicSink,
    getConfig: () => ({
      notifications_muted: cfgRefHolder.value.notifications_muted,
      notification_retry_interval_minutes:
        cfgRefHolder.value.notification_retry_interval_minutes,
      notification_locale: cfgRefHolder.value.notification_locale,
    }),
  });
  // #149: solo-mining poller is constructed *before* AlertEvaluator
  // so the evaluator can read its snapshot for the four per-device
  // alert classes. Polling is no-op until `solo_mining_enabled`.
  const soloMinersRepo = new SoloMinersRepo(handle.db);
  const axeOSPoller = new AxeOSPoller({
    cfgRef: cfgRefHolder,
    repo: soloMinersRepo,
    runtimeRepo,
    log: (m) => log(m),
  });
  const alertEvaluator = new AlertEvaluator({
    alertManager,
    axeOSPoller,
    tickMetricsRepo,
    poolBlocksRepo,
    // #226: enables payout_confirmed firing once per new reward_events row.
    rewardEventsRepo,
    log: (m) => log(m),
  });
  // Rebuild in-memory event state from the alerts table so a daemon
  // restart while a bad state is still active does not fire a
  // duplicate Telegram alert. See AlertEvaluator.hydrate JSDoc.
  await alertEvaluator.hydrate(alertsRepo);

  // #109: receive button taps from Telegram messages (Mark as seen)
  // via getUpdates long-poll. Survives missing credentials
  // (no token / chat) by sleeping until they're filled in.
  //
  // #152: also honours the master `notifications_muted` switch.
  // Without this gate, an operator running multiple installs against
  // the same Telegram bot but with mute on for the secondary install
  // would still race-consume getUpdates events on the secondary -
  // each Telegram update is delivered to whichever poller wins, and
  // the secondary's DB doesn't have the corresponding alert row, so
  // markAcknowledged silently no-ops while the secondary still edits
  // the Telegram message footer. Result: "acked in Telegram, unacked
  // on the primary's dashboard." Mute = full disengagement from the
  // Telegram bot (inbound + outbound) so the primary can poll cleanly.
  const telegramReceiver = new TelegramReceiver({
    getCredentials: () => {
      if (cfgRefHolder.value.notifications_muted) return null;
      const token = cfgRefHolder.value.telegram_bot_token || secrets.telegram_bot_token || '';
      const chat = cfgRefHolder.value.telegram_chat_id || '';
      return token && chat ? { bot_token: token, chat_id: chat } : null;
    },
    alertsRepo,
    log: (m) => log(m),
  });
  telegramReceiver.start();

  const loop = new TickLoop({
    controller,
    intervalMs: DEFAULT_TICK_INTERVAL_MS,
    onTick: (r: TickResult) => {
      logTick(r);
      // Refresh the config reference so the alert system sees live
      // edits without a restart. tick.ts re-reads config on every
      // tick into r.state.config.
      cfgRefHolder.value = r.state.config;
      // Fire-and-forget: alert evaluation must not block the tick
      // loop. Errors are logged but never bubble up.
      void alertEvaluator
        .evaluate(r.state)
        .catch((err) => log(`[alert-evaluator] ${(err as Error)?.message ?? err}`));
      void alertManager
        .processDueRetries()
        .catch((err) => log(`[alert-retry] ${(err as Error)?.message ?? err}`));
      // #149: AxeOS poll for the operator's solo-mining devices. No-op
      // when `solo_mining_enabled` is false. Fire-and-forget like the
      // others above so a slow Bitaxe doesn't drag the tick loop.
      // Pass the canonical tick_at so persisted samples share the
      // exact tick_at value tick_metrics uses (chart join needs it).
      void axeOSPoller
        .tick(r.state.tick_at)
        .catch((err) => log(`[axeos-poller] ${(err as Error)?.message ?? err}`));
    },
    onError: (err) => log(`[tick] error: ${(err as Error)?.message ?? err}`),
  });

  // Boot-time hashprice fetch (issue #28). When the operator has
  // configured both a payout address and the dynamic cap, seed the
  // cache from Ocean before the tick loop starts so decide()'s first
  // tick has a break-even reference available. Retries up to 3 times
  // with a 2s delay so a transient Ocean hiccup at boot doesn't leave
  // the cache cold for the first tick (which fires immediately).
  if (cfg.btc_payout_address && cfg.max_overpay_vs_hashprice_sat_per_eh_day) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const stats = await oceanClient.fetchStats(cfg.btc_payout_address);
        if (stats?.hashprice_sat_per_ph_day != null) {
          hashpriceCache.set(stats.hashprice_sat_per_ph_day);
          log(`hashprice: seeded from Ocean at boot (${stats.hashprice_sat_per_ph_day} sat/PH/day)`);
          break;
        }
        log(`hashprice: Ocean returned no hashprice (attempt ${attempt}/3)`);
      } catch (err) {
        log(`hashprice: boot fetch failed (attempt ${attempt}/3): ${(err as Error)?.message ?? err}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
      else log('hashprice: all boot attempts exhausted - dynamic cap gate will block trading until next fetch succeeds');
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

  // Account-lifetime spend tracker - sums counters_committed.amount_consumed_sat
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
    alertsRepo,
    { log: (m) => log(m) },
  );
  retentionService.start();

  // #111: public-IP poll + DDNS updater. Public-IP runs unconditionally
  // (cheap, used for the diagnostics card too); the updater is a no-op
  // until the operator configures `ddns_provider` etc. on the Config
  // page.
  // Lazy ref so the publicIp -> ddnsUpdater wiring can be set up
  // before the updater is constructed below. publicIp's onIpChange
  // handler reads through this ref at fire time, so it sees the
  // updater instance once it exists. Avoids a circular construction
  // between the two services.
  const ddnsUpdaterRef: { value: DdnsUpdaterService | null } = { value: null };
  const publicIpService = new PublicIpService({
    log: (m) => log(m),
    onIpChange: (newIp, oldIp) => {
      // #250: persist the rotation as a first-class event so the
      // dashboard can show "IP last changed" and mark it on the charts
      // (to correlate with rejection-rate spikes). Fire-and-forget; a
      // DB hiccup must not break the IP-poll loop.
      void ipChangeEventsRepo
        .insert({ occurred_at: Date.now(), old_ip: oldIp, new_ip: newIp })
        .catch((err) =>
          log(`[ip-change] failed to record ${oldIp} -> ${newIp}: ${String(err)}`),
        );
      // Force an immediate DDNS push as soon as we observe an IP
      // rotation - addresses #114 where a real ISP rotation left the
      // old IP live in DNS for ~27 min while two 5-min pollers waited
      // out their natural cadences.
      const u = ddnsUpdaterRef.value;
      if (u) void u.tick();
    },
  });
  publicIpService.start();
  const ddnsUpdater = new DdnsUpdaterService({
    cfgRef: cfgRefHolder,
    publicIp: publicIpService,
    log: (m) => log(m),
  });
  ddnsUpdaterRef.value = ddnsUpdater;
  ddnsUpdater.start();

  // #141: Braiins on-chain deposit lifecycle watcher restored. The
  // #132 pivot to total_deposited_sat-deltas conflated Detected and
  // Available (operator's empirical 12-min gap on a real test deposit
  // disproved the assumption). The lifecycle endpoint
  // /v1/account/transaction/on-chain DOES expose the distinction via
  // the deposit_status enum + return_tx_id; the watcher polls it on
  // its own 60s cadence, fires Detected / Available / Returned, and
  // logs every status transition for empirical enum-mapping tuning.
  const braiinsDepositsRepo = new BraiinsDepositsRepo(handle.db);
  const braiinsDepositWatcher = new BraiinsDepositWatcherService({
    cfgRef: cfgRefHolder,
    braiinsClient,
    depositsRepo: braiinsDepositsRepo,
    alertManager,
    log: (m) => log(m),
  });
  braiinsDepositWatcher.start();

  // HTTP server (dashboard API + static).
  const httpServer = await createHttpServer({
    controller,
    configRepo,
    runtimeRepo,
    ownedBidsRepo,
    decisionsRepo,
    tickMetricsRepo,
    bidEventsRepo,
    ipChangeEventsRepo,
    alertsRepo,
    poolBlocksRepo,
    rewardEventsRepo,
    payoutObserver,
    oceanClient,
    accountSpend,
    btcPriceService,
    hashpriceCache,
    blockVersionService,
    bitcoindClient,
    publicIpService,
    ddnsUpdater,
    soloMinersRepo,
    axeOSPoller,
    braiinsDepositsRepo,
    braiinsClient,
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
    // React to dashboard config saves without waiting for the next
    // controller tick (~1 min). Refresh the live config reference
    // immediately so live-edited fields land in cfgRefHolder, then
    // kick the DDNS updater when any DDNS-relevant field changed.
    // Without this, a freshly-edited hostname / credential / pool
    // URL took up to ~5 min to propagate to the actual DNS record.
    onConfigSaved: (newCfg, prevCfg) => {
      cfgRefHolder.value = newCfg;
      const ddnsRelevant: ReadonlyArray<keyof typeof newCfg> = [
        'ddns_provider',
        'ddns_hostname',
        'ddns_username',
        'ddns_credential',
        'ddns_update_url',
        'destination_pool_url',
      ];
      const ddnsChanged =
        prevCfg === null ||
        ddnsRelevant.some((k) => prevCfg[k] !== newCfg[k]);
      if (ddnsChanged) {
        log('[ddns] config changed, kicking immediate tick');
        void ddnsUpdater.tick();
      }
      // #240: when the payout address changes, the existing
      // reward_events rows belong to the old address and the
      // tick_metrics.paid_total_sat values were derived from those.
      // Wipe both and kick an immediate backfill so the dashboard
      // reflects the new address's history within the next tick.
      // historical_payouts_offset_sat is operator-set and stays
      // (separate concern - operator updates it on the new address
      // if they had pre-installation income there).
      const addressChanged =
        prevCfg !== null &&
        prevCfg.btc_payout_address !== newCfg.btc_payout_address &&
        newCfg.btc_payout_address !== '';
      if (addressChanged) {
        log(
          `[payout] address changed from ${prevCfg!.btc_payout_address} to ` +
            `${newCfg.btc_payout_address}; clearing reward_events and ` +
            `nulling tick_metrics.paid_total_sat across history`,
        );
        void (async () => {
          try {
            await handle.db.deleteFrom('reward_events').execute();
            await handle.db
              .updateTable('tick_metrics')
              .set({ paid_total_sat: null })
              .execute();
            if (payoutObserver) {
              // Drop the in-memory snapshot first so the P&L
              // "collected (on-chain)" tile shows 'computing'
              // instead of the OLD address's total while the
              // rescan + backfill run.
              payoutObserver.resetSnapshot();
              // Kick an immediate balance scan against the new
              // address (getAddress reads cfgRefHolder live, so
              // it'll see the just-saved new value). Don't await -
              // backfill below is more important and they're
              // independent.
              void payoutObserver.scanOnce().catch((e) =>
                log(`[payout] post-address-change scanOnce failed: ${(e as Error).message}`),
              );
              log('[payout] kicking historical backfill against new address');
              // runHistoricalBackfill fires onRewardsChanged when any
              // rows insert, and that callback already kicks
              // pool-luck-recompute (which regenerates the
              // tick_metrics.paid_total_sat we just nulled). No
              // explicit recompute needed here.
              const r = await payoutObserver.runHistoricalBackfill();
              log(
                `[payout] post-address-change backfill: ${r.txSeen} txs, ` +
                  `${r.withMatchingOutputs} with matching outputs, ` +
                  `${r.inserted} inserted${r.error ? `, error: ${r.error}` : ''}`,
              );
              // Stamp the new address as the one we just backfilled
              // so the boot-time mismatch check (above) no-ops on
              // subsequent restarts unless the operator changes the
              // address again.
              await runtimeRepo.patch({
                last_backfilled_payout_address: newCfg.btc_payout_address,
              });
            }
          } catch (err) {
            log(
              `[payout] address-change refresh failed: ${(err as Error).message}`,
            );
          }
        })();
      }
    },
  });
  const addr = await httpServer.start(HTTP_PORT, HTTP_HOST);
  log(`http: listening on ${addr} (dashboard password from secrets)`);

  // Shutdown wiring must precede loop.start so the first tick can be stopped.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Tell the global crash handler this is an intentional exit, so a
    // late rejection during drain isn't misreported as a crash.
    daemonExiting = true;
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
    publicIpService.stop();
    ddnsUpdater.stop();
    braiinsDepositWatcher.stop();
    await telegramReceiver.stop();
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
    log(`    (no proposals - ${inferNoActionReason(state)})`);
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
 * diagnostics - the logic doesn't drive behaviour.
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
    return 'no owned bid yet - CREATE pending';
  }
  const primary = state.owned_bids[0]!;
  const tickSize = state.market.settings.tick_size_sat ?? 1000;
  if (Math.abs(primary.price_sat - effectiveCap) < tickSize) {
    return 'bid already at effective cap - nothing to do';
  }
  return 'bid within tolerance of effective cap - nothing to do';
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
 * (matching `timeout(1)`'s convention) - better to lose an in-flight
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
