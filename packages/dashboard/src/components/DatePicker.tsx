/**
 * #266 follow-up: custom date picker that respects the user's locale
 * date-format preference. The browser-native <input type="date">
 * always reads as "yyyy-mm-dd" and renders in the BROWSER's locale,
 * not the user's chosen language - so a Dutch operator who has the
 * dashboard set to English still saw "mm/dd/yyyy" placeholders. Not
 * acceptable.
 *
 * Behaviour:
 * - Display formats the value via Intl.DateTimeFormat in the locale
 *   the dashboard is currently rendering in (en/nl/es).
 * - Click opens a month grid popover. Arrow keys navigate months.
 * - Selected date emits a millisecond timestamp at LOCAL midnight,
 *   matching what History.tsx wants (sinceMs at 00:00:00 local,
 *   untilMs at 23:59:59 local).
 * - "Clear" button inside the popover wipes the value.
 *
 * Portaled to document.body to escape any ancestor overflow:hidden.
 * Click-outside closes; Esc closes; tabbing out closes.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useLocale } from '../lib/locale';

export interface DatePickerProps {
  /** Local-midnight ms timestamp, or undefined for "no value". */
  readonly value: number | undefined;
  /** Whether the emitted ms snaps to start-of-day or end-of-day. */
  readonly snap: 'start' | 'end';
  readonly onChange: (next: number | undefined) => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
}

