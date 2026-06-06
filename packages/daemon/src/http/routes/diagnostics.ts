/**
 * #272: GET /api/diagnostics - one-shot support bundle.
 *
 * Born out of #267 (and #260 before it): support conversations burned
 * days on serial rounds of "run this curl and paste the output". This
 * endpoint produces everything in one authenticated call:
 *
 *   identity     - version / build / node / uptime / run mode
 *   config       - the full effective config, with every secret-bearing
 *                  field replaced by a loud redaction marker (the user
 *                  SEES that secrets were stripped; full values for
 *                  everything else are deliberate - hostnames and LAN
 *                  addresses are exactly what support needs)
 *   connectivity - parallel live probes of every external surface the
 *                  daemon talks to, with latency and the concrete error
 *                  (HTTP status / ENOTFOUND / ECONNREFUSED / timeout)
 *   tick_health  - per-integration freshness from the most recent tick,
 *                  catching "probe succeeds but ticks fail" intermittency
 *
 * The dashboard renders this in Config -> Diagnostics with a
 * "Copy as Markdown" button for paste-ready GitHub issue reports.
 */

import { lookup } from 'node:dns/promises';

import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { BraiinsClient } from '@hashrate-autopilot/braiins-client';
import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { AppConfig } from '../../config/schema.js';
import type { Database } from '../../state/types.js';
import type { ConfigRepo } from '../../state/repos/config.js';
import type { RuntimeStateRepo } from '../../state/repos/runtime_state.js';
import { BtcPriceService, describeFetchError } from '../../services/btc-price.js';
import { DatumService } from '../../services/datum.js';
import { createElectrsClient } from '../../services/electrs-client.js';
import { BUILD, USER_AGENT } from './build.js';

/** What a stripped secret renders as - deliberately loud so the user gets visual confirmation the value is gone. */
export const REDACTED = '********** [redacted]';

/**
 * Config keys whose values are secrets. Pattern catches future fields
 * by name (token / password / credential / secret / api_key); the
 * explicit list covers the ones the pattern can't see. Operator
 * review of the first real bundle (#272) widened the set: payout
 * address, DDNS identity, and the Telegram instance label are
 * personal even though they aren't credentials.
 */
const SECRET_KEY_RE = /token|password|credential|secret|api_key|apikey/i;
const SECRET_KEYS_EXPLICIT = new Set([
  'bitcoind_rpc_user',
  'btc_payout_address',
  'ddns_hostname',
  'ddns_username',
  'telegram_instance_label',
]);

/**
 * Structured partial redaction: keep the diagnostic shape (scheme,
 * port, worker label) while stripping the identifying part.
 *   stratum+tcp://my.host:23334       -> stratum+tcp://**********[redacted]:23334
 *   bc1qabc...xyz.autopilot (worker)  -> ********** [redacted].autopilot
 */
function redactUrlHost(v: string): string {
  const m = v.match(/^([a-z0-9+.-]+:\/\/)([^/:]+)(.*)$/i);
  if (!m) return REDACTED;
  return `${m[1]}${REDACTED}${m[3]}`;
}

function redactWorkerName(v: string): string {
  const i = v.indexOf('.');
  return i > 0 ? `${REDACTED}${v.slice(i)}` : REDACTED;
}

