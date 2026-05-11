/**
 * #149: per-tick poller for the operator's solo-mining devices
 * (Bitaxe / AxeOS).
 *
 * Reads the live config every tick. When `solo_mining_enabled` is
 * false the poller idles entirely (no AxeOS HTTP calls, no DB
 * writes); flipping the toggle on in Config takes effect on the
 * next tick without a daemon restart.
 *
 * Fan-out across N devices uses `Promise.allSettled` so one
 * unreachable unit can't slow a healthy fleet's poll. Each call
 * has its own 2s timeout in the AxeOSClient. The poller also
 * keeps the latest per-device snapshot in memory so HTTP routes
 * (`/api/solo-miners/snapshot`) can return without a DB round-trip.
 */

import type { AppConfig } from '../config/schema.js';
import type { SoloMinerRow, SoloMinersRepo } from '../state/repos/solo_miners.js';
import { AxeOSClient, type AxeOSFetchResult } from './axeos.js';

export interface SoloMinerSnapshotEntry {
  readonly device: SoloMinerRow;
  readonly last_polled_at: number;
  readonly reachable: boolean;
  readonly hashrate_1m_ghs: number | null;
  readonly hashrate_10m_ghs: number | null;
  readonly hashrate_1h_ghs: number | null;
  readonly expected_hashrate_ghs: number | null;
  readonly temp_c: number | null;
  readonly vr_temp_c: number | null;
  readonly power_w: number | null;
  readonly voltage_v: number | null;
  readonly current_a: number | null;
  readonly shares_accepted: number | null;
  readonly shares_rejected: number | null;
  readonly uptime_seconds: number | null;
  readonly asic_model: string | null;
  readonly version: string | null;
  readonly stratum_url: string | null;
  readonly stratum_port: number | null;
  readonly stratum_user: string | null;
  readonly error: string | null;
}

export interface SoloMinerSnapshot {
  readonly enabled: boolean;
  readonly entries: ReadonlyArray<SoloMinerSnapshotEntry>;
}

export interface AxeOSPollerOptions {
  readonly cfgRef: { value: AppConfig };
  readonly repo: SoloMinersRepo;
  readonly client?: AxeOSClient;
  readonly now?: () => number;
  readonly log?: (msg: string) => void;
}

export class AxeOSPoller {
  private readonly client: AxeOSClient;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private snapshot: SoloMinerSnapshot = { enabled: false, entries: [] };

  constructor(private readonly options: AxeOSPollerOptions) {
    this.client = options.client ?? new AxeOSClient();
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  getSnapshot(): SoloMinerSnapshot {
    return this.snapshot;
  }

  /**
   * One iteration. Called from the main daemon tick loop. Never
   * throws - any per-device error is captured into that device's
   * snapshot entry as `reachable: false, error: <message>`.
   */
  async tick(): Promise<void> {
    const cfg = this.options.cfgRef.value;
    if (!cfg.solo_mining_enabled) {
      this.snapshot = { enabled: false, entries: [] };
      return;
    }

    const devices = await this.options.repo.listEnabled();
    if (devices.length === 0) {
      this.snapshot = { enabled: true, entries: [] };
      return;
    }

    const tickAt = this.now();
    const results = await Promise.allSettled(
      devices.map(async (d) => ({ device: d, result: await this.client.getSystemInfo(d.ip) })),
    );

    const entries: SoloMinerSnapshotEntry[] = [];
    const sampleInserts = [];
    for (let i = 0; i < devices.length; i++) {
      const device = devices[i]!;
      const settled = results[i]!;
      let fetched: AxeOSFetchResult;
      if (settled.status === 'fulfilled') {
        fetched = settled.value.result;
      } else {
        // allSettled rejection shouldn't happen because getSystemInfo
        // never throws, but defensively treat it as unreachable.
        fetched = {
          reachable: false,
          info: null,
          error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
        };
      }
      const info = fetched.info ?? null;
      const entry: SoloMinerSnapshotEntry = {
        device,
        last_polled_at: tickAt,
        reachable: fetched.reachable,
        hashrate_1m_ghs: info?.hashRate_1m ?? null,
        hashrate_10m_ghs: info?.hashRate_10m ?? null,
        hashrate_1h_ghs: info?.hashRate_1h ?? null,
        expected_hashrate_ghs: info?.expectedHashrate ?? null,
        temp_c: info?.temp ?? null,
        vr_temp_c: info?.vrTemp ?? null,
        power_w: info?.power ?? null,
        voltage_v: info?.voltage ?? null,
        current_a: info?.current ?? null,
        shares_accepted: info?.sharesAccepted ?? null,
        shares_rejected: info?.sharesRejected ?? null,
        uptime_seconds: info?.uptimeSeconds ?? null,
        asic_model: info?.ASICModel ?? null,
        version: info?.version ?? null,
        stratum_url: info?.stratumURL ?? null,
        stratum_port: info?.stratumPort ?? null,
        stratum_user: info?.stratumUser ?? null,
        error: fetched.error,
      };
      entries.push(entry);
      sampleInserts.push({
        device_id: device.id,
        tick_at: tickAt,
        reachable: entry.reachable,
        hashrate_1m_ghs: entry.hashrate_1m_ghs,
        hashrate_10m_ghs: entry.hashrate_10m_ghs,
        hashrate_1h_ghs: entry.hashrate_1h_ghs,
        expected_hashrate_ghs: entry.expected_hashrate_ghs,
        temp_c: entry.temp_c,
        vr_temp_c: entry.vr_temp_c,
        power_w: entry.power_w,
        voltage_v: entry.voltage_v,
        current_a: entry.current_a,
        shares_accepted: entry.shares_accepted,
        shares_rejected: entry.shares_rejected,
        uptime_seconds: entry.uptime_seconds,
        asic_model: entry.asic_model,
        version: entry.version,
        stratum_url: entry.stratum_url,
        stratum_port: entry.stratum_port,
        stratum_user: entry.stratum_user,
      });
    }

    try {
      await this.options.repo.insertSamples(sampleInserts);
    } catch (e) {
      this.log(`[axeos-poller] sample persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.snapshot = { enabled: true, entries };
  }
}
