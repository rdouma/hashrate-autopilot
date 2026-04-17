/**
 * Inline SVG of the Satoshi symbol — a stylized "S" with two
 * horizontal strokes. Renders at the current font size (1em) so
 * it flows naturally next to numbers in any text context.
 *
 * Design reference: satsymbol.com (open, free, unrestricted).
 * Self-drawn SVG to avoid the external Font Awesome kit dependency
 * (16 KB JS + CDN font fetches on every page load).
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
      {/* S-curve body */}
      <path
        d="M17.1 7.3c0-2.8-2.3-4.8-5.1-4.8-2.8 0-5.1 2-5.1 4.8 0 2.1 1.2 3.5 3.2 4.3l3.1 1.2c1.4.6 2 1.3 2 2.5 0 1.6-1.2 2.7-3.2 2.7-2 0-3.2-1.1-3.2-2.7H6.9c0 2.8 2.3 4.8 5.1 4.8 2.8 0 5.1-2 5.1-4.8 0-2.1-1.2-3.5-3.2-4.3l-3.1-1.2c-1.4-.6-2-1.3-2-2.5 0-1.6 1.2-2.7 3.2-2.7 2 0 3.2 1.1 3.2 2.7h1.9z"
      />
      {/* Two horizontal strokes */}
      <rect x="8" y="6.5" width="8" height="1.5" rx="0.5" />
      <rect x="8" y="16" width="8" height="1.5" rx="0.5" />
    </svg>
  );
});
