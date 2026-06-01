/**
 * BIP 110 scan card - Status-page diagnostic that fires the
 * `/api/bip110/scan` endpoint and renders the deployment header +
 * signaling block list. Cards on mobile, table on desktop.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';

import { api } from '../lib/api';
import type {
  Bip110EpochBucket,
  Bip110ScanDeployment,
  Bip110ScanResponse,
  Bip110ScanSignalingBlock,
} from '../lib/api';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { formatAgeMinutes, formatNumber } from '../lib/format';
import { useDateTimeLocale, useFormatters, useLocale } from '../lib/locale';
import { Tooltip } from './Tooltip';

/**
 * Compact date-range string for the per-epoch breakdown's secondary
 * line. Uses `dateStyle: 'medium'` (locale-aware) on both endpoints,
 * collapsed to a single date when both fall on the same calendar day
 * (in-progress epoch right after a retarget). The UI-language locale
 * drives month-name language so a Dutch UI gets Dutch month names
 * even when the number-format preset is set to en-US.
 *
 * #233: when `forecastMs` is non-null, the right endpoint becomes
 * the forecasted retarget date instead of the literal last-scanned
 * block time (which is just "≈ now" for the in-progress epoch). The
 * caller gets back a tuple with the rendered string + an estimation
 * flag so the UI can append "(est.)" or otherwise mark uncertainty.
 */
function formatEpochDateRange(
  startMs: number,
  endMs: number,
  dateTimeLocale: string,
  forecastMs: number | null = null,
): { text: string; estimated: boolean } {
  const fmt = new Intl.DateTimeFormat(dateTimeLocale, { dateStyle: 'medium' });
  const startDate = new Date(startMs);
  const rightDate = new Date(forecastMs ?? endMs);
  const sameDay =
    startDate.getFullYear() === rightDate.getFullYear() &&
    startDate.getMonth() === rightDate.getMonth() &&
    startDate.getDate() === rightDate.getDate();
  const text = sameDay
    ? fmt.format(startDate)
    : `${fmt.format(startDate)} – ${fmt.format(rightDate)}`;
  return { text, estimated: forecastMs !== null };
}

/**
 * #231 follow-up #3: range is a two-option choice. `current` shows
 * the in-progress difficulty epoch (live MASF window). `all` shows
 * every difficulty epoch since the first known BIP 110 signaling
 * block (height 938,903, 2026-03-01) - a bounded ~13k-block scan
 * that takes single-digit seconds on a healthy node.
 */
type ScanRange = 'current' | 'all';

/** BIP 110 MASF activation threshold: 55% of an epoch's blocks. */
const MASF_THRESHOLD_PCT = 55;
/** Absolute signaling-block count needed to cross MASF threshold in
 *  a difficulty epoch. Used as the per-row progress-bar denominator
 *  (#233 moved the bar from the header to inside each epoch row). */
const BLOCKS_PER_EPOCH = 2016;
const MASF_THRESHOLD_BLOCKS = Math.ceil(BLOCKS_PER_EPOCH * (MASF_THRESHOLD_PCT / 100));
/** BIP 110 UASF flag-day block height. At this height, BIP 110-aware
 *  nodes begin enforcing the rules regardless of miner signaling. */
const UASF_HEIGHT_BIP110 = 965_664;

/** Bitcoin's protocol-target block time. The chain retargets every
 *  2016 blocks to bring the moving-window average toward this. */
const TARGET_BLOCK_TIME_MS = 600_000;

/**
 * Estimated wall-clock time at which the chain will reach
 * `targetHeight`, computed as `now + (target - tip) × 600s`. Matches
 * the formula every block-time calculator on the internet uses
 * (bennet.org's tool, the operator's own hand math at
 * 144 blocks/day), so the displayed estimate matches what the
 * operator can verify independently.
 *
 * A previous draft used the observed average block time from the
 * in-progress difficulty epoch instead of the 600s target - more
 * accurate over short horizons but visibly off vs every other tool
 * over the ~95-day horizon to UASF. Operator's expectation is the
 * target-rate baseline, so we use it.
 *
 * Null when the target is already past, or when we don't know the
 * tip height (no scan yet).
 */
