/**
 * #149: HTTP client for AxeOS / ESP-Miner devices (Bitaxe / Nerdaxe /
 * any compatible fork running the bitaxeorg/ESP-Miner firmware).
 *
 * AxeOS exposes an unauthenticated REST API on the local network
 * (https://osmu.wiki/bitaxe/api/). The only "auth" is an IP-allowlist
 * "client not in allowed network range" 401, so no credentials are
 * threaded through this client - the daemon's host has to be on the
 * same LAN as the device.
 *
 * Currently used: GET /api/system/info. Other endpoints (restart /
 * identify / OTA) are explicitly out of scope for v1 - any mutating
 * action on a Bitaxe needs the same explicit operator green-light
 * path the rest of the mutation-gated APIs follow, and we haven't
 * wired that yet.
 */

export interface AxeOSSystemInfo {
  /** Live hashrate (sum across cores) in GH/s. AxeOS publishes the smoothed window variants alongside. */
  hashRate?: number;
  hashRate_1m?: number;
  hashRate_10m?: number;
  hashRate_1h?: number;
  /** Spec-sheet expected hashrate for the configured ASIC voltage/freq combo, GH/s. */
  expectedHashrate?: number;
  /** ASIC junction temperature (°C). */
  temp?: number;
  temp2?: number;
  /** Voltage regulator temperature (°C). */
  vrTemp?: number;
  /** Live power draw (W). */
  power?: number;
  voltage?: number;
  current?: number;
  maxPower?: number;
  nominalVoltage?: number;
  /** Cumulative since-power-on share counters. */
  sharesAccepted?: number;
  sharesRejected?: number;
  sharesRejectedReasons?: ReadonlyArray<unknown>;
  uptimeSeconds?: number;
  /** Chip family identifier (e.g. "BM1370", "BM1368"). Used by the alert evaluator to pick a default thermal ceiling. */
  ASICModel?: string;
  version?: string;
  stratumURL?: string;
  stratumPort?: number;
  stratumUser?: string;
  bestDiff?: string;
  bestSessionDiff?: string;
  poolDifficulty?: number;
  errorPercentage?: number;
  isUsingFallbackStratum?: number | boolean;
  // Catch-all so future firmware additions don't get type-erased by
  // an aggressive `unknown`. We accept any extra fields the API
  // returns; the daemon ignores what it doesn't recognise.
  readonly [k: string]: unknown;
}

export interface AxeOSFetchResult {
  readonly reachable: boolean;
  readonly info: AxeOSSystemInfo | null;
  readonly error: string | null;
}

export interface AxeOSClientOptions {
  /** Per-call timeout in milliseconds. Default 2s - keeps a non-responding device from blocking the poll fan-out. */
  readonly timeoutMs?: number;
  /** Fetch implementation override - tests inject a mock. */
  readonly fetchImpl?: typeof fetch;
}

export class AxeOSClient {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AxeOSClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * GET http://<ip>/api/system/info. Never throws - returns a
   * structured `{ reachable, info, error }` so callers can persist
   * the unreachable case as a sample row without try/catch
   * pollution.
   */
  async getSystemInfo(ip: string): Promise<AxeOSFetchResult> {
    const url = `http://${ip}/api/system/info`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!resp.ok) {
        return { reachable: false, info: null, error: `HTTP ${resp.status}` };
      }
      const body = (await resp.json()) as AxeOSSystemInfo;
      return { reachable: true, info: body, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { reachable: false, info: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Per-ASIC-model default overheating ceiling (°C). The alert
 * evaluator uses this when the operator's global override
 * (`config.solo_overheating_threshold_celsius`) is 0.
 *
 * Sources: AxeOS / Bitaxe community spec sheets. The newer 5nm
 * BM1370 (Gamma) has a tighter thermal envelope than the older
 * 7nm BM1397 (Max). All numbers are conservative junction-temp
 * defaults - operators with active cooling can raise via the
 * config override.
 */
const ASIC_THERMAL_CEILINGS: Record<string, number> = {
  BM1370: 68, // Bitaxe Gamma
  BM1368: 70, // Bitaxe Supra
  BM1366: 70, // Bitaxe Ultra
  BM1397: 75, // Bitaxe Max (original)
};
const ASIC_THERMAL_FALLBACK = 70;

export function overheatingCeilingForAsic(asicModel: string | null | undefined): number {
  if (!asicModel) return ASIC_THERMAL_FALLBACK;
  return ASIC_THERMAL_CEILINGS[asicModel] ?? ASIC_THERMAL_FALLBACK;
}
