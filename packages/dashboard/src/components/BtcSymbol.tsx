/**
 * Bitcoin sign (U+20BF), rendered as plain unicode text. Sibling of
 * SatSymbol, used everywhere we'd otherwise show the literal "BTC"
 * abbreviation - the operator preferred the symbol for visual parity
 * with the existing sat glyph in the header toggle and value labels.
 *
 * Unlike SatSymbol (Font Awesome kit), the Bitcoin sign is supported
 * by every modern OS font, so we don't pull in an extra glyph file.
 */

import { memo } from 'react';

export const BtcSymbol = memo(function BtcSymbol({
  className = '',
}: {
  className?: string;
}) {
  return (
    <span className={className} aria-label="BTC">
      ₿
    </span>
  );
});