function forecastBlockHeightTime(
  targetHeight: number,
  tipHeight: number | null,
  nowMs: number = Date.now(),
): number | null {
  if (tipHeight === null || tipHeight >= targetHeight) return null;
  return nowMs + (targetHeight - tipHeight) * TARGET_BLOCK_TIME_MS;
}

function formatMediumDate(ms: number, dateTimeLocale: string): string {
  return new Intl.DateTimeFormat(dateTimeLocale, { dateStyle: 'medium' }).format(new Date(ms));
}

const BIP110_REFERENCE_URL = 'https://bip110.org/';

function formatBtc(sat: number): string {
  return (sat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0');
}

function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

/** #234: deterministic color picker for the miner-badge avatar. The
 *  pool the operator mines on is always Ocean; the meaningful
 *  identity is the miner who built the template, so this colors a
 *  per-miner badge (a "M" in front of "Roughnecks", etc.). Same
 *  hash-of-tag → index logic the PoolBadge had; only the surface
 *  naming changed. */
const MINER_COLORS = [
  'bg-amber-600', 'bg-emerald-600', 'bg-sky-600', 'bg-violet-600',
  'bg-rose-600', 'bg-teal-600', 'bg-orange-600', 'bg-indigo-600',
];

function minerColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return MINER_COLORS[Math.abs(h) % MINER_COLORS.length]!;
}

