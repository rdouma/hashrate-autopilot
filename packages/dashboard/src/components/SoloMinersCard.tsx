/**
 * #149: Solo-mining fleet card for /status.
 *
 * Renders one row per operator-configured Bitaxe / AxeOS device,
 * with hashrate / temperature / VR temperature / power draw / share-
 * rejection rate / uptime, colour-coded against the operator's
 * thermal + rejection thresholds. A summary row at the bottom
 * carries the fleet totals (hashrate sum, power sum, J/TH efficiency,
 * active device count).
 *
 * The card is gated on `solo_mining_enabled` from the snapshot
 * response itself - when the master toggle is off the daemon returns
 * `{ enabled: false }` and the card renders nothing (the operator
 * sees no placeholder for a feature they haven't opted in to).
 */

import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useQuery } from '@tanstack/react-query';

import { api, type SoloMinerSnapshotEntry } from '../lib/api';
import { formatAge } from '../lib/format';
import { useFormatters } from '../lib/locale';

const REFRESH_INTERVAL_MS = 5_000;

export function SoloMinersCard() {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();

  const query = useQuery({
    queryKey: ['solo-miners'],
    queryFn: api.soloMiners,
    refetchInterval: REFRESH_INTERVAL_MS,
    placeholderData: (prev) => prev,
  });

  // Off-by-default: when the master toggle is off the daemon returns
  // `enabled: false`, which we render as "nothing." No placeholder,
  // no empty card - operators who haven't opted in see no clutter.
  if (!query.data || !query.data.snapshot.enabled) return null;

  const { entries } = query.data.snapshot;
  if (entries.length === 0) {
    return (
      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">
          <Trans>Solo miners</Trans>
        </h3>
        <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-500 italic">
          <Trans>
            Solo-mining monitoring is enabled but no devices have been added yet. Add a Bitaxe IP
            on Config → Display &amp; Logging → Solo miners.
          </Trans>
        </div>
      </section>
    );
  }

  const fleet = aggregateFleet(entries);

  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2">
        <Trans>Solo miners</Trans>
      </h3>
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="text-slate-500 uppercase tracking-wider bg-slate-950/40">
            <tr>
              <th className="text-left font-normal py-1.5 px-3"><Trans>Device</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Hashrate</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Temp</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>VR temp</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Power</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Rejected</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Uptime</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Polled</Trans></th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {entries.map((e) => (
              <DeviceRow key={e.device.id} entry={e} fmt={fmt} />
            ))}
            <tr className="border-t border-slate-700 bg-slate-950/40 font-semibold">
              <td className="py-1.5 px-3 text-slate-300">
                <Trans>Fleet</Trans>{' '}
                <span className="text-slate-500 text-[10px]">
                  ({fleet.active_count}/{entries.length} <Trans>active</Trans>)
                </span>
              </td>
              <td className="py-1.5 px-3 text-right font-mono">
                {fleet.total_hashrate_ghs !== null
                  ? `${formatGhs(fleet.total_hashrate_ghs)}`
                  : '-'}
              </td>
              <td colSpan={2} className="py-1.5 px-3 text-right text-slate-500 text-[10px]">
                {fleet.efficiency_j_per_th !== null
                  ? `${fleet.efficiency_j_per_th.toFixed(1)} J/TH`
                  : ''}
              </td>
              <td className="py-1.5 px-3 text-right font-mono">
                {fleet.total_power_w !== null ? `${fleet.total_power_w.toFixed(1)} W` : '-'}
              </td>
              <td colSpan={3}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface FleetTotals {
  readonly total_hashrate_ghs: number | null;
  readonly total_power_w: number | null;
  readonly efficiency_j_per_th: number | null;
  readonly active_count: number;
}

function aggregateFleet(entries: ReadonlyArray<SoloMinerSnapshotEntry>): FleetTotals {
  let hashSum = 0;
  let powerSum = 0;
  let active = 0;
  let hashSeen = false;
  let powerSeen = false;
  for (const e of entries) {
    if (!e.reachable) continue;
    if (e.hashrate_10m_ghs !== null && e.hashrate_10m_ghs > 0) {
      hashSum += e.hashrate_10m_ghs;
      hashSeen = true;
      active += 1;
    }
    if (e.power_w !== null) {
      powerSum += e.power_w;
      powerSeen = true;
    }
  }
  const total_hashrate_ghs = hashSeen ? hashSum : null;
  const total_power_w = powerSeen ? powerSum : null;
  // J/TH = (W) / (TH/s). Hashrate in GH/s, divide by 1000 -> TH/s.
  const efficiency_j_per_th =
    total_hashrate_ghs !== null && total_hashrate_ghs > 0 && total_power_w !== null
      ? total_power_w / (total_hashrate_ghs / 1000)
      : null;
  return { total_hashrate_ghs, total_power_w, efficiency_j_per_th, active_count: active };
}

function DeviceRow({
  entry,
  fmt,
}: {
  entry: SoloMinerSnapshotEntry;
  fmt: ReturnType<typeof useFormatters>;
}) {
  if (!entry.reachable) {
    return (
      <tr className="border-t border-slate-800">
        <td className="py-1.5 px-3">
          <span className="text-slate-200">{entry.device.label}</span>{' '}
          <span className="text-slate-500 font-mono text-[10px]">{entry.device.ip}</span>
        </td>
        <td colSpan={6} className="py-1.5 px-3 text-red-300 text-[11px] italic">
          {entry.error
            ? t`unreachable: ${entry.error}`
            : t`unreachable`}
        </td>
        <td className="py-1.5 px-3 text-right text-[10px] text-slate-500 font-mono">
          {fmt.timestamp(entry.last_polled_at)}
        </td>
      </tr>
    );
  }

  const rejectionPct = computeRejectionPct(entry.shares_accepted, entry.shares_rejected);

  return (
    <tr className="border-t border-slate-800">
      <td className="py-1.5 px-3">
        <div className="text-slate-200">{entry.device.label}</div>
        <div className="text-[10px] text-slate-500 font-mono">
          {entry.device.ip}
          {entry.asic_model && <span className="ml-2">{entry.asic_model}</span>}
        </div>
      </td>
      <td className="py-1.5 px-3 text-right font-mono">
        {entry.hashrate_10m_ghs !== null ? formatGhs(entry.hashrate_10m_ghs) : '-'}
      </td>
      <td className={`py-1.5 px-3 text-right font-mono ${tempClass(entry.temp_c)}`}>
        {entry.temp_c !== null ? `${entry.temp_c.toFixed(1)} °C` : '-'}
      </td>
      <td className={`py-1.5 px-3 text-right font-mono ${tempClass(entry.vr_temp_c)}`}>
        {entry.vr_temp_c !== null ? `${entry.vr_temp_c.toFixed(1)} °C` : '-'}
      </td>
      <td className="py-1.5 px-3 text-right font-mono">
        {entry.power_w !== null ? `${entry.power_w.toFixed(1)} W` : '-'}
      </td>
      <td className={`py-1.5 px-3 text-right font-mono ${rejectionClass(rejectionPct)}`}>
        {rejectionPct !== null ? `${rejectionPct.toFixed(2)} %` : '-'}
      </td>
      <td className="py-1.5 px-3 text-right text-slate-400">
        {entry.uptime_seconds !== null ? formatUptime(entry.uptime_seconds) : '-'}
      </td>
      <td className="py-1.5 px-3 text-right text-[10px] text-slate-500 font-mono">
        {formatAge(entry.last_polled_at)}
      </td>
    </tr>
  );
}

function formatGhs(ghs: number): string {
  if (ghs >= 1_000_000) return `${(ghs / 1_000_000).toFixed(2)} PH/s`;
  if (ghs >= 1_000) return `${(ghs / 1_000).toFixed(2)} TH/s`;
  return `${ghs.toFixed(1)} GH/s`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remMin = m % 60;
  if (h < 24) return remMin > 0 ? `${h}h ${remMin}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

function tempClass(temp: number | null): string {
  if (temp === null) return 'text-slate-500';
  if (temp >= 70) return 'text-red-300';
  if (temp >= 65) return 'text-amber-300';
  return 'text-slate-200';
}

function rejectionClass(pct: number | null): string {
  if (pct === null) return 'text-slate-500';
  if (pct >= 10) return 'text-red-300';
  if (pct >= 5) return 'text-amber-300';
  return 'text-slate-200';
}

function computeRejectionPct(
  accepted: number | null,
  rejected: number | null,
): number | null {
  if (accepted === null || rejected === null) return null;
  const total = accepted + rejected;
  if (total <= 0) return null;
  return (rejected / total) * 100;
}
