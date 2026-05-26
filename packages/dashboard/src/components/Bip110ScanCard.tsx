/**
 * BIP 110 scan card - Status-page diagnostic that fires the
 * `/api/bip110/scan` endpoint and renders the deployment header +
 * signaling block list. Cards on mobile, table on desktop.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';

import { api } from '../lib/api';
import type { Bip110ScanDeployment, Bip110ScanResponse, Bip110ScanSignalingBlock } from '../lib/api';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { formatAgeMinutes, formatNumber } from '../lib/format';
import { useFormatters, useLocale } from '../lib/locale';
import { Tooltip } from './Tooltip';

const WINDOWS = [2016, 4032, 8064, 16128, 32256] as const;
type ScanWindow = (typeof WINDOWS)[number];

const BIP110_REFERENCE_URL = 'https://bip110.org/';

function formatBtc(sat: number): string {
  return (sat / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '.0');
}

function formatSize(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${bytes} B`;
}

const POOL_COLORS = [
  'bg-amber-600', 'bg-emerald-600', 'bg-sky-600', 'bg-violet-600',
  'bg-rose-600', 'bg-teal-600', 'bg-orange-600', 'bg-indigo-600',
];

function poolColor(tag: string): string {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return POOL_COLORS[Math.abs(h) % POOL_COLORS.length]!;
}

function PoolBadge({ tag }: { tag: string }): React.JSX.Element {
  const initial = tag.replace(/^[^a-zA-Z0-9]*/, '').charAt(0).toUpperCase() || '?';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300 truncate max-w-[180px]" title={tag}>
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded text-[10px] font-bold text-white ${poolColor(tag)}`}>
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
        {block.pool_tag && <PoolBadge tag={block.pool_tag} />}
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
            <th className="pb-2 pr-4 font-normal">{t`pool`}</th>
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
                  {b.pool_tag ? <PoolBadge tag={b.pool_tag} /> : <span className="text-slate-600">-</span>}
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

  const [window, setWindow] = useState<ScanWindow>(2016);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
  });
  const explorerTemplate =
    configQuery.data?.config?.block_explorer_url_template ??
    'https://mempool.space/block/{hash}';

  const scan = useMutation({
    mutationFn: (blocks: number) => api.bip110Scan(blocks),
  });

  const data: Bip110ScanResponse | undefined = scan.data;
  const sortedBlocks = data
    ? [...data.signaling_blocks].sort((a, b) => b.height - a.height)
    : [];

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
          <select
            value={window}
            onChange={(e) => setWindow(Number(e.target.value) as ScanWindow)}
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200"
            disabled={scan.isPending}
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} {t`blocks`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => scan.mutate(window)}
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
          <div className="mt-4 flex items-center flex-wrap gap-y-1 rounded-lg border border-slate-700/50 bg-slate-800/40 px-4 py-2.5 text-sm font-mono">
            <span className="text-slate-500 text-xs mr-1.5">{t`tip`}</span>
            <span className="text-slate-200 font-semibold">
              {data.tip_height !== null ? formatNumber(data.tip_height, {}, intlLocale) : '-'}
            </span>
            <Divider />
            <span className="text-slate-200">
              {formatNumber(data.scanned, {}, intlLocale)}
            </span>
            <span className="text-slate-500 text-xs ml-1.5">{t`scanned`}</span>
            <Divider />
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
            {data.deployment ? (
              <>
                <Divider />
                <div className="flex-1 min-w-[120px]">
                  <DeploymentProgressBar deployment={data.deployment} intlLocale={intlLocale} />
                </div>
              </>
            ) : (
              <>
                <Divider />
                <span className="text-slate-600 text-xs" title={
                  data.softfork_keys && data.softfork_keys.length > 0
                    ? `${t`known softforks`}: ${data.softfork_keys.join(', ')}`
                    : t`node does not track BIP 110 as a named softfork`
                }>
                  {t`deployment`}: n/a
                </span>
              </>
            )}
          </div>

          {sortedBlocks.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              <Trans>No signaling blocks in this window.</Trans>
            </p>
          ) : (
            <>
              {/* Desktop: table */}
              <div className="hidden lg:block">
                <SignalingBlockTable
                  blocks={sortedBlocks}
                  tipHeight={data.tip_height}
                  explorerTemplate={explorerTemplate}
                  intlLocale={intlLocale}
                  fmtTimestamp={fmt.timestamp}
                />
              </div>
              {/* Mobile: cards */}
              <div className="lg:hidden mt-4 grid gap-3 sm:grid-cols-2">
                {sortedBlocks.map((b) => (
                  <SignalingBlockCard
                    key={b.hash}
                    block={b}
                    tipHeight={data.tip_height}
                    explorerTemplate={explorerTemplate}
                    intlLocale={intlLocale}
                    fmtTimestamp={fmt.timestamp}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function DeploymentProgressBar({
  deployment,
  intlLocale,
}: {
  deployment: Bip110ScanDeployment;
  intlLocale: string | undefined;
}): React.JSX.Element {
  const stats = deployment.statistics;
  if (!stats) {
    return (
      <span className="text-slate-200 text-xs">{deployment.status ?? '-'}</span>
    );
  }

  const pct = Math.min((stats.count / stats.threshold) * 100, 100);
  const remaining = Math.max(stats.period - stats.elapsed, 0);
  const statusLabel =
    deployment.status === 'locked_in' ? t`locked in`
    : deployment.status === 'active' ? t`active`
    : t`signaling`;

  const tooltipContent = (
    <div className="max-w-sm">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-400"><Trans>Status</Trans>:</span>
        <span className="bg-amber-400/20 text-amber-400 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider">
          {statusLabel}
        </span>
      </div>
      <div className="space-y-0.5 font-mono text-slate-400 mb-3">
        <div>
          <span className="text-slate-200">{formatNumber(stats.count, {}, intlLocale)}</span>
          {' / '}
          {formatNumber(stats.threshold, {}, intlLocale)}
          {' '}<Trans>signaling blocks in this period</Trans>
        </div>
        <div>
          <span className="text-slate-200">{formatNumber(stats.elapsed, {}, intlLocale)}</span>
          {' / '}
          {formatNumber(stats.period, {}, intlLocale)}
          {' '}<Trans>blocks into the current retarget period</Trans>
        </div>
        <div>
          <span className="text-slate-200">{formatNumber(remaining, {}, intlLocale)}</span>
          {' '}<Trans>blocks remaining in this period</Trans>
        </div>
      </div>
      <hr className="border-slate-700 mb-2" />
      <p className="text-slate-400 leading-relaxed">
        <Trans>
          BIP 110 (Reduced Data Temporary Softfork) activation happens in two phases.
          Currently in the miner-activated phase: miners can optionally signal support
          in their block headers. If the threshold ({formatNumber(stats.threshold, {}, intlLocale)} of {formatNumber(stats.period, {}, intlLocale)} blocks)
          is reached within a retarget period, the softfork locks in early.
        </Trans>
      </p>
      <p className="text-slate-400 leading-relaxed mt-1.5">
        <Trans>
          At block height 965,664 (approximately September 2026), user-activated
          enforcement begins: nodes running BIP 110-compatible software will enforce
          the rules regardless of miner signaling.
        </Trans>
      </p>
    </div>
  );

  return (
    <Tooltip content={tooltipContent}>
      <div className="flex items-center gap-2 cursor-help min-w-0">
        <div className="flex-1 h-2 rounded-full bg-slate-700 overflow-hidden min-w-[60px]">
          <div
            className="h-full rounded-full bg-amber-400 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-slate-200 text-xs whitespace-nowrap">
          {formatNumber(stats.count, {}, intlLocale)}{' '}
          <Trans>of</Trans>{' '}
          {formatNumber(stats.threshold, {}, intlLocale)}
        </span>
      </div>
    </Tooltip>
  );
}

function Divider(): React.JSX.Element {
  return <span className="mx-3 text-slate-700 select-none">|</span>;
}