function MinerBadge({ tag }: { tag: string }): React.JSX.Element {
  const initial = tag.replace(/^[^a-zA-Z0-9]*/, '').charAt(0).toUpperCase() || '?';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300 truncate max-w-[180px]" title={tag}>
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-white ${minerColor(tag)}`}>
        {initial}
      </span>
      <span className="truncate">{tag}</span>
    </span>
  );
}

function ExplorerLink({
  hash,
  height,
  explorerTemplate,
}: {
  hash: string;
  height: number;
  explorerTemplate: string;
}): React.JSX.Element {
  return (
    <a
      href={applyExplorerTemplate(explorerTemplate, { block_hash: hash, height })}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-amber-400 hover:underline"
    >
      <Trans>open in block explorer</Trans>{' →'}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Mobile: card layout
// ---------------------------------------------------------------------------

function SignalingBlockCard({
  block,
  tipHeight,
  explorerTemplate,
  intlLocale,
  fmtTimestamp,
}: {
  block: Bip110ScanSignalingBlock;
  tipHeight: number | null;
  explorerTemplate: string;
  intlLocale: string | undefined;
  fmtTimestamp: (ms: number | null | undefined) => string;
}): React.JSX.Element {
  const confirmations = tipHeight !== null ? tipHeight - block.height + 1 : null;
  const totalRewardSat =
    block.total_fees_sat !== null
      ? block.subsidy_sat + block.total_fees_sat
      : null;

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-amber-400 font-mono">
          {formatNumber(block.height, {}, intlLocale)}
        </span>
        {block.miner_tag && <MinerBadge tag={block.miner_tag} />}
      </div>

      <div className="mt-1.5 text-xs text-slate-400">
        <span>{fmtTimestamp(block.time_ms)}</span>
        <span className="text-slate-600 mx-1.5">-</span>
        <span>{formatAgeMinutes(block.time_ms)}</span>
      </div>

      <div className="mt-3 space-y-1 text-xs font-mono">
        {totalRewardSat !== null && (
          <DetailRow label={t`reward`} value={`₿ ${formatBtc(totalRewardSat)}`} />
        )}
        {block.total_fees_sat !== null && (
          <DetailRow label={t`fees`} value={`₿ ${formatBtc(block.total_fees_sat)}`} />
        )}
        {block.n_tx !== null && (
          <DetailRow label={t`txs`} value={formatNumber(block.n_tx, {}, intlLocale)} />
        )}
        {block.size_bytes !== null && (
          <DetailRow label={t`size`} value={formatSize(block.size_bytes)} />
        )}
        {confirmations !== null && (
          <DetailRow label={t`confs`} value={formatNumber(confirmations, {}, intlLocale)} />
        )}
      </div>

      <div className="mt-3 pt-2 border-t border-slate-800">
        <ExplorerLink hash={block.hash} height={block.height} explorerTemplate={explorerTemplate} />
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-300">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop: table layout
// ---------------------------------------------------------------------------

function SignalingBlockTable({
  blocks,
  tipHeight,
  explorerTemplate,
  intlLocale,
  fmtTimestamp,
}: {
  blocks: Bip110ScanSignalingBlock[];
  tipHeight: number | null;
  explorerTemplate: string;
  intlLocale: string | undefined;
  fmtTimestamp: (ms: number | null | undefined) => string;
}): React.JSX.Element {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="text-slate-500 text-left">
            <th className="pb-2 pr-4 font-normal">{t`height`}</th>
            <th className="pb-2 pr-4 font-normal">{t`miner`}</th>
            <th className="pb-2 pr-4 font-normal">{t`found`}</th>
            <th className="pb-2 pr-4 font-normal text-right">{t`reward`}</th>
            <th className="pb-2 pr-4 font-normal text-right">{t`fees`}</th>
            <th className="pb-2 pr-4 font-normal text-right">{t`txs`}</th>
            <th className="pb-2 pr-4 font-normal text-right">{t`size`}</th>
            <th className="pb-2 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => {
            const totalRewardSat =
              b.total_fees_sat !== null ? b.subsidy_sat + b.total_fees_sat : null;
            return (
              <tr key={b.hash} className="text-slate-300 border-t border-slate-800 align-top">
                <td className="py-2 pr-4 text-amber-400 font-semibold">
                  {formatNumber(b.height, {}, intlLocale)}
                </td>
                <td className="py-2 pr-4">
                  {b.miner_tag ? <MinerBadge tag={b.miner_tag} /> : <span className="text-slate-600">-</span>}
                </td>
                <td className="py-2 pr-4" title={formatAgeMinutes(b.time_ms)}>
                  {fmtTimestamp(b.time_ms)}
                </td>
                <td className="py-2 pr-4 text-right">
                  {totalRewardSat !== null ? `₿ ${formatBtc(totalRewardSat)}` : '-'}
                </td>
                <td className="py-2 pr-4 text-right">
                  {b.total_fees_sat !== null ? `₿ ${formatBtc(b.total_fees_sat)}` : '-'}
                </td>
                <td className="py-2 pr-4 text-right">
                  {b.n_tx !== null ? formatNumber(b.n_tx, {}, intlLocale) : '-'}
                </td>
                <td className="py-2 pr-4 text-right">
                  {b.size_bytes !== null ? formatSize(b.size_bytes) : '-'}
                </td>
                <td className="py-2 text-right">
                  <ExplorerLink hash={b.hash} height={b.height} explorerTemplate={explorerTemplate} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

export function Bip110ScanCard(): React.JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const fmt = useFormatters();

  const [range, setRange] = useState<ScanRange>('current');

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
  });
  const explorerTemplate =
    configQuery.data?.config?.block_explorer_url_template ??
    'https://mempool.space/block/{hash}';

  const scan = useMutation({
    mutationFn: (r: ScanRange) => api.bip110Scan(r),
  });

  const data: Bip110ScanResponse | undefined = scan.data;
  const sortedBlocks = data
    ? [...data.signaling_blocks].sort((a, b) => b.height - a.height)
    : [];

  // #233: track expanded epoch rows here (lifted from EpochBreakdown
  // so the auto-expand-on-scan effect can poke at it). Set-based so
  // the cost of toggling is O(1) and stable identities across
  // re-renders are preserved.
  const [expandedEpochs, setExpandedEpochs] = useState<ReadonlySet<number>>(new Set());

  // #233: when a scan completes, automatically expand the in-progress
  // epoch row so the operator sees its signaling blocks without an
  // extra chevron click. Keys off the response identity so a manual
  // collapse during the same scan session sticks (we don't re-fire
  // on every re-render - only when fresh data arrives).
  useEffect(() => {
    if (!data?.epochs) return;
    const inProgress = data.epochs.find((e) => e.in_progress);
    if (!inProgress) return;
    setExpandedEpochs((prev) => {
      if (prev.has(inProgress.start_height)) return prev;
      const next = new Set(prev);
      next.add(inProgress.start_height);
      return next;
    });
  }, [data]);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-slate-200 tracking-wide">
            <Trans>BIP 110 scan</Trans>
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            <Trans>
              Scan recent blocks for{' '}
              <a
                href={BIP110_REFERENCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-400 hover:underline"
              >
                BIP 110
              </a>{' '}
              (Reduced Data Temporary Softfork) signaling.
            </Trans>
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="inline-flex items-center border border-slate-700 rounded-md overflow-hidden text-xs leading-none"
            role="radiogroup"
            aria-label={t`BIP 110 scan range`}
          >
            {(['current', 'all'] as const).map((option, i) => {
              const selected = range === option;
              const label = option === 'current' ? t`Current epoch` : t`All`;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setRange(option)}
                  disabled={scan.isPending}
                  className={
                    'px-3 py-1.5 transition ' +
                    (i > 0 ? 'border-l border-slate-700 ' : '') +
                    (selected
                      ? 'bg-amber-400 text-slate-900 font-medium'
                      : 'text-slate-400 hover:bg-slate-800')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => scan.mutate(range)}
            disabled={scan.isPending}
            className="px-4 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300 disabled:opacity-50"
          >
            {scan.isPending ? <Trans>Scanning...</Trans> : <Trans>Scan</Trans>}
          </button>
        </div>
      </header>

      {scan.isError && (
        <div className="mt-4 text-sm text-red-400">
          <Trans>Scan failed:</Trans> {(scan.error as Error).message}
        </div>
      )}

      {data && data.error && (
        <div className="mt-4 text-sm text-amber-300">{data.error}</div>
      )}

      {data && !data.rpc_available && (
        <div className="mt-4 text-sm text-slate-400">
          <Trans>
            bitcoind RPC is not configured on the daemon. Set
            BHA_BITCOIND_RPC_URL / _USER / _PASSWORD or fill the corresponding fields
            on the Config page.
          </Trans>
        </div>
      )}

      {data && data.rpc_available && !data.error && (
        <>
          {/* #233 follow-up: header stacks vertically on mobile (the
              divider-pipe horizontal layout wrapped awkwardly at narrow
              widths). On lg+ it goes back to the inline row with the
              pipes between items. */}
          <div className="mt-4 flex flex-col lg:flex-row lg:items-center lg:flex-wrap lg:gap-x-3 gap-y-1 rounded-lg border border-slate-700/50 bg-slate-800/40 px-4 py-2.5 text-sm font-mono">
            <span>
              <span className="text-slate-500 text-xs mr-1.5">{t`tip`}</span>
              <span className="text-slate-200 font-semibold">
                {data.tip_height !== null ? formatNumber(data.tip_height, {}, intlLocale) : '-'}
              </span>
            </span>
            <span className="hidden lg:inline"><Divider /></span>
            <span>
              <span className="text-slate-200">
                {formatNumber(data.scanned, {}, intlLocale)}
              </span>
              <span className="text-slate-500 text-xs ml-1.5">{t`scanned`}</span>
            </span>
            <span className="hidden lg:inline"><Divider /></span>
            <span>
              <span className="text-amber-400">
                {formatNumber(data.signaling_count, {}, intlLocale)}
              </span>
              <span className="text-slate-500 text-xs ml-1.5">{t`signaling`}</span>
              <span className="text-slate-500 text-xs ml-1">
                ({formatNumber(
                  data.signaling_pct,
                  { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                  intlLocale,
                )}%)
              </span>
            </span>
            {data.deployment ? (
              <>
                <span className="hidden lg:inline"><Divider /></span>
                <DeploymentStatusBadge
                  deployment={data.deployment}
                  tipHeight={data.tip_height}
                  intlLocale={intlLocale}
                />
              </>
            ) : (
              <>
                <span className="hidden lg:inline"><Divider /></span>
                <span className="text-slate-600 text-xs" title={
                  data.softfork_keys && data.softfork_keys.length > 0
                    ? `${t`known softforks`}: ${data.softfork_keys.join(', ')}`
                    : t`your Bitcoin node does not track BIP 110 as a named softfork`
                }>
                  {t`deployment`}: n/a
                </span>
              </>
            )}
          </div>

          {data.epochs && data.epochs.length > 0 && (
            <EpochBreakdown
              epochs={data.epochs}
              signalingBlocks={sortedBlocks}
              tipHeight={data.tip_height}
              explorerTemplate={explorerTemplate}
              intlLocale={intlLocale}
              fmtTimestamp={fmt.timestamp}
              expanded={expandedEpochs}
              setExpanded={setExpandedEpochs}
            />
          )}
        </>
      )}
    </section>
  );
}

function Divider(): React.JSX.Element {
  return <span className="mx-3 text-slate-700 select-none">|</span>;
}

/**
 * #231 / follow-up: per-epoch breakdown with expandable rows. One row
 * per epoch in scope, latest at the top. Each row shows height range,
 * scanned count, signaling count + percentage, and a 55%-MASF-threshold
 * indicator (percentage is green at or above 55%, slate below). The
 * current (in-progress) epoch is tagged so the operator can see at a
 * glance which row is the live one - its percentage is partial and
 * may still climb.
 *
 * Follow-up: rows with at least one signaling block can be expanded
 * to show those blocks inline (desktop table / mobile cards). Replaces
 * the previous "table-of-epochs + separate table-of-blocks-below"
 * layout. Default state: all collapsed. Click anywhere on the row to
 * toggle. Rows with zero signaling blocks are visually muted and not
 * clickable.
 */
function EpochBreakdown({
  epochs,
  signalingBlocks,
  tipHeight,
  explorerTemplate,
  intlLocale,
  fmtTimestamp,
  expanded,
  setExpanded,
}: {
  epochs: readonly Bip110EpochBucket[];
  signalingBlocks: readonly Bip110ScanSignalingBlock[];
  tipHeight: number | null;
  explorerTemplate: string;
  intlLocale: string | undefined;
  fmtTimestamp: (ms: number | null | undefined) => string;
  expanded: ReadonlySet<number>;
  setExpanded: React.Dispatch<React.SetStateAction<ReadonlySet<number>>>;
}): React.JSX.Element {
  // Latest-first ordering - the in-progress epoch sits at the top, which is
  // what the operator is usually checking on.
  const ordered = [...epochs].sort((a, b) => b.start_height - a.start_height);
  const dateTimeLocale = useDateTimeLocale();

  const blocksForEpoch = (e: Bip110EpochBucket): Bip110ScanSignalingBlock[] =>
    signalingBlocks.filter((b) => b.height >= e.start_height && b.height <= e.end_height);

  const toggle = (start: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });
  };

  return (
    <div className="mt-4">
      <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
        <Trans>Per-epoch breakdown</Trans>
      </h3>

      {/* Desktop: table. */}
      <div className="hidden lg:block overflow-x-auto rounded-lg border border-slate-700/50">
        <table className="w-full text-sm font-mono">
          <thead className="bg-slate-800/40">
            <tr className="text-xs text-slate-500 uppercase tracking-wider">
              <th className="px-3 py-2 text-left font-semibold w-6"></th>
              <th className="px-3 py-2 text-left font-semibold"><Trans>Epoch</Trans></th>
              <th className="px-3 py-2 text-left font-semibold"><Trans>Block range</Trans></th>
              <th className="px-3 py-2 text-right font-semibold"><Trans>Scanned</Trans></th>
              <th className="px-3 py-2 text-left font-semibold min-w-[180px]"><Trans>Signaling</Trans></th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((e) => {
              const isOpen = expanded.has(e.start_height);
              const canExpand = e.signaling_count > 0;
              const epochBlocks = isOpen ? blocksForEpoch(e) : [];
              const dateRange = e.start_time_ms !== null
                ? formatEpochDateRange(
                    e.start_time_ms,
                    e.end_time_ms ?? e.start_time_ms,
                    dateTimeLocale,
                    e.in_progress ? e.expected_end_time_ms : null,
                  )
                : null;
              return (
                <React.Fragment key={e.start_height}>
                  <tr
                    className={`border-t border-slate-800/60 ${
                      canExpand ? 'cursor-pointer hover:bg-slate-800/30' : ''
                    }`}
                    onClick={canExpand ? () => toggle(e.start_height) : undefined}
                    title={canExpand ? (isOpen ? t`Click to collapse` : t`Click to expand`) : undefined}
                  >
                    <td className="px-3 py-2 text-slate-500 select-none align-top">
                      {canExpand ? (
                        <span className="inline-block w-3 text-center" aria-hidden>
                          {isOpen ? '▼' : '▶'}
                        </span>
                      ) : (
                        <span className="inline-block w-3" aria-hidden />
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-300 align-top">
                      {e.in_progress ? (
                        <span className="bg-amber-400/20 text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">
                          <Trans>In progress</Trans>
                        </span>
                      ) : (
                        <span className="text-slate-500"><Trans>Completed</Trans></span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-300 align-top">
                      <div>
                        {formatNumber(e.start_height, {}, intlLocale)} – {formatNumber(e.end_height, {}, intlLocale)}
                      </div>
                      {dateRange && (
                        <div className="text-xs text-slate-500 mt-0.5 font-sans">
                          {dateRange.text}
                          {dateRange.estimated && (
                            <span className="ml-1 text-slate-600">({t`est.`})</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-slate-300 align-top">
                      {formatNumber(e.scanned, {}, intlLocale)}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <MasfProgress
                        signalingCount={e.signaling_count}
                        signalingPct={e.signaling_pct}
                        intlLocale={intlLocale}
                      />
                    </td>
                  </tr>
                  {isOpen && epochBlocks.length > 0 && (
                    <tr className="border-t border-slate-800/60 bg-slate-950/60">
                      <td colSpan={5} className="px-3 py-3">
                        <SignalingBlockTable
                          blocks={epochBlocks}
                          tipHeight={tipHeight}
                          explorerTemplate={explorerTemplate}
                          intlLocale={intlLocale}
                          fmtTimestamp={fmtTimestamp}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards. Same data, no horizontal scroll, the
          touch target for expand is the entire card header. */}
      <div className="lg:hidden space-y-3">
        {ordered.map((e) => {
          const isOpen = expanded.has(e.start_height);
          const canExpand = e.signaling_count > 0;
          const epochBlocks = isOpen ? blocksForEpoch(e) : [];
          const dateRange = e.start_time_ms !== null
            ? formatEpochDateRange(
                e.start_time_ms,
                e.end_time_ms ?? e.start_time_ms,
                dateTimeLocale,
                e.in_progress ? e.expected_end_time_ms : null,
              )
            : null;
          return (
            <div
              key={e.start_height}
              className="rounded-lg border border-slate-700/50 bg-slate-800/40 overflow-hidden"
            >
              <div
                className={`px-3 py-2 ${canExpand ? 'cursor-pointer active:bg-slate-800/60' : ''}`}
                onClick={canExpand ? () => toggle(e.start_height) : undefined}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {canExpand && (
                      <span className="text-slate-500 select-none text-sm" aria-hidden>
                        {isOpen ? '▼' : '▶'}
                      </span>
                    )}
                    {e.in_progress ? (
                      <span className="bg-amber-400/20 text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">
                        <Trans>In progress</Trans>
                      </span>
                    ) : (
                      <span className="text-slate-500 text-xs uppercase tracking-wider">
                        <Trans>Completed</Trans>
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 font-mono">
                    {formatNumber(e.scanned, {}, intlLocale)} {t`scanned`}
                  </span>
                </div>
                <div className="mt-2 text-sm font-mono text-slate-300">
                  {formatNumber(e.start_height, {}, intlLocale)} – {formatNumber(e.end_height, {}, intlLocale)}
                </div>
                {dateRange && (
                  <div className="text-xs text-slate-500 mt-0.5">
                    {dateRange.text}
                    {dateRange.estimated && (
                      <span className="ml-1 text-slate-600">({t`est.`})</span>
                    )}
                  </div>
                )}
                <div className="mt-2">
                  <MasfProgress
                    signalingCount={e.signaling_count}
                    signalingPct={e.signaling_pct}
                    intlLocale={intlLocale}
                  />
                </div>
              </div>
              {isOpen && epochBlocks.length > 0 && (
                <div className="px-3 pb-3 pt-1 bg-slate-950/60 border-t border-slate-800/60 grid gap-3 sm:grid-cols-2">
                  {epochBlocks.map((b) => (
                    <SignalingBlockCard
                      key={b.hash}
                      block={b}
                      tipHeight={tipHeight}
                      explorerTemplate={explorerTemplate}
                      intlLocale={intlLocale}
                      fmtTimestamp={fmtTimestamp}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * #233: per-epoch MASF progress bar. Fills to 100% at the absolute
 * threshold (MASF_THRESHOLD_BLOCKS = ceil(2016 × 55%) = 1109 signaling
 * blocks). Color is amber below threshold, emerald at or above; that
 * matches the operator's mental model of "did this epoch cross the
 * activation line yet." The supplementary signaling_pct (signaling
 * vs scanned, not vs 2016) appears under the bar so the in-progress
 * reading is read as a rate, not as a final tally.
 */
function MasfProgress({
  signalingCount,
  signalingPct,
  intlLocale,
}: {
  signalingCount: number;
  signalingPct: number;
  intlLocale: string | undefined;
}): React.JSX.Element {
  const fillPct = Math.min((signalingCount / MASF_THRESHOLD_BLOCKS) * 100, 100);
  const crossed = signalingCount >= MASF_THRESHOLD_BLOCKS;
  return (
    <div className="space-y-1">
      <div
        className="h-2 rounded-full bg-slate-700 overflow-hidden"
        title={crossed ? t`At or above the 55% MASF threshold` : t`Below the 55% MASF threshold`}
      >
        <div
          className={`h-full rounded-full transition-all ${crossed ? 'bg-emerald-400' : 'bg-amber-400'}`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
      <div className={`text-xs font-mono ${crossed ? 'text-emerald-400' : 'text-slate-400'}`}>
        {formatNumber(signalingCount, {}, intlLocale)} / {formatNumber(MASF_THRESHOLD_BLOCKS, {}, intlLocale)}
        <span className="text-slate-500 ml-1.5">
          ({formatNumber(
            signalingPct,
            { minimumFractionDigits: 2, maximumFractionDigits: 2 },
            intlLocale,
          )}%)
        </span>
      </div>
    </div>
  );
}

/**
 * #233 replacement for the old DeploymentProgressBar widget. The
 * progress bar itself moved into the per-epoch table; the header now
 * shows just the status label (Signaling / Locked in / Active) with
 * a plain-English tooltip per state.
 *
 * #233 follow-up #2: SIGNALING tooltip now names both activation
 * paths (MASF + UASF) and surfaces the UASF flag-day block (965,664)
 * with a dynamically forecasted date from the average block time
 * observed in the in-progress difficulty epoch. The fixed September-
 * 2026 calendar reference the older deleted DeploymentProgressBar
 * carried was already off (blocks are coming faster than 600s on
 * average), so the dynamic forecast replaces the calendar fact too.
 *
 * Wording: never the C-word in user-visible text - see the
 * never-say-bitcoin-core-in-ui memory.
 */
function DeploymentStatusBadge({
  deployment,
  tipHeight,
  intlLocale,
}: {
  deployment: Bip110ScanDeployment;
  tipHeight: number | null;
  intlLocale: string | undefined;
}): React.JSX.Element {
  const dateTimeLocale = useDateTimeLocale();
  const statusLabel =
    deployment.status === 'locked_in' ? t`locked in`
    : deployment.status === 'active' ? t`active`
    : t`signaling`;
  const uasfForecastMs = forecastBlockHeightTime(UASF_HEIGHT_BIP110, tipHeight);
  const uasfHeightStr = formatNumber(UASF_HEIGHT_BIP110, {}, intlLocale);
  const uasfDateStr = uasfForecastMs !== null
    ? formatMediumDate(uasfForecastMs, dateTimeLocale)
    : null;
  const tooltip = (() => {
    if (deployment.status === 'locked_in') {
      return (
        <p className="text-slate-300 leading-relaxed max-w-xs">
          <Trans>
            The 55% miner-activation threshold has been crossed. BIP 110 will activate at the next difficulty epoch boundary.
          </Trans>
        </p>
      );
    }
    if (deployment.status === 'active') {
      return (
        <p className="text-slate-300 leading-relaxed max-w-xs">
          <Trans>
            BIP 110 is active. Your Bitcoin node is enforcing the new consensus rules.
          </Trans>
        </p>
      );
    }
    // Default: signaling (or any other state we don't recognize).
    return (
      <div className="text-slate-300 leading-relaxed max-w-xs space-y-2">
        <p>
          <Trans>
            Your Bitcoin node supports BIP 110, which is currently in its activation window. There are two paths it can activate by:
          </Trans>
        </p>
        <p>
          <span className="text-amber-300 font-semibold">
            <Trans>Miner-activated (MASF):</Trans>
          </span>{' '}
          <Trans>
            if at least 55% of a difficulty epoch's blocks signal BIP 110 in their headers, the soft fork locks in at the next epoch boundary.
          </Trans>
        </p>
        <p>
          <span className="text-amber-300 font-semibold">
            <Trans>User-activated (UASF):</Trans>
          </span>{' '}
          {uasfDateStr !== null ? (
            <Trans>
              at block {uasfHeightStr} (estimated {uasfDateStr}), BIP 110-aware nodes (Bitcoin Knots included) begin enforcing the rules regardless of miner signaling.
            </Trans>
          ) : (
            <Trans>
              at block {uasfHeightStr}, BIP 110-aware nodes (Bitcoin Knots included) begin enforcing the rules regardless of miner signaling.
            </Trans>
          )}
        </p>
      </div>
    );
  })();
  return (
    <Tooltip content={tooltip}>
      <span className="inline-flex items-center gap-1.5 cursor-help">
        <span className="text-slate-500 text-xs">{t`deployment`}:</span>
        <span className="bg-amber-400/20 text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">
          {statusLabel}
        </span>
      </span>
    </Tooltip>
  );
}
