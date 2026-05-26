import { useState, useRef, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lightweight tooltip that appears instantly on hover. Uses a portal
 * so the popup is never clipped by overflow:hidden containers.
 *
 * Usage:
 *   <Tooltip text="explanation here">
 *     <div>hoverable content</div>
 *   </Tooltip>
 */
export function Tooltip({
  text,
  content,
  children,
  preWrap,
}: {
  text?: string;
  content?: ReactNode;
  children: ReactNode;
  preWrap?: boolean;
}) {
  const [show, setShow] = useState(false);
  // #157: tooltip placement carries its own flag so the transform
  // matches the resolved `top`. Without this, flipping `top` to
  // `rect.bottom + margin` while the transform was still translating
  // by `-100%` placed the tooltip ABOVE the anchor (and offset by an
  // extra rect.height + margin), which on a hero card near the top
  // of the viewport read as "tooltip clipped against the top edge."
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'above' | 'below' } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!show || !ref.current) return;
    // The wrapper uses `display: contents`, which means `ref.current`
    // itself doesn't generate a layout box - getBoundingClientRect on
    // it returns {0,0,0,0} and the tooltip ends up pinned to the
    // top-left corner of the viewport instead of above the hovered
    // child. Measure the first element child instead. Fall through to
    // the wrapper's own rect only if that isn't available.
    const anchor =
      (ref.current.firstElementChild as HTMLElement | null) ?? ref.current;
    const rect = anchor.getBoundingClientRect();
    // Still zero? Bail out - positioning blindly would flash the tip
    // in the corner. Next mouseenter will try again.
    if (rect.width === 0 && rect.height === 0) return;
    const tipEl = tipRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;

    // Default: centered above the element
    let left = rect.left + rect.width / 2;
    let top = rect.top - margin;
    let placement: 'above' | 'below' = 'above';

    // If the tooltip would go off-screen, adjust
    if (tipEl) {
      const tipRect = tipEl.getBoundingClientRect();
      if (left - tipRect.width / 2 < margin) left = margin + tipRect.width / 2;
      if (left + tipRect.width / 2 > vw - margin) left = vw - margin - tipRect.width / 2;
      if (top - tipRect.height < margin) {
        // Not enough room above. Try below instead.
        const belowTop = rect.bottom + margin;
        if (belowTop + tipRect.height <= vh - margin) {
          top = belowTop;
          placement = 'below';
        }
        // If neither fits (very tall tip in a short viewport), keep
        // above-placement and let the top edge clip - same as before.
        // Operator on a phone with a 600px-tall tooltip can scroll
        // the anchor down before hovering as a workaround.
      }
    }

    setPos({ left, top, placement });
  }, [show]);

  return (
    <div
      ref={ref}
      className="contents"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => { setShow(false); setPos(null); }}
    >
      {children}
      {show && createPortal(
        <div
          ref={tipRef}
          className="fixed z-[100] pointer-events-none"
          style={{
            left: pos?.left ?? -9999,
            top: pos?.top ?? -9999,
            // `translate(-50%, ...)` centres horizontally; the vertical
            // term flips so the tooltip's bottom hugs `top` when above,
            // its top hugs `top` when below. Without this the flipped
            // case rendered with the wrong anchor edge.
            transform: `translate(-50%, ${pos?.placement === 'below' ? '0' : '-100%'})`,
          }}
        >
          <div className={`bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 shadow-lg max-w-xs leading-relaxed ${preWrap ? 'whitespace-pre-line' : 'whitespace-normal'}`}>
            {content ?? text}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
