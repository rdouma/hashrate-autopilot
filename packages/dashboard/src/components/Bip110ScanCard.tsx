/**
 * BIP 110 scan card - Status-page diagnostic that fires the
 * `/api/bip110/scan` endpoint and renders the deployment header +
 * signaling block cards.
 *
 * Goal (#95): give the operator a way to verify the BIP 110 yellow-
 * cube marker (#94 / #115) renders correctly against known signaling
 * blocks, since Ocean's recent-blocks window may not contain any
 * signaling blocks at all in early adoption (well under 1% block-rate).
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';

import { api } from '../lib/api';
import type { Bip110ScanResponse, Bip110ScanSignalingBlock } from '../lib/api';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { formatAgeMinutes, formatNumber, formatTimestampHuman } from '../lib/format';
import { useLocale } from '../lib/locale';

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

function truncateHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

function SignalingBlockCard({
  block,
  tipHeight,
  explorerTemplate,
  intlLocale,
}: {
  block: Bip110ScanSignalingBlock;
  tipHeight: number | null;
  explorerTemplate: string;
  intlLocale: string | undefined;
}): React.JSX.Element {
  const confirmations = tipHeight !== null ? tipHeight - block.height + 1 : null;
  const totalRewardSat =
    block.total_fees_sat !== null
      ? block.subsidy_sat + block.total_fees_sat
      : null;

  return (
    <div className="bg-slate-950 border border-slate-800 rounded-lg p-4">
      {/* Header: height + pool tag */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-lg font-semibold text-amber-400 font-mono">
          {formatNumber(block.height, {}, intlLocale)}
        </span>
        {block.pool_tag && (
          <span className="text-xs text-slate-400 truncate max-w-[160px]" title={block.pool_tag}>
            {block.pool_tag}
          </span>
        )}
      </div>

      {/* Timestamp: absolute + relative */}
      <div className="mt-1.5 text-xs text-slate-400">
        <span>{formatTimestampHuman(block.time_ms)}</span>
        <span className="text-slate-600 mx-1.5">-</span>
        <span>{formatAgeMinutes(block.time_ms)}</span>
      </div>

      {/* Stats grid */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs font-mono">
        {totalRewardSat !== null && (
          <DetailRow label={t`reward`} value={`${formatBtc(totalRewardSat)} BTC`} />
        )}
        {block.total_fees_sat !== null && (
          <DetailRow label={t`fees`} value={`${formatBtc(block.total_fees_sat)} BTC`} />
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

      {/* Block hash link */}
      <div className="mt-3 pt-2 border-t border-slate-800">
        <a
          href={applyExplorerTemplate(explorerTemplate, {
            block_hash: block.hash,
            height: block.height,
          })}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-amber-400 hover:underline font-mono"
          title={block.hash}
        >
          {truncateHash(block.hash)}
        </a>
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

export function Bip110ScanCard(): React.JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();

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
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm font-mono">
            <Stat
              label={t`tip`}
              value={data.tip_height !== null ? formatNumber(data.tip_height, {}, intlLocale) : '-'}
            />
            <Stat label={t`scanned`} value={formatNumber(data.scanned, {}, intlLocale)} />
            <Stat
              label={t`signaling`}
              value={`${formatNumber(data.signaling_count, {}, intlLocale)} (${formatNumber(
                data.signaling_pct,
                { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                intlLocale,
              )}%)`}
            />
            <Stat
              label={t`deployment`}
              value={data.deployment ? data.deployment.status ?? '-' : t`not reported`}
            />
          </div>

          {data.deployment?.statistics && (
            <div className="mt-3 text-xs text-slate-400 font-mono">
              <Trans>retarget window:</Trans>{' '}
              {formatNumber(data.deployment.statistics.count, {}, intlLocale)}/
              {formatNumber(data.deployment.statistics.threshold, {}, intlLocale)} (
              {formatNumber(data.deployment.statistics.elapsed, {}, intlLocale)}/
              {formatNumber(data.deployment.statistics.period, {}, intlLocale)}{' '}
              <Trans>elapsed</Trans>)
              {data.deployment.bit !== null && (
                <>
                  {' - '}
                  <Trans>bit</Trans> {data.deployment.bit}
                </>
              )}
            </div>
          )}

          {sortedBlocks.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              <Trans>No signaling blocks in this window.</Trans>
            </p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sortedBlocks.map((b) => (
                <SignalingBlockCard
                  key={b.hash}
                  block={b}
                  tipHeight={data.tip_height}
                  explorerTemplate={explorerTemplate}
                  intlLocale={intlLocale}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="text-slate-200 mt-0.5">{value}</span>
    </div>
  );
}
