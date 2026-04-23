/**
 * Human-readable labels for the raw enum strings that come back from
 * Braiins and our own controller. Keep UI strings out of the wire model.
 */

const BID_STATUS: Record<string, string> = {
  BID_STATUS_UNSPECIFIED: 'Unknown',
  BID_STATUS_ACTIVE: 'Active',
  BID_STATUS_CREATED: 'Pending 2FA',
  BID_STATUS_PAUSED: 'Paused',
  BID_STATUS_FROZEN: 'Frozen',
  BID_STATUS_PENDING_CANCEL: 'Cancelling…',
  BID_STATUS_CANCELED: 'Cancelled',
  BID_STATUS_FULFILLED: 'Fulfilled',
};

export function bidStatusLabel(raw: string): string {
  return BID_STATUS[raw] ?? prettyFallback(raw);
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
  return raw === 'NORMAL' ? 'Normal' : raw;
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
