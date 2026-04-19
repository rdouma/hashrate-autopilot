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
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!show || !ref.current) return;
    // The wrapper uses `display: contents`, which means `ref.current`
    // itself doesn't generate a layout box — getBoundingClientRect on
    // it returns {0,0,0,0} and the tooltip ends up pinned to the
    // top-left corner of the viewport instead of above the hovered
    // child. Measure the first element child instead. Fall through to
    // the wrapper's own rect only if that isn't available.
    const anchor =
      (ref.current.firstElementChild as HTMLElement | null) ?? ref.current;
    const rect = anchor.getBoundingClientRect();
    // Still zero? Bail out — positioning blindly would flash the tip
    // in the corner. Next mouseenter will try again.
    if (rect.width === 0 && rect.height === 0) return;
    const tipEl = tipRef.current;
    const vw = window.innerWidth;
    const margin = 8;

    // Default: centered above the element
    let left = rect.left + rect.width / 2;
    let top = rect.top - margin;

    // If the tooltip would go off-screen, adjust
    if (tipEl) {
      const tipRect = tipEl.getBoundingClientRect();
      if (left - tipRect.width / 2 < margin) left = margin + tipRect.width / 2;
      if (left + tipRect.width / 2 > vw - margin) left = vw - margin - tipRect.width / 2;
      if (top - tipRect.height < margin) {
        // Flip below
        top = rect.bottom + margin;
      }
    }

    setPos({ left, top });
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
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 shadow-lg max-w-xs whitespace-normal leading-relaxed">
            {text}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