export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== 'string' || value.length === 0) {
      out[key] = value;
      continue;
    }
    if (SECRET_KEY_RE.test(key) || SECRET_KEYS_EXPLICIT.has(key)) {
      out[key] = REDACTED;
    } else if (key === 'destination_pool_url') {
      out[key] = redactUrlHost(value);
    } else if (key === 'destination_pool_worker_name') {
      out[key] = redactWorkerName(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Public IPv4 in probe output: first octet survives (enough to spot
 * CGNAT / wrong-interface cases), the rest is visibly stripped.
 */
export function maskPublicIpv4(ip: string): string {
  const m = ip.match(/^(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  return m ? `${m[1]}.*.*.* [redacted]` : REDACTED;
}

export interface ConnectivityProbe {
  readonly target: string;
  /** 'ok' | 'failed' | 'not_configured' */
  readonly status: 'ok' | 'failed' | 'not_configured';
  readonly latency_ms: number | null;
  /** Short success detail (e.g. "chain=main height=903412"), never sensitive. */
  readonly detail: string | null;
  /** Concrete failure: HTTP status / network error code / timeout. */
  readonly error: string | null;
}

export interface DiagnosticsResponse {
  readonly identity: {
    readonly version: string;
    readonly build: number;
    readonly hash: string;
    readonly node: string;
    readonly platform: string;
    readonly uptime_seconds: number;
    readonly run_mode: string | null;
    readonly tick_interval_ms: number;
  };
  readonly config: Record<string, unknown>;
  readonly connectivity: ReadonlyArray<ConnectivityProbe>;
  readonly tick_health: {
    readonly last_tick_at: number | null;
    readonly last_tick_age_seconds: number | null;
    readonly braiins_reachable_last_tick: boolean | null;
    readonly datum_data_last_tick: boolean | null;
    readonly ocean_data_last_tick: boolean | null;
    readonly btc_price_cache_age_seconds: number | null;
  };
}

export interface DiagnosticsDeps {
  readonly configRepo: ConfigRepo;
  readonly runtimeRepo: RuntimeStateRepo;
  readonly braiinsClient: BraiinsClient;
  readonly bitcoindClient: BitcoindClient | null;
  readonly btcPriceService: BtcPriceService;
  readonly db: Kysely<Database>;
  readonly tickIntervalMs: number;
}

const PROBE_TIMEOUT_MS = 5_000;
const PRICE_SOURCES = ['coingecko', 'coinbase', 'bitstamp', 'kraken'] as const;

/** Run a probe body with a hard wall-clock budget; normalise every outcome into a ConnectivityProbe. */
async function runProbe(
  target: string,
  fn: () => Promise<string | null>,
): Promise<ConnectivityProbe> {
  const started = Date.now();
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
      ),
    ]);
    return { target, status: 'ok', latency_ms: Date.now() - started, detail, error: null };
  } catch (err) {
    return {
      target,
      status: 'failed',
      latency_ms: Date.now() - started,
      detail: null,
      error: describeFetchError(err),
    };
  }
}

function notConfigured(target: string): ConnectivityProbe {
  return { target, status: 'not_configured', latency_ms: null, detail: null, error: null };
}

function fetchOpts(): RequestInit {
  return {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  };
}

