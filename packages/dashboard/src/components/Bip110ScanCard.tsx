/**
 * BIP 110 scan card — small Status-page diagnostic that fires the
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
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '../lib/api';
import type { Bip110ScanResponse } from '../lib/api';

const WINDOWS = [2016, 4032, 8064] as const;
type ScanWindow = (typeof WINDOWS)[number];

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function shortHash(hash: string): string {
  if (hash.length < 16) return hash;
  return hash.slice(0, 8) + '…' + hash.slice(-8);
}

export function Bip110ScanCard(): JSX.Element {
  const { i18n } = useLingui();
  void i18n;

  const [window, setWindow] = useState<ScanWindow>(2016);

  const scan = useMutation({
    mutationFn: (blocks: number) => api.bip110Scan(blocks),
  });

  const data: Bip110ScanResponse | undefined = scan.data;

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 mt-6">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-slate-200 tracking-wide">
            <Trans>BIP 110 scan</Trans>
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            <Trans>
              Scan recent blocks for BIP 110 (Reduced Data Temporary Softfork) signaling.
              Useful for verifying the crown marker on the hashrate chart against a known
              list of signaling blocks. Block-level signaling is rare in early adoption
              (well under 1%), so a 0-result run may simply mean no signaling blocks
              landed in the window.
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
            <Stat label={t`tip`} value={data.tip_height?.toLocaleString() ?? '-'} />
            <Stat label={t`scanned`} value={data.scanned.toLocaleString()} />
            <Stat
              label={t`signaling`}
              value={`${data.signaling_count} (${data.signaling_pct.toFixed(2)}%)`}
            />
            <Stat
              label={t`deployment`}
              value={data.deployment ? data.deployment.status ?? '-' : t`not reported`}
            />
          </div>

          {data.deployment?.statistics && (
            <div className="mt-3 text-xs text-slate-400 font-mono">
              <Trans>retarget window:</Trans>{' '}
              {data.deployment.statistics.count}/{data.deployment.statistics.threshold}{' '}
              ({data.deployment.statistics.elapsed}/{data.deployment.statistics.period}{' '}
              <Trans>elapsed</Trans>)
              {data.deployment.bit !== null && (
                <>
                  {' · '}
                  <Trans>bit</Trans> {data.deployment.bit}
                </>
              )}
            </div>
          )}

          {data.signaling_blocks.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              <Trans>No signaling blocks in this window.</Trans>
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="pb-2 pr-4 font-normal">{t`height`}</th>
                    <th className="pb-2 pr-4 font-normal">{t`time (UTC)`}</th>
                    <th className="pb-2 pr-4 font-normal">{t`version`}</th>
                    <th className="pb-2 font-normal">{t`block`}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.signaling_blocks.map((b) => (
                    <tr key={b.hash} className="text-slate-300 border-t border-slate-800">
                      <td className="py-1.5 pr-4">{b.height.toLocaleString()}</td>
                      <td className="py-1.5 pr-4">{formatTime(b.time_ms)}</td>
                      <td className="py-1.5 pr-4">{b.version_hex}</td>
                      <td className="py-1.5">
                        <a
                          href={`https://mempool.space/block/${b.hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-amber-400 hover:underline"
                        >
                          {shortHash(b.hash)}
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
