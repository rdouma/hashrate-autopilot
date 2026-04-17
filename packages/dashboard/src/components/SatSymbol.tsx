/**
 * Satoshi symbol using the Font Awesome kit from satsymbol.com.
 * The kit is loaded via a script tag in index.html (16 KB).
 *
 * Uses the "light" weight (fa-light) — the variant the operator
 * selected from the satsymbol.com preview page. Other available
 * weights: fa-thin, fa-regular, fa-bold, plus italic versions.
 */

import { memo } from 'react';

export const SatSymbol = memo(function SatSymbol({
  className = '',
}: {
  className?: string;
}) {
  return <i className={`fak fa-regular ${className}`} aria-label="sat" />;
});
