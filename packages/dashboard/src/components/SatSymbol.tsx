/**
 * Inline SVG of the Satoshi (sat) symbol — three horizontal bars
 * tilted ~15° with a short vertical stroke crossing through at top
 * and bottom. Based on the satsymbol.com design (open, free,
 * unrestricted).
 *
 * Renders at the current font size (1em) so it flows naturally
 * next to numbers.
 */

import { memo } from 'react';

export const SatSymbol = memo(function SatSymbol({
  className = '',
}: {
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      width="1em"
      height="1em"
      className={`inline-block align-[-0.125em] ${className}`}
      aria-label="sat"
      role="img"
    >
      {/* Three tilted horizontal bars */}
      <rect x="4" y="7" width="14" height="2.2" rx="0.3" transform="rotate(-15 11 8.1)" />
      <rect x="5" y="11.5" width="14" height="2.2" rx="0.3" transform="rotate(-15 12 12.6)" />
      <rect x="6" y="16" width="14" height="2.2" rx="0.3" transform="rotate(-15 13 17.1)" />
      {/* Vertical stroke stubs (top-right and bottom-left) */}
      <rect x="14.5" y="2.5" width="2" height="5" rx="0.3" transform="rotate(-15 15.5 5)" />
      <rect x="7.5" y="17" width="2" height="5" rx="0.3" transform="rotate(-15 8.5 19.5)" />
    </svg>
  );
});
