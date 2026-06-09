import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ChartRange,
  CHART_RANGES,
  type ChartViewport,
  DEFAULT_CHART_RANGE,
  CHART_RANGE_SPECS,
  presetToViewport,
  viewportToNearestPreset,
} from '@hashrate-autopilot/shared';

const STORAGE_KEY = 'hashrate-chart-range';
const MIN_DURATION_MS = 10 * 60_000;
const MAX_DURATION_MS = 5 * 365 * 24 * 60 * 60_000;
const SETTLE_DELAY_MS = 200;
const ZOOM_FACTOR = 1.15;
const DRAG_THRESHOLD_PX = 5;
const LIVE_EDGE_TOLERANCE_MS = 120_000;
const SVG_VIEWBOX_WIDTH = 880;

export interface ViewportState {
  since_ms: number;
  until_ms: number;
  activePreset: ChartRange | null;
  liveEdge: boolean;
}

export interface UseChartViewportReturn {
  viewport: ViewportState;
  settledViewport: ViewportState;
  setPreset: (range: ChartRange) => void;
  goLive: () => void;
  reset: () => void;
  /** Tell the hook the earliest data timestamp so "All" uses real bounds. */
  setDataStart: (ms: number) => void;
  /**
   * #285: pan the viewport to centre on `centerMs`, optionally with a
   * specific window width. Clears `liveEdge` and `activePreset` so the
   * viewport doesn't snap back to "now" on the next tick. Used by the
   * `?focus_event=` handler when navigating from History → chart.
   */
  jumpToWindow: (centerMs: number, durationMs?: number) => void;
  /** Ref callback - attach to each chart SVG so scroll-to-zoom
   *  uses a non-passive native listener (prevents page scrolling). */
  wheelRef: (node: SVGSVGElement | null) => void;
  handlers: {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
  isLiveEdge: boolean;
  isFocused: boolean;
}

function readStored(): ViewportState {
  if (typeof window === 'undefined') {
    return { ...presetToViewport(DEFAULT_CHART_RANGE), activePreset: DEFAULT_CHART_RANGE, liveEdge: true };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const preset = (['3h', '6h', '12h', '24h', '1w', '1m', '1y', 'all'] as ChartRange[]).includes(raw as ChartRange)
    ? (raw as ChartRange)
    : DEFAULT_CHART_RANGE;
  if (preset === 'all') {
    const now = Date.now();
    return { since_ms: now - CHART_RANGE_SPECS['1y'].windowMs!, until_ms: now, activePreset: 'all', liveEdge: true };
  }
  return { ...presetToViewport(preset), activePreset: preset, liveEdge: true };
}

function persist(state: ViewportState): void {
  if (typeof window === 'undefined') return;
  if (state.activePreset) {
    window.localStorage.setItem(STORAGE_KEY, state.activePreset);
  }
}

function clampViewport(vp: ChartViewport): ChartViewport {
  const now = Date.now();
  let duration = vp.until_ms - vp.since_ms;
  if (duration < MIN_DURATION_MS) duration = MIN_DURATION_MS;
  if (duration > MAX_DURATION_MS) return { since_ms: now - MAX_DURATION_MS, until_ms: now };
  let until = Math.min(vp.until_ms, now);
  let since = until - duration;
  if (since < 0) {
    since = 0;
    until = Math.min(duration, now);
  }
  const minUntil = now - MAX_DURATION_MS;
  if (until < minUntil) {
    until = minUntil;
    since = until - duration;
  }
  return { since_ms: since, until_ms: until };
}

function quantize(ms: number, step: number): number {
  return Math.round(ms / step) * step;
}

function isAtLiveEdge(vp: ChartViewport): boolean {
  return Math.abs(vp.until_ms - Date.now()) < LIVE_EDGE_TOLERANCE_MS;
}

interface DragState {
  clientX: number;
  viewport: ViewportState;
  pointerId: number;
  captured: boolean;
  dataWidthPx: number;
  effectiveDuration: number;
}

export function useChartViewport(): UseChartViewportReturn {
  const [viewport, setViewport] = useState<ViewportState>(readStored);
  const [settledViewport, setSettledViewport] = useState<ViewportState>(viewport);
  const [isDragging, setIsDragging] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<DragState | null>(null);
  const dataStartRef = useRef<number | null>(null);

  const allViewport = useCallback((): ViewportState => {
    const now = Date.now();
    const ds = dataStartRef.current;
    if (ds === null) {
      return { since_ms: now - CHART_RANGE_SPECS['1y'].windowMs!, until_ms: now, activePreset: 'all' as ChartRange, liveEdge: true };
    }
    const since = ds - (now - ds) * 0.02;
    return { since_ms: Math.max(0, since), until_ms: now, activePreset: 'all' as ChartRange, liveEdge: true };
  }, []);

  const setDataStart = useCallback((ms: number) => {
    const prev = dataStartRef.current;
    dataStartRef.current = ms;
    if (viewport.activePreset === 'all' && (prev === null || ms < prev)) {
      const vp = allViewport();
      setViewport(vp);
      setSettledViewport(vp);
    }
  }, [viewport.activePreset, allViewport]);
  const focusedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const scheduleSettle = useCallback((vp: ViewportState) => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const q: ViewportState = {
        since_ms: quantize(vp.since_ms, 5000),
        until_ms: quantize(vp.until_ms, 5000),
        activePreset: vp.activePreset,
        liveEdge: vp.liveEdge,
      };
      setSettledViewport(q);
    }, SETTLE_DELAY_MS);
  }, []);

  const updateViewport = useCallback((vp: ViewportState) => {
    setViewport(vp);
    persist(vp);
    scheduleSettle(vp);
  }, [scheduleSettle]);

  const setPreset = useCallback((range: ChartRange) => {
    if (range === 'all') dataStartRef.current = null;
    const vp: ViewportState = range === 'all'
      ? allViewport()
      : { ...presetToViewport(range), activePreset: range, liveEdge: true };
    setViewport(vp);
    setSettledViewport(vp);
    persist(vp);
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, [allViewport]);

  const goLive = useCallback(() => {
    const preset = viewport.activePreset ?? DEFAULT_CHART_RANGE;
    setPreset(preset);
  }, [viewport.activePreset, setPreset]);

  // #285: centre the viewport on a specific timestamp. If durationMs
  // is unspecified, preserve the current viewport's width so the
  // operator doesn't lose their zoom level. liveEdge / activePreset
  // are cleared so the auto-snap-to-now timer doesn't fight us back.
  const jumpToWindow = useCallback(
    (centerMs: number, durationMs?: number) => {
      const width =
        durationMs ?? Math.max(60_000, viewport.until_ms - viewport.since_ms);
      const half = width / 2;
      const vp: ViewportState = {
        since_ms: centerMs - half,
        until_ms: centerMs + half,
        activePreset: null,
        liveEdge: false,
      };
      setViewport(vp);
      setSettledViewport(vp);
      persist(vp);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [viewport.until_ms, viewport.since_ms],
  );

  const reset = useCallback(() => {
    setPreset(DEFAULT_CHART_RANGE);
  }, [setPreset]);

  useEffect(() => {
    if (!viewport.liveEdge || viewport.activePreset === null) return;
    const spec = CHART_RANGE_SPECS[viewport.activePreset];
    if (spec.windowMs === null) return;
    const id = setInterval(() => {
      const now = Date.now();
      const vp: ViewportState = {
        since_ms: now - spec.windowMs!,
        until_ms: now,
        activePreset: viewport.activePreset,
        liveEdge: true,
      };
      setViewport(vp);
      setSettledViewport(vp);
    }, 60_000);
    return () => clearInterval(id);
  }, [viewport.activePreset, viewport.liveEdge]);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const updateViewportRef = useRef(updateViewport);
  updateViewportRef.current = updateViewport;
  const wheelSvgsRef = useRef(new Set<SVGSVGElement>());
  const wheelHandlerRef = useRef<((e: WheelEvent) => void) | null>(null);

  if (!wheelHandlerRef.current) {
    const YEAR_MS = CHART_RANGE_SPECS['1y'].windowMs!;
    const halfStep = Math.sqrt(ZOOM_FACTOR);
    wheelHandlerRef.current = (e: WheelEvent) => {
      if (!focusedRef.current) return;
      e.preventDefault();
      const svg = e.currentTarget as SVGSVGElement;
      if (!svg) return;
      const vp = viewportRef.current;
      if (e.deltaY === 0) return;
      const zoomingOut = e.deltaY > 0;

      if (vp.activePreset === 'all' && zoomingOut) return;

      // Use the effective viewport for zoom math. When since_ms precedes
      // the data start, the chart renders from the data start with 2%
      // padding. Zoom must match so the cursor anchors where the user
      // actually sees data, not in a hidden empty region.
      const ds = dataStartRef.current;
      let effSince = vp.since_ms;
      if (ds !== null && effSince < ds && vp.until_ms > ds) {
        const span = vp.until_ms - ds;
        effSince = Math.max(0, ds - span * 0.02);
      }
      const effDuration = vp.until_ms - effSince;

      const rect = svg.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const svgWidth = rect.width;
      const leftFrac = 80 / SVG_VIEWBOX_WIDTH;
      const rightFrac = (SVG_VIEWBOX_WIDTH - 80) / SVG_VIEWBOX_WIDTH;
      const pxLeft = svgWidth * leftFrac;
      const pxRight = svgWidth * rightFrac;
      const fraction = Math.max(0, Math.min(1, (clientX - pxLeft) / (pxRight - pxLeft)));
      const factor = zoomingOut ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
      let newDuration = Math.max(MIN_DURATION_MS, effDuration * factor);

      if (newDuration > YEAR_MS * halfStep) {
        const now = Date.now();
        const since = ds !== null ? Math.max(0, ds - (now - ds) * 0.02) : now - YEAR_MS;
        updateViewportRef.current({ since_ms: since, until_ms: now, activePreset: 'all' as ChartRange, liveEdge: true });
        return;
      }

      let snappedPreset: ChartRange | null = null;
      for (const key of CHART_RANGES) {
        const w = CHART_RANGE_SPECS[key].windowMs;
        if (w !== null && newDuration > w / halfStep && newDuration < w * halfStep) {
          newDuration = w;
          snappedPreset = key;
          break;
        }
      }
      const cursorTime = effSince + fraction * effDuration;
      const raw: ChartViewport = {
        since_ms: cursorTime - fraction * newDuration,
        until_ms: cursorTime + (1 - fraction) * newDuration,
      };
      const clamped = clampViewport(raw);

      // Snap to All if zoom-out reaches past all data at the live edge
      if (zoomingOut && ds !== null && clamped.since_ms <= ds && isAtLiveEdge(clamped)) {
        const now = Date.now();
        const since = Math.max(0, ds - (now - ds) * 0.02);
        updateViewportRef.current({ since_ms: since, until_ms: now, activePreset: 'all' as ChartRange, liveEdge: true });
        return;
      }

      const preset = snappedPreset ?? viewportToNearestPreset(clamped);
      const live = isAtLiveEdge(clamped);
      updateViewportRef.current({ ...clamped, activePreset: preset, liveEdge: live });
    };
  }

  const wheelRef = useCallback((node: SVGSVGElement | null) => {
    const handler = wheelHandlerRef.current;
    if (!handler) return;
    const svgs = wheelSvgsRef.current;
    if (node) {
      if (!svgs.has(node)) {
        node.addEventListener('wheel', handler, { passive: false });
        svgs.add(node);
      }
    } else {
      for (const svg of svgs) {
        if (!svg.isConnected) {
          svg.removeEventListener('wheel', handler);
          svgs.delete(svg);
        }
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      const handler = wheelHandlerRef.current;
      if (!handler) return;
      for (const svg of wheelSvgsRef.current) {
        svg.removeEventListener('wheel', handler);
      }
      wheelSvgsRef.current.clear();
    };
  }, []);

  const computeDataWidthPx = useCallback((svg: SVGSVGElement): number => {
    const rect = svg.getBoundingClientRect();
    const svgWidth = rect.width;
    const paddingLeft = 80;
    const paddingRight = 80;
    const leftFrac = paddingLeft / SVG_VIEWBOX_WIDTH;
    const rightFrac = (SVG_VIEWBOX_WIDTH - paddingRight) / SVG_VIEWBOX_WIDTH;
    return svgWidth * (rightFrac - leftFrac);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    svgRef.current = e.currentTarget;
    if (e.button !== 0) return;
    const ds = dataStartRef.current;
    let effSince = viewport.since_ms;
    if (ds !== null && effSince < ds) {
      const span = viewport.until_ms - ds;
      effSince = Math.max(0, ds - span * 0.02);
    }
    dragStart.current = {
      clientX: e.clientX,
      viewport,
      pointerId: e.pointerId,
      captured: false,
      dataWidthPx: computeDataWidthPx(e.currentTarget),
      effectiveDuration: viewport.until_ms - effSince,
    };
  }, [viewport, computeDataWidthPx]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    if (dragStart.current.viewport.activePreset === 'all') return;
    const deltaPx = e.clientX - dragStart.current.clientX;
    if (!dragStart.current.captured && Math.abs(deltaPx) > DRAG_THRESHOLD_PX) {
      e.currentTarget.setPointerCapture(dragStart.current.pointerId);
      dragStart.current.captured = true;
      setIsDragging(true);
    }
    if (dragStart.current.captured) {
      const startVp = dragStart.current.viewport;
      const deltaMs = -(deltaPx / dragStart.current.dataWidthPx) * dragStart.current.effectiveDuration;
      const raw: ChartViewport = {
        since_ms: startVp.since_ms + deltaMs,
        until_ms: startVp.until_ms + deltaMs,
      };
      const clamped = clampViewport(raw);
      setViewport({ ...clamped, activePreset: startVp.activePreset, liveEdge: false });
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    const wasDrag = dragStart.current.captured;
    if (wasDrag) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      const startVp = dragStart.current.viewport;
      const live = isAtLiveEdge(viewport);
      const vp: ViewportState = { ...viewport, activePreset: startVp.activePreset, liveEdge: live };
      updateViewport(vp);
    } else if (!focusedRef.current) {
      focusedRef.current = true;
      setIsFocused(true);
    }
    dragStart.current = null;
    setIsDragging(false);
  }, [viewport, updateViewport]);

  const onDoubleClick = useCallback(() => {
    goLive();
  }, [goLive]);

  useEffect(() => {
    const blur = () => {
      focusedRef.current = false;
      setIsFocused(false);
    };
    const handlePointerDown = (e: PointerEvent) => {
      if (svgRef.current && !svgRef.current.contains(e.target as Node)) blur();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') blur();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return {
    viewport,
    settledViewport,
    setPreset,
    goLive,
    reset,
    setDataStart,
    jumpToWindow,
    wheelRef,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    isDragging,
    isLiveEdge: viewport.liveEdge,
    isFocused,
  };
}