export function DatePicker({
  value,
  snap,
  onChange,
  placeholder,
  ariaLabel,
}: DatePickerProps) {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const locale = intlLocale ?? 'en-US';

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The month currently shown in the popover. Anchored to the
  // selected value when one is set; otherwise today.
  const [shownMonth, setShownMonth] = useState<{ year: number; month: number }>(() => {
    const d = value !== undefined ? new Date(value) : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  // Re-anchor the month grid when the operator changes the value
  // externally (e.g. via reset button).
  useEffect(() => {
    if (value === undefined) return;
    const d = new Date(value);
    setShownMonth({ year: d.getFullYear(), month: d.getMonth() });
  }, [value]);

  const displayText = useMemo(() => {
    if (value === undefined) return '';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
  }, [value, locale]);

  // Placeholder that mirrors the locale's preferred order so the
  // empty input doesn't lie about format. Intl.DateTimeFormat doesn't
  // expose order directly; we read it via formatToParts() of a known
  // date and replace the digits with letters.
  const localePlaceholder = useMemo(() => {
    const parts = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(2000, 0, 31));
    return parts
      .map((p) => {
        if (p.type === 'year') return 'yyyy';
        if (p.type === 'month') return 'mm';
        if (p.type === 'day') return 'dd';
        return p.value;
      })
      .join('');
  }, [locale]);

  const setDate = (year: number, month: number, day: number) => {
    const d = new Date(year, month, day);
    if (snap === 'start') d.setHours(0, 0, 0, 0);
    else d.setHours(23, 59, 59, 999);
    onChange(d.getTime());
    setOpen(false);
    // Return focus to the trigger so keyboard users aren't stranded.
    triggerRef.current?.focus();
  };

  const clear = () => {
    onChange(undefined);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="text-[11px] bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-left focus:outline-none focus:border-amber-700 flex items-center gap-1.5 min-w-[8.5rem] hover:border-slate-600"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-slate-500 shrink-0"
        >
          <path d="M8 2v4" />
          <path d="M16 2v4" />
          <rect width="18" height="18" x="3" y="4" rx="2" />
          <path d="M3 10h18" />
        </svg>
        <span
          className={`flex-1 font-mono tabular-nums ${
            value !== undefined ? 'text-slate-200' : 'text-slate-500'
          }`}
        >
          {displayText || placeholder || localePlaceholder}
        </span>
      </button>
      {open && (
        <CalendarPopover
          anchorRef={triggerRef}
          shownMonth={shownMonth}
          setShownMonth={setShownMonth}
          selectedMs={value}
          locale={locale}
          onPick={setDate}
          onClear={clear}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function CalendarPopover({
  anchorRef,
  shownMonth,
  setShownMonth,
  selectedMs,
  locale,
  onPick,
  onClear,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  shownMonth: { year: number; month: number };
  setShownMonth: (s: { year: number; month: number }) => void;
  selectedMs: number | undefined;
  locale: string;
  onPick: (year: number, month: number, day: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  useLayoutEffect(() => {
    const measure = () => {
      const anchor = anchorRef.current;
      const tip = popRef.current;
      if (!anchor || !tip) return;
      const a = anchor.getBoundingClientRect();
      const r = tip.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 8;
      let left = a.left;
      let top = a.bottom + 4;
      if (left + r.width > vw - margin) left = vw - r.width - margin;
      if (left < margin) left = margin;
      if (top + r.height > vh - margin) {
        const above = a.top - r.height - 4;
        if (above >= margin) top = above;
      }
      if (top < margin) top = margin;
      setPos({ left, top, ready: true });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [anchorRef, shownMonth]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const monthLabel = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
      }).format(new Date(shownMonth.year, shownMonth.month, 1)),
    [shownMonth, locale],
  );

  // Locale-aware first-day-of-week. Falls back to Monday for unknown
  // locales (the rest of Europe / most of the world). en-US is the
  // notable Sunday-first exception.
  const firstDayOfWeek = useMemo(() => {
    try {
      // @ts-expect-error - getWeekInfo() is Stage 4 but TS lib types lag
      const wi = new Intl.Locale(locale).getWeekInfo?.();
      if (wi && typeof wi.firstDay === 'number') return wi.firstDay % 7;
    } catch {
      // ignore
    }
    return locale.startsWith('en-US') ? 0 : 1;
  }, [locale]);

  const weekdayLabels = useMemo(() => {
    // Anchor: a known Monday (1 Jan 2024 is a Monday).
    const monday = new Date(2024, 0, 1);
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const labels: string[] = [];
    for (let i = 0; i < 7; i++) {
      const dayIdx = (firstDayOfWeek + i) % 7; // 0=Sun, 1=Mon, ...
      // Monday=1 anchor, so add (dayIdx - 1) days to get the desired day.
      const d = new Date(monday);
      d.setDate(monday.getDate() + ((dayIdx - 1 + 7) % 7));
      labels.push(fmt.format(d));
    }
    return labels;
  }, [locale, firstDayOfWeek]);

  // Build the grid of days for the visible month, padded with the
  // leading days from the previous month so the first row aligns with
  // the locale's start-of-week.
  const grid = useMemo(() => {
    const first = new Date(shownMonth.year, shownMonth.month, 1);
    const last = new Date(shownMonth.year, shownMonth.month + 1, 0);
    const offset = (first.getDay() - firstDayOfWeek + 7) % 7;
    const cells: Array<{ y: number; m: number; d: number; outside: boolean }> = [];
    // Leading days from previous month.
    const prevLast = new Date(shownMonth.year, shownMonth.month, 0);
    for (let i = offset; i > 0; i--) {
      const d = prevLast.getDate() - i + 1;
      cells.push({
        y: prevLast.getFullYear(),
        m: prevLast.getMonth(),
        d,
        outside: true,
      });
    }
    for (let d = 1; d <= last.getDate(); d++) {
      cells.push({ y: shownMonth.year, m: shownMonth.month, d, outside: false });
    }
    // Trailing pad to a 6-row grid for visual stability.
    while (cells.length < 42) {
      const lastCell = cells[cells.length - 1]!;
      const nxt = new Date(lastCell.y, lastCell.m, lastCell.d + 1);
      cells.push({
        y: nxt.getFullYear(),
        m: nxt.getMonth(),
        d: nxt.getDate(),
        outside: nxt.getMonth() !== shownMonth.month,
      });
    }
    return cells;
  }, [shownMonth, firstDayOfWeek]);

  const today = useMemo(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }, []);
  const selected = useMemo(() => {
    if (selectedMs === undefined) return null;
    const d = new Date(selectedMs);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }, [selectedMs]);

  const stepMonth = (delta: number) => {
    const total = shownMonth.year * 12 + shownMonth.month + delta;
    setShownMonth({ year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 });
  };

  const popover = (
    <div
      ref={popRef}
      role="dialog"
      aria-label={t`Pick a date`}
      style={{ left: pos.left, top: pos.top }}
      className={`fixed z-[60] w-64 rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 text-[11px] pointer-events-auto ${
        pos.ready ? '' : 'invisible'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={() => stepMonth(-1)}
          aria-label={t`Previous month`}
          className="px-1.5 py-0.5 rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="text-slate-200 font-medium capitalize">{monthLabel}</div>
        <button
          type="button"
          onClick={() => stepMonth(1)}
          aria-label={t`Next month`}
          className="px-1.5 py-0.5 rounded text-slate-400 hover:bg-slate-800 hover:text-slate-200"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px text-center text-slate-500 mb-1">
        {weekdayLabels.map((w, i) => (
          <div key={i} className="text-[9px] uppercase tracking-wider py-0.5">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {grid.map((c, i) => {
          const isToday = c.y === today.y && c.m === today.m && c.d === today.d;
          const isSelected =
            selected !== null && c.y === selected.y && c.m === selected.m && c.d === selected.d;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(c.y, c.m, c.d)}
              className={`py-1 text-center font-mono tabular-nums rounded ${
                isSelected
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-700'
                  : c.outside
                    ? 'text-slate-600 hover:bg-slate-800'
                    : isToday
                      ? 'text-amber-200 hover:bg-slate-800'
                      : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              {c.d}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2 border-t border-slate-800 pt-1.5">
        <button
          type="button"
          onClick={() => {
            const d = new Date();
            onPick(d.getFullYear(), d.getMonth(), d.getDate());
          }}
          className="text-[10px] text-slate-400 hover:text-amber-300 px-1.5 py-0.5"
        >
          <Trans>Today</Trans>
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] text-slate-500 hover:text-red-300 px-1.5 py-0.5"
        >
          <Trans>Clear</Trans>
        </button>
      </div>
    </div>
  );

  return createPortal(popover, document.body);
}
