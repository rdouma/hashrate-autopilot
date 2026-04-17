import { memo } from 'react';

import type { StatusResponse } from '../lib/api';

const styles: Record<StatusResponse['run_mode'], { label: string; cls: string }> = {
  DRY_RUN: { label: 'Dry Run', cls: 'bg-sky-900/40 text-sky-200 border-sky-700' },
  LIVE: { label: 'Live', cls: 'bg-emerald-900/40 text-emerald-200 border-emerald-700' },
  PAUSED: { label: 'Paused', cls: 'bg-amber-900/40 text-amber-200 border-amber-700' },
};

export const ModeBadge = memo(function ModeBadge({
  runMode,
  size = 'md',
}: {
  runMode: StatusResponse['run_mode'];
  size?: 'sm' | 'md';
}) {
  const s = styles[runMode];
  const sizing =
    size === 'sm' ? 'px-2 py-0.5 text-xs rounded' : 'px-2.5 py-1 text-sm rounded-md';
  return (
    <span
      className={`inline-block border font-medium tracking-wide ${sizing} ${s.cls}`}
    >
      {s.label}
    </span>
  );
});
