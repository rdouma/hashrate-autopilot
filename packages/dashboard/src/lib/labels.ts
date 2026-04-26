/**
 * Human-readable labels for the raw enum strings that come back from
 * Braiins and our own controller. Keep UI strings out of the wire model.
 */

import { t } from '@lingui/macro';

export function bidStatusLabel(raw: string): string {
  switch (raw) {
    case 'BID_STATUS_UNSPECIFIED':
      return t`Unknown`;
    case 'BID_STATUS_ACTIVE':
      return t`Active`;
    case 'BID_STATUS_CREATED':
      return t`Pending 2FA`;
    case 'BID_STATUS_PAUSED':
      return t`Paused`;
    case 'BID_STATUS_FROZEN':
      return t`Frozen`;
    case 'BID_STATUS_PENDING_CANCEL':
      return t`Cancelling…`;
    case 'BID_STATUS_CANCELED':
      return t`Cancelled`;
    case 'BID_STATUS_FULFILLED':
      return t`Fulfilled`;
    default:
      return prettyFallback(raw);
  }
}

export function bidStatusClass(raw: string): string {
  switch (raw) {
    case 'BID_STATUS_ACTIVE':
      return 'text-emerald-300';
    case 'BID_STATUS_CREATED':
      return 'text-amber-300';
    case 'BID_STATUS_PAUSED':
    case 'BID_STATUS_FROZEN':
    case 'BID_STATUS_PENDING_CANCEL':
      return 'text-slate-400';
    case 'BID_STATUS_CANCELED':
    case 'BID_STATUS_FULFILLED':
      return 'text-slate-500';
    default:
      return 'text-slate-400';
  }
}

/** @deprecated ActionMode is always 'NORMAL' since v1.1. */
export function actionModeLabel(raw: string): string {
  return raw === 'NORMAL' ? t`Normal` : raw;
}

/**
 * Strip scheme prefixes (stratum+tcp://, stratum://) that clutter the
 * display and convey no extra information.
 */
export function prettyPoolUrl(url: string): string {
  return url.replace(/^stratum\+tcp:\/\//i, '').replace(/^stratum:\/\//i, '');
}

function prettyFallback(s: string): string {
  return s
    .toLowerCase()
    .split('_')
    .filter((w) => w !== 'bid' && w !== 'status')
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}
