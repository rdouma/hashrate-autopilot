/**
 * #318 follow-up: a pulsing "sonar" beacon drawn on a chart marker that
 * was jumped to from a History log row. Same scale-transform pattern as
 * the alert-span / pool-block beacons (animating SVG `r` is Blink-only;
 * Firefox/Safari ignore it, so we animate `transform: scale`). Three
 * staggered rings give the radar-ping effect. Purely decorative -
 * `pointerEvents` off so it never steals a marker click.
 *
 * Render it as the last child inside a marker's <g> so it sits on top,
 * centered on the marker glyph. The parent decides when to show it
 * (i.e. when this marker is the focus target); this component is
 * presentational only.
 */
import type React from 'react';

export function MarkerBeacon({
  cx,
  cy,
  color,
  r = 5,
}: {
  cx: number;
  cy: number;
  color: string;
  r?: number;
}): React.JSX.Element {
  return (
    <g pointerEvents="none">
      <style>{`
        @keyframes markerFocusPing {
          0%   { transform: scale(1);   opacity: 0.95; }
          100% { transform: scale(6.8); opacity: 0;    }
        }
        .marker-focus-ping {
          animation: markerFocusPing 2.4s ease-out infinite;
          transform-box: fill-box;
          transform-origin: center;
          vector-effect: non-scaling-stroke;
          fill: none;
          stroke-width: 2;
        }
      `}</style>
      <circle cx={cx} cy={cy} r={r} className="marker-focus-ping" stroke={color} />
      <circle cx={cx} cy={cy} r={r} className="marker-focus-ping" stroke={color} style={{ animationDelay: '-0.8s' }} />
      <circle cx={cx} cy={cy} r={r} className="marker-focus-ping" stroke={color} style={{ animationDelay: '-1.6s' }} />
    </g>
  );
}