async function probeConnectivity(
  cfg: AppConfig,
  deps: DiagnosticsDeps,
): Promise<ConnectivityProbe[]> {
  const probes: Array<Promise<ConnectivityProbe>> = [];

  // DNS sanity first - splits "DNS broken" from "route broken" for
  // every name-based probe below it.
  probes.push(
    runProbe('dns (api.ocean.xyz)', async () => {
      const r = await lookup('api.ocean.xyz');
      return `resolved ${r.address}`;
    }),
  );

  // Braiins marketplace - public endpoint, no token involved.
  probes.push(
    runProbe('braiins api', async () => {
      await deps.braiinsClient.getStats();
      return null;
    }),
  );

  // Ocean pool API - public pool-wide stats endpoint.
  probes.push(
    runProbe('ocean api', async () => {
      const res = await fetch('https://api.ocean.xyz/v1/pool_stat', fetchOpts());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return null;
    }),
  );

  // Datum gateway - operator's own LAN/host URL.
  const datumApiUrl = cfg.datum_api_url?.trim() ?? '';
  if (datumApiUrl.length > 0) {
    probes.push(
      runProbe('datum gateway', async () => {
        const service = new DatumService({ apiUrl: datumApiUrl, timeoutMs: PROBE_TIMEOUT_MS });
        const result = await service.poll();
        if (!result.reachable) throw new Error(result.error ?? 'unreachable');
        return result.connections !== null ? `${result.connections} connection(s)` : null;
      }),
    );
  } else {
    probes.push(Promise.resolve(notConfigured('datum gateway')));
  }

  // bitcoind RPC - via the daemon's wired client (reflects the running config).
  if (deps.bitcoindClient) {
    probes.push(
      runProbe('bitcoind rpc', async () => {
        const info = await deps.bitcoindClient!.getBlockchainInfo();
        return `chain=${info.chain} height=${info.blocks}`;
      }),
    );
  } else {
    probes.push(Promise.resolve(notConfigured('bitcoind rpc')));
  }

  // electrs - Electrum-protocol probe against the configured host/port.
  if (cfg.electrs_host && cfg.electrs_port) {
    probes.push(
      runProbe('electrs', async () => {
        const client = await createElectrsClient({
          host: cfg.electrs_host!,
          port: cfg.electrs_port!,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        try {
          await client.getBlockVersionByHeight(0);
          return null;
        } finally {
          client.close();
        }
      }),
    );
  } else {
    probes.push(Promise.resolve(notConfigured('electrs')));
  }

  // Telegram bot API - getMe with the configured token; the token never
  // appears in the result, only reachability.
  if (cfg.telegram_bot_token && cfg.telegram_bot_token.trim().length > 0) {
    probes.push(
      runProbe('telegram api', async () => {
        const res = await fetch(
          `https://api.telegram.org/bot${cfg.telegram_bot_token}/getMe`,
          fetchOpts(),
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return null;
      }),
    );
  } else {
    probes.push(Promise.resolve(notConfigured('telegram api')));
  }

  // All four price providers, regardless of which one is selected -
  // the #267 question ("is it one provider or my network?") answered
  // in a single sweep. warmCache=false so the sweep doesn't leave the
  // price cache pointing at a non-selected provider.
  for (const source of PRICE_SOURCES) {
    probes.push(
      runProbe(`price: ${source}`, async () => {
        const r = await deps.btcPriceService.probe(source, { warmCache: false });
        if (!r.ok) throw new Error(r.error ?? 'failed');
        return `$${r.usd_per_btc?.toFixed(0) ?? '?'}`;
      }),
    );
  }

  // Public-IP service (ipify) - feeds DDNS + IP-change tracking.
  probes.push(
    runProbe('public-ip (api.ipify.org)', async () => {
      const res = await fetch('https://api.ipify.org?format=json', fetchOpts());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ip?: string };
      return body.ip ? `IPv4 obtained (${maskPublicIpv4(body.ip)})` : 'IPv4 obtained';
    }),
  );

  return Promise.all(probes);
}

export async function registerDiagnosticsRoute(
  app: FastifyInstance,
  deps: DiagnosticsDeps,
): Promise<void> {
  app.get('/api/diagnostics', async (): Promise<DiagnosticsResponse> => {
    const cfg = await deps.configRepo.get();
    if (!cfg) {
      throw new Error('config not initialised');
    }

    const [connectivity, runtime, lastTick] = await Promise.all([
      probeConnectivity(cfg, deps),
      deps.runtimeRepo.get().catch(() => null),
      deps.db
        .selectFrom('tick_metrics')
        .select(['tick_at', 'braiins_reachable', 'datum_hashrate_ph', 'ocean_hashrate_ph'])
        .orderBy('tick_at', 'desc')
        .limit(1)
        .executeTakeFirst()
        .catch(() => undefined),
    ]);

    const now = Date.now();
    const priceCache = deps.btcPriceService.getLatest();

    return {
      identity: {
        version: BUILD.version,
        build: BUILD.build,
        hash: BUILD.hash,
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        uptime_seconds: Math.round(process.uptime()),
        run_mode: runtime?.run_mode ?? null,
        tick_interval_ms: deps.tickIntervalMs,
      },
      config: redactConfig(cfg as unknown as Record<string, unknown>),
      connectivity,
      tick_health: {
        last_tick_at: lastTick?.tick_at ?? null,
        last_tick_age_seconds: lastTick ? Math.round((now - lastTick.tick_at) / 1000) : null,
        braiins_reachable_last_tick:
          lastTick?.braiins_reachable === null || lastTick?.braiins_reachable === undefined
            ? null
            : lastTick.braiins_reachable === 1,
        datum_data_last_tick: lastTick ? lastTick.datum_hashrate_ph !== null : null,
        ocean_data_last_tick: lastTick ? lastTick.ocean_hashrate_ph !== null : null,
        btc_price_cache_age_seconds: priceCache
          ? Math.round((now - priceCache.fetched_at_ms) / 1000)
          : null,
      },
    };
  });
}
