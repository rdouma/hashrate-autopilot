/**
 * #238 step 3: per-series color picker.
 *
 * Each picker shows a swatch button reflecting the current effective
 * color (override or default). Clicking opens a popover with the
 * curated preset palette, a native color input for custom picks, and
 * a "Reset" link to clear the override. Operator picks land on the
 * daemon via the parent's `onChange` and re-render the charts on the
 * next config refetch.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useEffect, useRef, useState } from 'react';
import type React from 'react';

import { CHART_COLOR_PRESETS } from '../lib/chartColors';
import { copyToClipboard } from '../lib/clipboard';

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export interface ChartColorPickerProps {
  /** Current effective color: override if set, else default. */
  value: string;
  /** Documented default (what `Reset` returns to). */
  defaultValue: string;
  /** Operator picked a color; `null` means "reset to default". */
  onChange: (next: string | null) => void;
  /** Whether the operator has an override on this slot. Drives the
   *  "Reset to default" link's visibility. */
  isOverridden: boolean;
}

/**
 * Renders a swatch button + popover. Uses a `<details>` element so we
 * don't have to wire global click-outside dismissal — the browser
 * handles open/closed state natively and the popover closes when
 * the user clicks the summary again or focuses elsewhere.
 */
export function ChartColorPicker({
  value,
  defaultValue,
  onChange,
  isOverridden,
}: ChartColorPickerProps): React.JSX.Element {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Click-outside close: native <details> doesn't auto-close on
  // outside clicks. Wire one up so the picker dismisses naturally.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = detailsRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.removeAttribute('open');
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const close = () => detailsRef.current?.removeAttribute('open');
  const pick = (color: string) => {
    onChange(color);
    close();
  };
  // #238 follow-up: Copy / Paste so the operator can mirror a hex
  // from one slot to another without retyping. `copyOk` flashes a
  // brief checkmark on the button after a successful copy.
  const [copyOk, setCopyOk] = useState(false);
  const handleCopy = async () => {
    try {
      await copyToClipboard(value);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch {
      // copyToClipboard throws on failure (insecure context with
      // no execCommand fallback either). Silent no-op; operator
      // can copy the hex text manually.
    }
  };
  const handlePaste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      // Accept "#RRGGBB" exactly. Some clipboards return "RRGGBB"
      // (no leading #), so we accept that too and add the prefix.
      const candidate = text.startsWith('#') ? text : `#${text}`;
      if (HEX_PATTERN.test(candidate)) {
        onChange(candidate.toLowerCase());
        close();
      }
    } catch {
      // Clipboard read denied (browser permission, file://, etc.).
      // Silent no-op; operator can use Custom picker instead.
    }
  };

  return (
    <details ref={detailsRef} className="relative inline-block">
      <summary
        className="list-none cursor-pointer inline-flex items-center gap-1.5 rounded border border-slate-700 px-1.5 py-1 hover:border-slate-500"
        title={t`Edit color`}
      >
        <span
          className="inline-block w-5 h-5 rounded border border-slate-600"
          style={{ backgroundColor: value }}
        />
        <span className="text-[10px] text-slate-400 font-mono uppercase tracking-wider">
          {value}
        </span>
      </summary>
      <div
        className="absolute z-20 mt-1 w-64 rounded-lg border border-slate-700 bg-slate-900 p-3 shadow-xl"
        // Stop the parent click from closing details immediately
        // when the operator clicks inside the popover.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-slate-500 mb-2 uppercase tracking-wider">
          <Trans>Presets</Trans>
        </div>
        <div className="grid grid-cols-6 gap-1.5 mb-3">
          {CHART_COLOR_PRESETS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              onClick={() => pick(swatch)}
              className="w-8 h-8 rounded border border-slate-700 hover:border-slate-400 transition"
              style={{ backgroundColor: swatch }}
              title={swatch}
              aria-label={swatch}
            />
          ))}
        </div>
        <label className="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span><Trans>Custom</Trans></span>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            className="w-12 h-7 rounded border border-slate-700 bg-transparent cursor-pointer"
          />
        </label>
        {/* #238 follow-up: Copy / Paste row. Operator can grab a hex
            from one slot and paste it into another without retyping
            (the common case being "use the same color on both
            charts' right axis"). */}
        <div className="flex items-center gap-2 mb-2 text-xs">
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-300"
            title={t`Copy hex to clipboard`}
          >
            {copyOk ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
          </button>
          <button
            type="button"
            onClick={handlePaste}
            className="px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-300"
            title={t`Paste hex from clipboard`}
          >
            <Trans>Paste</Trans>
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            close();
          }}
          disabled={!isOverridden}
          className="block text-xs text-amber-400 hover:underline disabled:text-slate-600 disabled:no-underline disabled:cursor-not-allowed"
        >
          <Trans>Reset to default</Trans>
          <span className="ml-2 inline-block w-3 h-3 rounded border border-slate-700 align-middle" style={{ backgroundColor: defaultValue }} />
        </button>
      </div>
    </details>
  );
}
