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
import { formatAge, formatTemperature } from '../lib/format';
import { useFormatters, useTemperatureUnit } from '../lib/locale';

const REFRESH_INTERVAL_MS = 5_000;

export function SoloMinersCard() {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const tempUnit = useTemperatureUnit();

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

  // Sort alphabetically by label (case-insensitive); ties fall back
  // to natural-order IP comparison so a single-digit-octet IP doesn't
  // sort after a triple-digit one (192.168.1.9 before 192.168.1.10).
  // Operator preference: labels carry intent, so they're the primary
  // key. IP is the tiebreaker for "same label" edge cases.
  const entries = [...query.data.snapshot.entries].sort((a, b) => {
    const la = a.device.label.toLowerCase();
    const lb = b.device.label.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return compareIpv4(a.device.ip, b.device.ip);
  });
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

      {/* Mobile-only stacked card layout: one card per device with
          key/value rows. The 9-column table below is hidden under
          640px because squeezing it forced text-[10px] tick labels
          and still pushed past the right margin on iPhone-class
          widths. */}
      <div className="sm:hidden space-y-2">
        {entries.map((e) => (
          <DeviceMobileCard key={e.device.id} entry={e} fmt={fmt} tempUnit={tempUnit} />
        ))}
        <FleetMobileSummary fleet={fleet} entries={entries} />
      </div>

      <div className="hidden sm:block bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500 uppercase tracking-wider bg-slate-950/40">
            <tr>
              <th className="text-left font-normal py-1.5 px-3"><Trans>Device</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Hashrate</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Best diff</Trans></th>
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
              <DeviceRow key={e.device.id} entry={e} fmt={fmt} tempUnit={tempUnit} />
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
              <td className="py-1.5 px-3 text-right font-mono">
                {fleet.best_diff_text ?? '-'}
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
  readonly best_diff_text: string | null;
}

/**
 * Pick the most useful hashrate reading from an entry. Prefer the
 * smoothed 10m window when present, then 1m, then 1h, then the bare
 * instantaneous reading. Older AxeOS firmware (and some current
 * firmware on certain ASIC families) only populates the bare field;
 * without this fallback the Status card renders "-" for reachable
 * devices that are clearly mining (the operator caught this with
 * three healthy units reporting null hashrate).
 */
export function liveHashrateGhs(entry: SoloMinerSnapshotEntry): number | null {
  if (entry.hashrate_10m_ghs !== null && entry.hashrate_10m_ghs > 0) return entry.hashrate_10m_ghs;
  if (entry.hashrate_1m_ghs !== null && entry.hashrate_1m_ghs > 0) return entry.hashrate_1m_ghs;
  if (entry.hashrate_1h_ghs !== null && entry.hashrate_1h_ghs > 0) return entry.hashrate_1h_ghs;
  if (entry.hashrate_instant_ghs !== null && entry.hashrate_instant_ghs > 0)
    return entry.hashrate_instant_ghs;
  return null;
}

function aggregateFleet(entries: ReadonlyArray<SoloMinerSnapshotEntry>): FleetTotals {
  let hashSum = 0;
  let powerSum = 0;
  let active = 0;
  let hashSeen = false;
  let powerSeen = false;
  let bestDiffNum = -Infinity;
  let bestDiffText: string | null = null;
  for (const e of entries) {
    if (!e.reachable) continue;
    const live = liveHashrateGhs(e);
    if (live !== null && live > 0) {
      hashSum += live;
      hashSeen = true;
      active += 1;
    }
    if (e.power_w !== null) {
      powerSum += e.power_w;
      powerSeen = true;
    }
    if (e.best_diff_text !== null) {
      const parsed = parseMagnitudeSuffixed(e.best_diff_text);
      if (parsed !== null && parsed > bestDiffNum) {
        bestDiffNum = parsed;
        bestDiffText = e.best_diff_text;
      }
    }
  }
  const total_hashrate_ghs = hashSeen ? hashSum : null;
  const total_power_w = powerSeen ? powerSum : null;
  // J/TH = (W) / (TH/s). Hashrate in GH/s, divide by 1000 -> TH/s.
  const efficiency_j_per_th =
    total_hashrate_ghs !== null && total_hashrate_ghs > 0 && total_power_w !== null
      ? total_power_w / (total_hashrate_ghs / 1000)
      : null;
  return {
    total_hashrate_ghs,
    total_power_w,
    efficiency_j_per_th,
    active_count: active,
    best_diff_text: bestDiffText,
  };
}

