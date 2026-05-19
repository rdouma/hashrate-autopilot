/**
 * #113: stale-URL banner.
 *
 * Renders when the daemon reports that an active Braiins bid was
 * created with a destination URL whose hostname:port differs from the
 * current `destination_pool_url`. Braiins's API does not allow editing
 * `dest_upstream` after creation, so the only fix is cancel-and-recreate.
 *
 * The banner shows:
 *   - the old vs new host:port
 *   - the unconsumed_sat that would be refunded (Braiins may apply
 *     an exit fee on top - we tell the operator that explicitly)
 *   - a single Cancel & recreate button that opens a confirmation
 *     dialog showing the same numbers, then issues CANCEL_BID via the
 *     existing braiinsClient path
 *
 * Polls /api/stale-urls every 30 s. The route is cheap (no Braiins API
 * call - it compares persisted owned_bids.dest_url against config),
 * so a tighter interval doesn't cost anything but stays at 30 s for
 * parity with the rest of the dashboard's diagnostic polls.
 */

import { Trans } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api, type StaleUrlBid } from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { useLocale } from '../lib/locale';

export function StaleUrlBanner(): React.ReactElement | null {
  const qc = useQueryClient();
  const denomination = useDenomination();
  const { intlLocale } = useLocale();
  const q = useQuery({
    queryKey: ['stale-urls'],
    queryFn: () => api.staleUrls(),
    refetchInterval: 30_000,
  });
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (bidId: string) => api.cancelStaleUrlBid(bidId),
    onSuccess: () => {
      setConfirmingFor(null);
      qc.invalidateQueries({ queryKey: ['stale-urls'] });
      qc.invalidateQueries({ queryKey: ['status'] });
    },
  });

  if (!q.data || q.data.stale.length === 0) return null;

  const formatSat = (sat: number | null): string => {
    if (sat === null) return '-';
    return denomination.formatSat(sat, intlLocale);
  };

  return (
    <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-4 text-sm space-y-3">
      <div className="flex items-start gap-3">
        <span className="text-amber-400 text-lg leading-none">⚠</span>
        <div className="flex-1">
          <h3 className="text-amber-300 font-medium mb-1">
            <Trans>Active bid is using a stale destination URL</Trans>
          </h3>
          <p className="text-amber-100/80 text-xs leading-snug">
            <Trans>
              Braiins doesn't allow changing a live bid's destination URL. Your config now points at a different host than the bid was created with - miners on this bid keep going to the old destination until you cancel and recreate. Cancel here, the next decision tick will create a fresh bid with the current URL automatically.
            </Trans>
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {q.data.stale.map((bid) => (
          <StaleUrlRow
            key={bid.bid_id}
            bid={bid}
            isConfirming={confirmingFor === bid.bid_id}
            onAskConfirm={() => setConfirmingFor(bid.bid_id)}
            onCancelConfirm={() => setConfirmingFor(null)}
            onConfirm={() => cancel.mutate(bid.bid_id)}
            isPending={cancel.isPending && confirmingFor === bid.bid_id}
            formatSat={formatSat}
            error={
              cancel.isError && confirmingFor === bid.bid_id
                ? (cancel.error as Error).message
                : null
            }
          />
        ))}
      </div>
    </div>
  );
}

function StaleUrlRow({
  bid,
  isConfirming,
  onAskConfirm,
  onCancelConfirm,
  onConfirm,
  isPending,
  formatSat,
  error,
}: {
  bid: StaleUrlBid;
  isConfirming: boolean;
  onAskConfirm: () => void;
  onCancelConfirm: () => void;
  onConfirm: () => void;
  isPending: boolean;
  formatSat: (sat: number | null) => string;
  error: string | null;
}) {
  return (
    <div className="bg-slate-900/60 border border-amber-800/40 rounded p-3 text-xs">
      <div className="font-mono space-y-1">
        <div className="flex flex-wrap gap-x-2">
          <span className="text-slate-400">
            <Trans>Bid:</Trans>
          </span>
          <span className="text-slate-200">{bid.bid_id}</span>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <span className="text-slate-400">
            <Trans>Old destination:</Trans>
          </span>
          <span className="text-red-300">{bid.old_host_port}</span>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <span className="text-slate-400">
            <Trans>Current config:</Trans>
          </span>
          <span className="text-emerald-300">{bid.new_host_port}</span>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <span className="text-slate-400">
            <Trans>Refundable on cancel:</Trans>
          </span>
          <span className="text-slate-200">
            {formatSat(bid.unconsumed_sat)}{' '}
            <span className="text-slate-500">
              <Trans>(Braiins may deduct an exit fee)</Trans>
            </span>
          </span>
        </div>
      </div>

      {!isConfirming && (
        <button
          type="button"
          onClick={onAskConfirm}
          className="mt-3 px-3 py-1.5 text-sm rounded bg-amber-400 text-slate-900 font-medium hover:bg-amber-300"
        >
          <Trans>Cancel &amp; recreate now</Trans>
        </button>
      )}

      {isConfirming && (
        <div className="mt-3 bg-red-950/40 border border-red-800 rounded p-3">
          <p className="text-slate-200 mb-3">
            <Trans>
              Cancel bid {bid.bid_id}? About {formatSat(bid.unconsumed_sat)} of unconsumed budget will be refunded by Braiins (an exit fee may be deducted on top). The autopilot's next tick will create a fresh bid with the new URL.
            </Trans>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isPending}
              className="px-3 py-1.5 text-sm rounded bg-red-500 text-slate-100 font-medium hover:bg-red-400 disabled:opacity-50"
            >
              {isPending ? <Trans>Cancelling…</Trans> : <Trans>Confirm cancel</Trans>}
            </button>
            <button
              type="button"
              onClick={onCancelConfirm}
              disabled={isPending}
              className="px-3 py-1.5 text-sm rounded border border-slate-600 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <Trans>Keep bid running</Trans>
            </button>
          </div>
          {error && <div className="mt-2 text-xs text-red-400 font-mono">{error}</div>}
        </div>
      )}
    </div>
  );
}
