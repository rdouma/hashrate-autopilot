/**
 * Locale-friendly numeric input.
 *
 * Uses `type="text"` + `inputMode="decimal"` so:
 *   - Both `,` and `.` are accepted as the decimal separator (critical
 *     for es-UY, nl-NL and other comma-decimal locales).
 *   - We display the value with thousand separators via Intl.NumberFormat
 *     when the field doesn't have focus.
 *   - We allow free-form typing while focused (no reformatting mid-edit).
 */

import { useEffect, useState } from 'react';

export interface NumberFieldProps {
  value: number;
  onChange: (n: number) => void;
  step?: 'any' | 'integer';
  locale?: string | undefined;
  min?: number;
  max?: number;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Optional suffix rendered to the right of the field, e.g. "sat/PH/day".
   */
  suffix?: string;
}

function formatForDisplay(n: number, locale: string | undefined, isInteger: boolean): string {
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: isInteger ? 0 : 6,
  }).format(n);
}

function parseUserInput(raw: string): number | null {
  if (raw.trim() === '') return null;
  // Strip thousand separators (space, non-breaking space, or period used
  // as thousand sep in nl/de locales when the decimal is a comma).
  // We pick a decimal marker by looking for the LAST `,` or `.` as the
  // separator: in most locales the decimal is the rightmost separator.
  const trimmed = raw.replace(/[\u00A0\s]/g, '');
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  let normalised: string;
  if (lastComma === -1 && lastDot === -1) {
    normalised = trimmed;
  } else if (lastComma > lastDot) {
    // comma is decimal → drop dots, replace comma with dot
    normalised = trimmed.replace(/\./g, '').replace(',', '.');
  } else {
    // dot is decimal → drop commas
    normalised = trimmed.replace(/,/g, '');
  }
  const n = Number(normalised);
  return Number.isFinite(n) ? n : null;
}

export function NumberField({
  value,
  onChange,
  step = 'any',
  locale,
  min,
  max,
  className = '',
  placeholder,
  disabled,
  suffix,
}: NumberFieldProps) {
  const isInteger = step === 'integer';
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>(() => formatForDisplay(value, locale, isInteger));

  useEffect(() => {
    if (!focused) setDraft(formatForDisplay(value, locale, isInteger));
  }, [value, locale, focused, isInteger]);

  return (
    <div className="flex items-center gap-2 flex-1">
      <input
        type="text"
        inputMode={isInteger ? 'numeric' : 'decimal'}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={(e) => {
          setFocused(true);
          // Show raw value while editing so the user can select/edit cleanly.
          const raw = Number.isFinite(value)
            ? isInteger
              ? String(Math.round(value))
              : String(value)
            : '';
          setDraft(raw);
          setTimeout(() => e.target.select(), 0);
        }}
        onBlur={() => {
          setFocused(false);
          const parsed = parseUserInput(draft);
          if (parsed === null) {
            setDraft(formatForDisplay(value, locale, isInteger));
            return;
          }
          let n = parsed;
          if (isInteger) n = Math.round(n);
          if (typeof min === 'number' && n < min) n = min;
          if (typeof max === 'number' && n > max) n = max;
          onChange(n);
          setDraft(formatForDisplay(n, locale, isInteger));
        }}
        onChange={(e) => setDraft(e.target.value)}
        className={
          'bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm font-mono w-full ' +
          className
        }
      />
      {suffix && <span className="text-xs text-slate-500 whitespace-nowrap">{suffix}</span>}
    </div>
  );
}