/**
 * Parse an AxeOS magnitude-suffixed difficulty string like
 * "149.53G", "225.68M", "1.77M" into a comparable number. Suffixes
 * are SI-style ratios (K = 1e3 ... E = 1e18). Returns null for
 * malformed inputs so the caller can decide whether to surface
 * "-" or skip the device.
 */
function parseMagnitudeSuffixed(s: string): number | null {
  const m = s.match(/^([\d.]+)([KMGTPE]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? '').toUpperCase();
  const mult =
    suffix === 'K' ? 1e3
    : suffix === 'M' ? 1e6
    : suffix === 'G' ? 1e9
    : suffix === 'T' ? 1e12
    : suffix === 'P' ? 1e15
    : suffix === 'E' ? 1e18
    : 1;
  return n * mult;
}

function DeviceRow({
  entry,
  fmt,
  tempUnit,
}: {
  entry: SoloMinerSnapshotEntry;
  fmt: ReturnType<typeof useFormatters>;
  tempUnit: 'C' | 'F';
}) {
  if (!entry.reachable) {
    return (
      <tr className="border-t border-slate-800">
        <td className="py-1.5 px-3">
          <span className="text-slate-200">{entry.device.label}</span>{' '}
          <span className="text-slate-500 font-mono text-[10px]">{entry.device.ip}</span>
        </td>
        <td colSpan={7} className="py-1.5 px-3 text-red-300 text-[11px] italic">
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
        {(() => {
          const v = liveHashrateGhs(entry);
          return v !== null ? formatGhs(v) : '-';
        })()}
      </td>
      <td
        className="py-1.5 px-3 text-right font-mono"
        title={
          entry.best_session_diff_text
            ? `session: ${entry.best_session_diff_text}`
            : undefined
        }
      >
        {entry.best_diff_text ?? '-'}
      </td>
      <td className={`py-1.5 px-3 text-right font-mono ${asicTempClass(entry.temp_c)}`}>
        {formatTemperature(entry.temp_c, tempUnit)}
      </td>
      <td
        className={`py-1.5 px-3 text-right font-mono ${vrTempClass(entry.vr_temp_c)}`}
        title={
          entry.vr_temp_c === 0
            ? 'no VR temp sensor on this board (typical on older Bitaxe Supra / Max revisions)'
            : undefined
        }
      >
        {/* Treat exactly 0.0 °C as "no sensor wired" - a running
            ASIC + VRM never actually reads 0 °C, and older Supra /
            Max board revisions return 0 instead of a missing-sensor
            flag. Avoids the visually-alarming "your VR is freezing"
            misread. */}
        {entry.vr_temp_c !== null && entry.vr_temp_c !== 0
          ? formatTemperature(entry.vr_temp_c, tempUnit)
          : '-'}
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

/**
 * ASIC silicon-junction temperature classes. AxeOS firmware's
 * `THROTTLE_TEMP = 75 °C` is the point at which the miner itself
 * reduces frequency. Red at 75 matches that authoritative threshold
 * (and the daemon's overheating alert); amber at 70 gives the
 * operator a heads-up window before AxeOS takes action.
 */
function asicTempClass(temp: number | null): string {
  if (temp === null || temp === 0) return 'text-slate-500';
  if (temp >= 75) return 'text-red-300';
  if (temp >= 70) return 'text-amber-300';
  return 'text-slate-200';
}

/**
 * VR (TPS546 buck-converter) temperature classes. AxeOS firmware's
 * `TPS546_THROTTLE_TEMP = 105 °C` is the regulator's action
 * threshold. Red at 100 (matches the daemon's
 * `VR_OVERHEATING_CEILING_C`, fires 5 °C before AxeOS itself
 * throttles); amber at 90 as the heads-up. 0.0 °C means "no sensor
 * wired" on older Bitaxe Supra / Max revisions; render muted.
 */
function vrTempClass(temp: number | null): string {
  if (temp === null || temp === 0) return 'text-slate-500';
  if (temp >= 100) return 'text-red-300';
  if (temp >= 90) return 'text-amber-300';
  return 'text-slate-200';
}

function rejectionClass(pct: number | null): string {
  if (pct === null) return 'text-slate-500';
  if (pct >= 10) return 'text-red-300';
  if (pct >= 5) return 'text-amber-300';
  return 'text-slate-200';
}

function compareIpv4(a: string, b: string): number {
  // Octet-aware compare so "192.168.1.9" sorts before "192.168.1.10".
  // For non-IPv4 inputs (e.g. an IPv6 literal or a hostname) we fall
  // back to a plain string compare, which is fine since the alphabetic
  // label sort upstream will have handled almost every case anyway.
  const aIsIp4 = /^\d+\.\d+\.\d+\.\d+$/.test(a);
  const bIsIp4 = /^\d+\.\d+\.\d+\.\d+$/.test(b);
  if (aIsIp4 && bIsIp4) {
    const ap = a.split('.').map(Number);
    const bp = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) {
      const d = (ap[i] ?? 0) - (bp[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
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

// ---------------------------------------------------------------------
// Mobile (< sm): card-per-device layout. The desktop table at 9 columns
// can't shrink below ~450px without truncating values; on iPhone-class
// 375px widths the only legible representation is stacking each device
// into its own card with key/value pairs.
// ---------------------------------------------------------------------

function DeviceMobileCard({
  entry,
  fmt,
  tempUnit,
}: {
  entry: SoloMinerSnapshotEntry;
  fmt: ReturnType<typeof useFormatters>;
  tempUnit: 'C' | 'F';
}) {
  const rejectionPct = computeRejectionPct(entry.shares_accepted, entry.shares_rejected);
  const liveGhs = liveHashrateGhs(entry);
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 text-xs">
      <div className="flex items-baseline justify-between mb-2">
        <div className="min-w-0 flex-1 pr-2">
          <div className="text-slate-200 truncate">{entry.device.label}</div>
          <div className="text-[10px] text-slate-500 font-mono truncate">
            {entry.device.ip}
            {entry.asic_model && <span className="ml-2">{entry.asic_model}</span>}
          </div>
        </div>
        <div className="text-[10px] text-slate-500 font-mono whitespace-nowrap">
          {fmt.timestamp(entry.last_polled_at)}
        </div>
      </div>
      {!entry.reachable ? (
        <div className="text-red-300 text-[11px] italic">
          {entry.error ? t`unreachable: ${entry.error}` : t`unreachable`}
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <MobileStat
            label={t`Hashrate`}
            value={liveGhs !== null ? formatGhs(liveGhs) : '-'}
          />
          <MobileStat
            label={t`Best diff`}
            value={entry.best_diff_text ?? '-'}
          />
          <MobileStat
            label={t`Temp`}
            value={formatTemperature(entry.temp_c, tempUnit)}
            valueClass={asicTempClass(entry.temp_c)}
          />
          <MobileStat
            label={t`VR temp`}
            value={
              entry.vr_temp_c !== null && entry.vr_temp_c !== 0
                ? formatTemperature(entry.vr_temp_c, tempUnit)
                : '-'
            }
            valueClass={vrTempClass(entry.vr_temp_c)}
          />
          <MobileStat
            label={t`Power`}
            value={entry.power_w !== null ? `${entry.power_w.toFixed(1)} W` : '-'}
          />
          <MobileStat
            label={t`Rejected`}
            value={rejectionPct !== null ? `${rejectionPct.toFixed(2)} %` : '-'}
            valueClass={rejectionClass(rejectionPct)}
          />
          <MobileStat
            label={t`Uptime`}
            value={entry.uptime_seconds !== null ? formatUptime(entry.uptime_seconds) : '-'}
          />
        </dl>
      )}
    </div>
  );
}

function MobileStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <dt className="text-slate-500 uppercase tracking-wider text-[10px]">{label}</dt>
      <dd
        className={`font-mono truncate ${valueClass ?? 'text-slate-200'}`}
      >
        {value}
      </dd>
    </div>
  );
}

function FleetMobileSummary({
  fleet,
  entries,
}: {
  fleet: FleetTotals;
  entries: ReadonlyArray<SoloMinerSnapshotEntry>;
}) {
  return (
    <div className="bg-slate-950/40 border border-slate-700 rounded-lg p-3 text-xs">
      <div className="text-slate-300 font-semibold mb-2">
        <Trans>Fleet</Trans>{' '}
        <span className="text-slate-500 text-[10px] font-normal">
          ({fleet.active_count}/{entries.length} <Trans>active</Trans>)
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <MobileStat
          label={t`Hashrate`}
          value={
            fleet.total_hashrate_ghs !== null ? formatGhs(fleet.total_hashrate_ghs) : '-'
          }
        />
        <MobileStat
          label={t`Best diff`}
          value={fleet.best_diff_text ?? '-'}
        />
        <MobileStat
          label={t`Power`}
          value={fleet.total_power_w !== null ? `${fleet.total_power_w.toFixed(1)} W` : '-'}
        />
        <MobileStat
          label={t`Efficiency`}
          value={
            fleet.efficiency_j_per_th !== null
              ? `${fleet.efficiency_j_per_th.toFixed(1)} J/TH`
              : '-'
          }
        />
      </dl>
    </div>
  );
}
