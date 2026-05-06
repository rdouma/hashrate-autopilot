/**
 * BIP 110 scan card - small Status-page diagnostic that fires the
 * `/api/bip110/scan` endpoint and renders the deployment header +
 * signaling block list.
 *
 * Goal (#95): give the operator a way to verify the crown marker
 * (#94) renders correctly against known signaling blocks, since
 * Ocean's recent-blocks window may not contain any signaling
 * blocks at all in early adoption (well under 1% block-rate).
 *
 * Once the operator is satisfied that the crown UI works, this card
 * can be removed without touching the rest of Status.
 */

import { Trans, t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api';
import type { Bip110ScanResponse } from '../lib/api';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { formatAgeMinutes, formatNumber } from '../lib/format';
import { useLocale } from '../lib/locale';

// Retarget windows (2016 blocks each), so each step is "one more
// difficulty period" of context. 32256 = 16 retargets ≈ 7-8 months
// at 10-minute target spacing - enough back-history for the operator
// to find any signaling block on a quiet network.
const WINDOWS = [2016, 4032, 8064, 16128, 32256] as const;
type ScanWindow = (typeof WINDOWS)[number];

const BIP110_REFERENCE_URL = 'https://bip110.org/';

function formatTimeUtc(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function Bip110ScanCard(): JSX.Element {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();

  const [window, setWindow] = useState<ScanWindow>(2016);

  // Shares the cached value with the rest of Status - same queryKey used
  // by Layout / OceanCard / etc - so adding this hook adds zero network
  // traffic.
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
  // Newest blocks first - the tip-most signal is the most relevant for
  // verifying the crown marker behaviour against current network state.
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
            {scan.isPending ? <Trans>Scanning…</Trans> : <Trans>Scan</Trans>}
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
                  {' · '}
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
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="pb-2 pr-4 font-normal">{t`height`}</th>
                    <th className="pb-2 pr-4 font-normal">{t`found`}</th>
                    <th className="pb-2 pr-4 font-normal">{t`version`}</th>
                    <th className="pb-2 font-normal">{t`block`}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedBlocks.map((b) => (
                    <tr key={b.hash} className="text-slate-300 border-t border-slate-800">
                      <td className="py-1.5 pr-4">
                        {formatNumber(b.height, {}, intlLocale)}
                      </td>
                      <td className="py-1.5 pr-4" title={formatTimeUtc(b.time_ms)}>
                        {formatAgeMinutes(b.time_ms)}
                      </td>
                      <td className="py-1.5 pr-4">{b.version_hex}</td>
                      <td className="py-1.5 break-all">
                        <a
                          href={applyExplorerTemplate(explorerTemplate, {
                            block_hash: b.hash,
                            height: b.height,
                          })}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-amber-400 hover:underline"
                        >
                          {b.hash}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-slate-500">{label}</span>
      <span className="text-slate-200 mt-0.5">{value}</span>
    </div>
  );
}
