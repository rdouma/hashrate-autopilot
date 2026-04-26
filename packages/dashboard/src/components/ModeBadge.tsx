import { t } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { memo } from 'react';

import type { StatusResponse } from '../lib/api';

const styleClass: Record<StatusResponse['run_mode'], string> = {
  DRY_RUN: 'bg-sky-900/40 text-sky-200 border-sky-700',
  LIVE: 'bg-emerald-900/40 text-emerald-200 border-emerald-700',
  PAUSED: 'bg-amber-900/40 text-amber-200 border-amber-700',
};

export const ModeBadge = memo(function ModeBadge({
  runMode,
  size = 'md',
}: {
  runMode: StatusResponse['run_mode'];
  size?: 'sm' | 'md';
}) {
  const { i18n } = useLingui();
  void i18n;
  const label =
    runMode === 'DRY_RUN' ? t`Dry Run` : runMode === 'LIVE' ? t`Live` : t`Paused`;
  const sizing =
    size === 'sm' ? 'px-2 py-0.5 text-xs rounded' : 'px-2.5 py-1 text-sm rounded-md';
  return (
    <span
      className={`inline-block border font-medium tracking-wide ${sizing} ${styleClass[runMode]}`}
    >
      {label}
    </span>
  );
});
