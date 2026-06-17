import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import {
  CHART_RANGES,
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  showEventKindsForSpan,
  type ChartRange,
} from '@hashrate-autopilot/shared';

import { Bip110ScanCard } from '../components/Bip110ScanCard';
import { SoloMinersCard } from '../components/SoloMinersCard';
import { TilesBar } from '../components/TilesBar';
import { parseDashboardTiles } from '@hashrate-autopilot/shared';
import { HashrateChart, type HashrateRightAxis } from '../components/HashrateChart';
import { type PriceRightAxis } from '../components/PriceChart';
import { PriceChart } from '../components/PriceChart';
import { ModeBadge } from '../components/ModeBadge';
import { BtcSymbol } from '../components/BtcSymbol';
import { SatSymbol } from '../components/SatSymbol';
import { StaleUrlBanner } from '../components/StaleUrlBanner';
import { SortableDashboard, type DashboardBlock } from '../components/SortableDashboard';
import { Tooltip } from '../components/Tooltip';
import {
  api,
  UnauthorizedError,
  type BalanceView,
  type BidView,
  type FinanceResponse,
  type FinanceRangeResponse,
  type NextActionView,
  type OceanResponse,
  type ProposalView,
  type StatsResponse,
  type TickNowResponse,
  type StatusResponse,
} from '../lib/api';
import {
  formatAge,
  formatAgePrecise,
  formatCountdownPrecise,
  formatNumber,
  formatSatPerPH,
  formatSats,
  formatTimestampUtc,
} from '../lib/format';
import { applyExplorerTemplate } from '../lib/blockExplorer';
import { useDenomination } from '../lib/denomination';
import { copyToClipboard } from '../lib/clipboard';
import { actionModeLabel, bidStatusClass, bidStatusLabel } from '../lib/labels';
import { useDateTimeLocale, useFormatters, useLocale } from '../lib/locale';
import { localizedRangeLabel } from '../lib/range-label';
import { useChartViewport } from '../lib/useChartViewport';
import { useSharedCrosshair } from '../lib/chartCrosshair';
import { useCardOrderContext } from '../lib/cardOrderContext';

const RUN_MODES = ['DRY_RUN', 'LIVE', 'PAUSED'] as const;
const STATUS_QUERY_KEY = ['status'] as const;

// Frozen empties for chart props. Inline `?? []` allocates a fresh
// array each render; both PriceChart and HashrateChart are wrapped
// in `React.memo`, so the new reference forces them to recompute
// on every parent render. Sharing module-level frozen sentinels
// keeps the props referentially stable until the underlying query
// data actually arrives.
const EMPTY_METRIC_POINTS: readonly never[] = Object.freeze([]) as readonly never[];
const EMPTY_BID_EVENTS: readonly never[] = Object.freeze([]) as readonly never[];
const EMPTY_REWARD_EVENTS: readonly never[] = Object.freeze([]) as readonly never[];
const EMPTY_OUR_BLOCKS: readonly never[] = Object.freeze([]) as readonly never[];
const EMPTY_DEPOSITS: readonly never[] = Object.freeze([]) as readonly never[];
// #250: frozen sentinel so the IP-change marker prop stays referentially
// stable until real data arrives (charts are React.memo'd).
const EMPTY_IP_CHANGES: readonly never[] = Object.freeze([]) as readonly never[];

// #93: per-chart secondary Y-axis selection, persisted per-browser.
const HASHRATE_RIGHT_AXIS_KEY = 'hashrate-autopilot.hashrateRightAxis';
const PRICE_RIGHT_AXIS_KEY = 'hashrate-autopilot.priceRightAxis';

function readStoredHashrateRightAxis(
  fallback: HashrateRightAxis,
): HashrateRightAxis {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(HASHRATE_RIGHT_AXIS_KEY);
  if (
    raw === 'none' ||
    raw === 'share_log' ||
    raw === 'network_difficulty' ||
    raw === 'pool_hashrate' ||
    raw === 'pool_luck_24h' ||
    raw === 'pool_luck_7d' ||
    raw === 'pool_luck_30d' ||
    // #149: solo-mining series options. Without these here, picking
    // one of them and refreshing fell back to 'none' instead of
    // restoring the operator's selection.
    raw === 'solo_hashrate' ||
    raw === 'solo_device_count' ||
    raw === 'solo_max_temp' ||
    raw === 'solo_best_diff' ||
    raw === 'braiins_rejection_pct'
  ) {
    return raw;
  }
  return fallback;
}

function readStoredPriceRightAxis(fallback: PriceRightAxis): PriceRightAxis {
  if (typeof window === 'undefined') return fallback;
  const raw = window.localStorage.getItem(PRICE_RIGHT_AXIS_KEY);
  if (
    raw === 'none' ||
    // effective_rate was missing from this allow-list - pre-existing
    // bug; operators picking it then refreshing got 'none' back.
    raw === 'effective_rate' ||
    raw === 'estimated_block_reward' ||
    raw === 'btc_usd_price' ||
    raw === 'ocean_unpaid_sat' ||
    raw === 'paid_total_sat' ||
    raw === 'lifetime_earnings_sat' ||
    // #149: solo-mining power series.
    raw === 'solo_power_watts' ||
    raw === 'total_balance_sat' ||
    raw === 'avg_overpay_intent' ||
    raw === 'avg_overpay_settled'
  ) {
    return raw;
  }
  // 'network_difficulty' used to be valid here; falls through to
  // fallback so existing operators with that persisted choice get
  // 'none' on next load instead of a dead dropdown state.
  return fallback;
}

export function Status() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { intlLocale } = useLocale();
  const fmt = useFormatters();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const chartViewport = useChartViewport();
  // #257: one crosshair position shared by both charts - hover/pin on
  // either draws the synced marker line + per-chart readout on both.
  const chartCrosshair = useSharedCrosshair();
  const chartRange = chartViewport.viewport.activePreset ?? DEFAULT_CHART_RANGE;
  const setChartRange = chartViewport.setPreset;
  const vp = chartViewport.settledViewport;

  const isAll = chartViewport.viewport.activePreset === 'all';
  const visibleSpan = vp.until_ms - vp.since_ms;
  const fetchBounds = useMemo(() => {
    if (isAll) return { since_ms: 0, until_ms: Date.now() };
    const buffer = visibleSpan * 1.0;
    return {
      since_ms: Math.max(0, vp.since_ms - buffer),
      until_ms: Math.min(Date.now(), vp.until_ms + buffer),
    };
  }, [vp.since_ms, vp.until_ms, visibleSpan, isAll]);

  const [dataStartMs, setDataStartMs] = useState<number | null>(null);

  // #93: secondary Y-axis selection per chart. Default for the
  // hashrate chart picks up the legacy show_share_log_on_hashrate_chart
  // config toggle so existing operators don't lose their share_log
  // line on first load. After that, dropdown wins.
  const hashrateRightAxisDefault: HashrateRightAxis = 'none';
  const [hashrateRightAxis, setHashrateRightAxisState] = useState<HashrateRightAxis>(
    () => readStoredHashrateRightAxis(hashrateRightAxisDefault),
  );
  useEffect(() => {
    window.localStorage.setItem(HASHRATE_RIGHT_AXIS_KEY, hashrateRightAxis);
  }, [hashrateRightAxis]);

  const [priceRightAxis, setPriceRightAxisState] = useState<PriceRightAxis>(
    () => readStoredPriceRightAxis('none'),
  );
  useEffect(() => {
    window.localStorage.setItem(PRICE_RIGHT_AXIS_KEY, priceRightAxis);
  }, [priceRightAxis]);

  // #244 v3: operator-defined dashboard block order. Rearrange mode
  // toggles via a header button (always-on gutter was too costly,
  // especially on mobile). The grip handles only show in edit mode.
  const cardOrder = useCardOrderContext();
  const rearranging = cardOrder.rearranging;

  const query = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    // Status is the headline data (price, delivered, next-action). 30s
    // is fast enough for an autopilot that ticks once per minute and
    // slow enough that the operator's tab isn't constantly thrashing.
    // Per-second timers (NextActionFooter, NextActionProgress) tick
    // client-side so they keep moving between polls.
    refetchInterval: 30_000,
  });

  const runModeMutation = useMutation({
    mutationFn: (run_mode: (typeof RUN_MODES)[number]) => api.setRunMode(run_mode),
    onMutate: async (newRunMode) => {
      await qc.cancelQueries({ queryKey: ['status'] });
      const previous = qc.getQueryData<StatusResponse>(['status']);
      if (previous) {
        qc.setQueryData<StatusResponse>(['status'], { ...previous, run_mode: newRunMode });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(['status'], ctx.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const tickNowMutation = useMutation({
    mutationFn: () => api.tickNow(),
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });

  const metricsQuery = useQuery({
    queryKey: ['metrics', fetchBounds.since_ms, fetchBounds.until_ms],
    queryFn: () => api.metricsViewport(fetchBounds.since_ms, fetchBounds.until_ms, visibleSpan),
    placeholderData: keepPreviousData,
    refetchInterval: vp.liveEdge ? 60_000 : false,
  });

  const firstPointAt = metricsQuery.data?.points?.[0]?.tick_at ?? null;
  useEffect(() => {
    if (firstPointAt != null) {
      setDataStartMs(firstPointAt);
      chartViewport.setDataStart(firstPointAt);
    }
  }, [firstPointAt, chartViewport.setDataStart]);

  // #285/#288: id of the bid event being focused after a History →
  // chart jump. PriceChart renders a pulsing sonar beacon on the
  // matching marker; the beacon clears a few seconds after the
  // marker actually renders (handleFocusEventRendered below), with a
  // long fallback in case it never appears at all.
  const [focusedEventId, setFocusedEventId] = useState<number | null>(null);
  const focusClearTimer = useRef<number | null>(null);
  const focusFallbackTimer = useRef<number | null>(null);
  const focusScrollTimer = useRef<number | null>(null);

  // #288: PriceChart calls this once the focused marker is present in
  // its rendered set. The first call starts the clear countdown -
  // anchoring the countdown to render time (not click time) keeps the
  // beacon visible even when the metrics/events queries take a beat
  // on a cold navigation from /history.
  const handleFocusEventRendered = useCallback(() => {
    if (focusClearTimer.current !== null) return;
    if (focusFallbackTimer.current !== null) {
      window.clearTimeout(focusFallbackTimer.current);
      focusFallbackTimer.current = null;
    }
    // Re-anchor the scroll now that the marker exists - queries that
    // resolve after the initial scroll can grow the cards above the
    // chart and push it back out of view.
    document
      .getElementById('price-chart-block')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    focusClearTimer.current = window.setTimeout(() => {
      focusClearTimer.current = null;
      setFocusedEventId(null);
    }, 6_000);
  }, []);

  // Unmount-only timer cleanup. The focus timers deliberately survive
  // the URL-handoff effect's re-run: stripping the params changes
  // location.search, which re-runs that effect immediately, so an
  // effect-scoped cleanup would kill the timers (and the scroll
  // poller) milliseconds after arming them - exactly the bug that
  // made the original 5 s pulse and scroll-to-chart unreliable.
  useEffect(
    () => () => {
      if (focusClearTimer.current !== null) window.clearTimeout(focusClearTimer.current);
      if (focusFallbackTimer.current !== null) window.clearTimeout(focusFallbackTimer.current);
      if (focusScrollTimer.current !== null) window.clearInterval(focusScrollTimer.current);
    },
    [],
  );

  // #285: ?focus_event=<id>&at=<ms> handoff from History → chart. We
  // pass the timestamp directly so Status doesn't need a round-trip
  // to look the event up; the id drives the marker beacon. Pan the
  // price chart to the event's timestamp, then strip the params
  // (replaceState so the back button doesn't re-trigger the jump).
  // The viewport jump preserves the operator's current zoom width
  // when possible; if the chart was in a >24 h preset we fall back
  // to a 1 h centred window so a marker doesn't get lost in a year-
  // wide axis.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const atRaw = params.get('at');
    if (!atRaw) return;
    const at = Number.parseInt(atRaw, 10);
    if (!Number.isFinite(at)) return;
    // #288 follow-up (operator): always home in to a tight 3 h window
    // centred on the event, rather than preserving whatever zoom the
    // chart happened to be at. Landing on a 24 h (or wider) span left
    // the marker a tiny speck lost in the axis; 3 h gives enough
    // context around the event while making the beacon and marker
    // obvious. (3 h is also the tightest standard range preset.)
    const HOUR_MS = 60 * 60_000;
    const width = 3 * HOUR_MS;
    chartViewport.jumpToWindow(at, width);
    const idRaw = params.get('focus_event');
    if (idRaw) {
      const id = Number.parseInt(idRaw, 10);
      if (Number.isFinite(id)) {
        if (focusClearTimer.current !== null) {
          window.clearTimeout(focusClearTimer.current);
          focusClearTimer.current = null;
        }
        if (focusFallbackTimer.current !== null) {
          window.clearTimeout(focusFallbackTimer.current);
        }
        setFocusedEventId(id);
        // Fallback: if the marker never renders (event id gone, or
        // outside the fetched range), drop the focus after 60 s so a
        // stale beacon request doesn't pulse forever.
        focusFallbackTimer.current = window.setTimeout(() => {
          focusFallbackTimer.current = null;
          setFocusedEventId(null);
        }, 60_000);
      }
    }
    // #287 follow-up (operator): the price chart can sit below the
    // fold (hero cards above it, or a custom card order), so the jump
    // also scrolls the chart block into view. Poll briefly - the
    // block only mounts once the status query resolves, which on a
    // cold navigation from /history lands a beat after this effect.
    if (focusScrollTimer.current !== null) window.clearInterval(focusScrollTimer.current);
    let scrollTries = 0;
    focusScrollTimer.current = window.setInterval(() => {
      const el = document.getElementById('price-chart-block');
      scrollTries += 1;
      if (el !== null) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (el !== null || scrollTries >= 30) {
        if (focusScrollTimer.current !== null) {
          window.clearInterval(focusScrollTimer.current);
          focusScrollTimer.current = null;
        }
      }
    }, 100);
    params.delete('focus_event');
    params.delete('at');
    const next = params.toString();
    navigate(`/${next ? `?${next}` : ''}`, { replace: true });
    // location-driven effect; depend only on the URL string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  const effectiveViewportSince = useMemo(() => {
    if (dataStartMs != null && chartViewport.viewport.since_ms < dataStartMs) {
      const span = chartViewport.viewport.until_ms - dataStartMs;
      return dataStartMs - span * 0.02;
    }
    return chartViewport.viewport.since_ms;
  }, [dataStartMs, chartViewport.viewport.since_ms, chartViewport.viewport.until_ms]);

  const bidEventsQuery = useQuery({
    queryKey: ['bid-events', fetchBounds.since_ms, fetchBounds.until_ms, visibleSpan],
    queryFn: () =>
      api.bidEventsViewport(fetchBounds.since_ms, fetchBounds.until_ms, visibleSpan),
    placeholderData: keepPreviousData,
    refetchInterval: vp.liveEdge ? 60_000 : false,
  });

  // #250: public-IP change markers, keyed off the same viewport bounds
  // as the other chart-marker overlays.
  const ipChangesQuery = useQuery({
    queryKey: ['ip-changes', fetchBounds.since_ms, fetchBounds.until_ms],
    queryFn: () => api.ipChangesViewport(fetchBounds.since_ms, fetchBounds.until_ms),
    placeholderData: keepPreviousData,
    refetchInterval: vp.liveEdge ? 60_000 : false,
  });

  // #275: stat tiles aggregate over the VISIBLE viewport, not
  // `fetchBounds`. The fetch buffer (±1 window-width) exists so chart
  // series pan smoothly, but feeding it to /api/stats made the tiles
  // cover a silently 3×-wider window - an off-screen no-bid tick over
  // an hour left of the chart edge moved BID COVERAGE between 99.5
  // and 100.0 as the operator panned, with nothing visible changing.
  // Tooltips promise "% of the selected chart range"; honor that. At
  // a live preset, use the range-keyed endpoint so the server-side
  // per-range cache applies (same pattern as financeRangeQuery).
  const statsQuery = useQuery({
    queryKey: vp.liveEdge && vp.activePreset
      ? ['stats', vp.activePreset]
      : ['stats', vp.since_ms, vp.until_ms],
    queryFn: () => vp.liveEdge && vp.activePreset
      ? api.stats(vp.activePreset)
      : api.statsViewport(vp.since_ms, vp.until_ms),
    placeholderData: keepPreviousData,
    refetchInterval: vp.liveEdge ? 60_000 : false,
  });

  // Shared query instance for the Ocean panel AND the hashrate chart
  // marker overlay. React-query dedupes by queryKey so the Ocean card
  // and the chart use the same network call.
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 60_000,
  });

  // #266 follow-up: solo-miners snapshot powers the Bitaxe fleet
  // tiles (hashrate, power, J/TH) in TilesBar. Shared query key with
  // SoloMinersCard so React Query dedupes.
  const soloMinersQuery = useQuery({
    queryKey: ['solo-miners'],
    queryFn: api.soloMiners,
    refetchInterval: 30_000,
  });

  // Reward events drive the per-payout dot markers on the Price
  // chart's "paid earnings (lifetime)" + "lifetime earnings" lines.
  // Cap at the API's 500-row max so deeply-paid wallets don't lose
  // historical dots in pagination.
  const rewardEventsQuery = useQuery({
    queryKey: ['reward-events'],
    queryFn: () => api.rewardEvents(500),
    refetchInterval: 60_000,
  });

  const depositsQuery = useQuery({
    queryKey: ['deposits'],
    queryFn: () => api.deposits(),
    refetchInterval: 60_000,
  });

  const financeQuery = useQuery({
    queryKey: ['finance'],
    queryFn: api.finance,
    // 60s matches the rest of the dashboard polls. Earlier 1h cadence
    // assumed "money is slow-moving" - true for `spent` and
    // `collected`, but `unpaid earnings (Ocean)` jumps the moment a
    // new pool block lands and credits us. With 1h polling the P&L
    // Lifetime panel could lag the OCEAN panel by ~55 minutes after
    // a block - operator caught a 38k-sat update missing. /api/finance
    // is a cheap query, no server-side cache, so 60s is fine.
    refetchInterval: 60_000,
  });

  // Range-aware aggregates for the P&L per-day card (issue #43).
  // Separate query from /api/finance because the two have different
  // cadences - lifetime/Ocean data is hourly; range aggregates track
  // the ~1-min tick cadence. Keyed on `chartRange` so switching the
  // chart range picker above refetches with the new window.
  const financeRangeQuery = useQuery({
    queryKey: vp.liveEdge && vp.activePreset
      ? ['finance-range', vp.activePreset]
      : ['finance-range', vp.since_ms, vp.until_ms],
    queryFn: () => vp.liveEdge && vp.activePreset
      ? api.financeRange(vp.activePreset)
      : // #275: visible viewport, not the buffered fetchBounds - see
        // statsQuery above.
        api.financeRangeViewport(vp.since_ms, vp.until_ms),
    placeholderData: keepPreviousData,
    refetchInterval: vp.liveEdge ? 60_000 : false,
  });

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: 60_000,
  });

  // #149: per-tick fleet-aggregated solo-mining series for the chart
  // right-axis options (solo_hashrate / solo_device_count /
  // solo_max_temp / solo_power_watts). Only fetched when the master
  // toggle is on; otherwise the query is disabled and the charts
  // render no right-axis line. `since` follows the chart range so we
  // don't pull a week of samples to fill a 3h window.
  const soloMiningEnabled = configQuery.data?.config?.solo_mining_enabled ?? false;
  /**
   * Resolve the `since` timestamp to send to /api/solo-miners/series and
   * /api/solo-miners/best-diff-events for the current chart range:
   *
   *   - preset "all"  → since=0 (everything from the dawn of time).
   *                      CHART_RANGE_SPECS.all.windowMs is null and the
   *                      previous `?? 24h` fallback truncated the series
   *                      to a trailing 24h window at the widest preset.
   *   - other preset  → since = now - presetWindow.
   *   - custom (pan)  → since = vp.since_ms - line up exactly with the
   *                      visible viewport. The previous formula
   *                      (`now - (until - since)`) anchored to "now"
   *                      instead of "since", so a panned viewport over
   *                      old data returned the wrong slice.
   */
  const soloSinceMs = vp.activePreset
    ? (CHART_RANGE_SPECS[vp.activePreset].windowMs === null
        ? 0
        : Date.now() - CHART_RANGE_SPECS[vp.activePreset].windowMs!)
    : vp.since_ms;
  const soloSeriesQuery = useQuery({
    queryKey: vp.activePreset
      ? ['solo-fleet-series', vp.activePreset]
      : ['solo-fleet-series', vp.since_ms, vp.until_ms],
    queryFn: () => api.soloFleetSeries(soloSinceMs),
    enabled: soloMiningEnabled,
    refetchInterval: vp.activePreset ? 60_000 : false,
  });
  const soloSeries = soloMiningEnabled ? (soloSeriesQuery.data?.rows ?? []) : [];

  const bestDiffEventsQuery = useQuery({
    queryKey: vp.activePreset
      ? ['solo-best-diff-events', vp.activePreset]
      : ['solo-best-diff-events', vp.since_ms, vp.until_ms],
    queryFn: () => api.soloBestDiffEvents(soloSinceMs),
    enabled: soloMiningEnabled,
    refetchInterval: vp.activePreset ? 60_000 : false,
  });
  const bestDiffEvents = soloMiningEnabled ? (bestDiffEventsQuery.data?.events ?? []) : [];

  // Operator availability removed from the UI (API bids bypass 2FA;
  // see research.md §0.9). Backend field remains in case Braiins
  // changes policy. The endpoint still exists for future use.

  // #123/#172: count-based marker suppression across ALL marker types.
  // The cap applies to bid events + pool blocks + reward events combined.
  // When over cap, drop in priority order:
  //   1. EDIT_PRICE bid events (lowest signal)
  //   2. Non-own pool blocks (found_by_us === false; sky-blue context dots)
  //   3. Reward events
  //   4. Everything remaining
  const allOurBlocks = oceanQuery.data?.our_recent_blocks ?? EMPTY_OUR_BLOCKS;
  const allRewardEvents = rewardEventsQuery.data?.events ?? EMPTY_REWARD_EVENTS;
  const { visibleBidEvents, visibleOurBlocks, visibleRewardEvents, markersHiddenKind, markersHiddenCount } = useMemo(() => {
    const events = bidEventsQuery.data?.events ?? EMPTY_BID_EVENTS;
    const cap = configQuery.data?.config?.chart_max_markers ?? 0;
    // #225: count for the cap decision against what's *visible* on
    // the chart, not the full fetched (buffered) set. fetchBounds
    // widens the metrics + events fetch by 100% on each side of the
    // visible range for pan/zoom snappiness (see line ~145), so at a
    // 12h view we pull 36h of data. The old counter summed the full
    // 36h, so an active controller (~18 events/h) easily blew past
    // a 500 cap and nuked every EDIT_PRICE marker - even though only
    // ~220 events were in the visible 12h. Filter to the settled
    // viewport here. The step-down drops below still apply globally
    // to the arrays passed to PriceChart; PriceChart filters by
    // viewport on render, so the buffered out-of-view events stay
    // available for pan/zoom but don't inflate the cap.
    const since = vp.since_ms;
    const until = vp.until_ms;
    const eventsInView = events.filter(
      (e) => e.occurred_at >= since && e.occurred_at <= until,
    );
    const blocksInView = allOurBlocks.filter(
      (b) => b.timestamp_ms >= since && b.timestamp_ms <= until,
    );
    const rewardsInView = allRewardEvents.filter(
      (r) => r.detected_at >= since && r.detected_at <= until,
    );
    const totalCount = eventsInView.length + blocksInView.length + rewardsInView.length;
    if (cap <= 0 || totalCount <= cap) {
      return {
        visibleBidEvents: events,
        visibleOurBlocks: allOurBlocks,
        visibleRewardEvents: allRewardEvents,
        markersHiddenKind: null as null | 'edit_price' | 'pool_block' | 'reward_event' | 'all',
        markersHiddenCount: 0,
      };
    }
    let remaining = totalCount;
    let curEvents = events;
    let curBlocks = allOurBlocks;
    let curRewards = allRewardEvents;
    let hiddenKind: null | 'edit_price' | 'pool_block' | 'reward_event' | 'all' = null;
    let hiddenCount = 0;
    // Step 1: drop EDIT_PRICE bid events. hiddenCount is the
    // *visible* drop (what the operator perceives), so we count
    // visible-range EDIT_PRICE here; the underlying arrays still
    // drop globally because PriceChart re-filters by viewport.
    const withoutEditPrice = events.filter((e) => e.kind !== 'EDIT_PRICE');
    const editPriceDroppedInView = eventsInView.filter((e) => e.kind === 'EDIT_PRICE').length;
    if (remaining > cap && editPriceDroppedInView > 0) {
      remaining -= editPriceDroppedInView;
      hiddenCount += editPriceDroppedInView;
      curEvents = withoutEditPrice;
      hiddenKind = 'edit_price';
    }
    // Step 2: drop non-own pool blocks
    if (remaining > cap) {
      const ownOnly = allOurBlocks.filter((b) => b.found_by_us);
      const nonOwnDroppedInView = blocksInView.filter((b) => !b.found_by_us).length;
      if (nonOwnDroppedInView > 0) {
        remaining -= nonOwnDroppedInView;
        hiddenCount += nonOwnDroppedInView;
        curBlocks = ownOnly;
        hiddenKind = 'pool_block';
      }
    }
    // Step 3: drop reward events
    if (remaining > cap && rewardsInView.length > 0) {
      hiddenCount += rewardsInView.length;
      remaining -= rewardsInView.length;
      curRewards = EMPTY_REWARD_EVENTS;
      hiddenKind = 'reward_event';
    }
    // Step 4: drop everything (visible)
    if (remaining > cap) {
      hiddenCount = totalCount;
      return {
        visibleBidEvents: EMPTY_BID_EVENTS,
        visibleOurBlocks: EMPTY_OUR_BLOCKS,
        visibleRewardEvents: EMPTY_REWARD_EVENTS,
        markersHiddenKind: 'all' as const,
        markersHiddenCount: hiddenCount,
      };
    }
    return {
      visibleBidEvents: curEvents,
      visibleOurBlocks: curBlocks,
      visibleRewardEvents: curRewards,
      markersHiddenKind: hiddenKind,
      markersHiddenCount: hiddenCount,
    };
  }, [bidEventsQuery.data?.events, configQuery.data?.config?.chart_max_markers, allOurBlocks, allRewardEvents, vp.since_ms, vp.until_ms]);

  // #288: the marker cap must never hide the event the operator just
  // jumped to from /history (the cap drops EDIT_PRICE first, which is
  // also the most common kind to jump to). If the focused event got
  // capped away, re-append it from the raw fetched stream.
  const chartBidEvents = useMemo(() => {
    if (focusedEventId === null) return visibleBidEvents;
    if (visibleBidEvents.some((e) => e.id === focusedEventId)) return visibleBidEvents;
    const focused = (bidEventsQuery.data?.events ?? EMPTY_BID_EVENTS).find(
      (e) => e.id === focusedEventId,
    );
    return focused ? [...visibleBidEvents, focused] : visibleBidEvents;
  }, [visibleBidEvents, focusedEventId, bidEventsQuery.data?.events]);

  // #281: EDIT_SPEED events for the hashrate chart - a speed-limit
  // change moves the delivered-hashrate curve, so those markers
  // mirror onto the hashrate chart. Derived from the same cap-filtered
  // visibleBidEvents the price chart uses, gated by the active range's
  // showEventKinds (EDIT_SPEED is a rare kind: shown through 1w,
  // dropped at 1m+) so the two charts agree on what's visible.
  const speedEditEvents = useMemo(() => {
    const showKinds = vp.activePreset
      ? CHART_RANGE_SPECS[vp.activePreset].showEventKinds
      : showEventKindsForSpan(vp.until_ms - vp.since_ms);
    if (!showKinds.includes('EDIT_SPEED')) return EMPTY_BID_EVENTS;
    return visibleBidEvents.filter((e) => e.kind === 'EDIT_SPEED');
  }, [visibleBidEvents, vp.activePreset, vp.since_ms, vp.until_ms]);

  // #287 follow-up: Braiins-side bid-pause spans for the hatched
  // background bands on both charts. Built from the raw (un-capped)
  // event stream - bands are context, not markers, so the marker cap
  // must not drop them. A RESUMED without a preceding PAUSED in the
  // fetched window opens at -Infinity; a PAUSED without a RESUMED
  // runs to +Infinity. The charts clamp to their data range.
  const bidPauseIntervals = useMemo(() => {
    const events = bidEventsQuery.data?.events ?? EMPTY_BID_EVENTS;
    const transitions = events
      .filter((e) => e.kind === 'BID_PAUSED' || e.kind === 'BID_RESUMED')
      .sort((a, b) => a.occurred_at - b.occurred_at);
    const intervals: Array<{ x0: number; x1: number }> = [];
    let openAt: number | null = null;
    for (const e of transitions) {
      if (e.kind === 'BID_PAUSED') {
        if (openAt === null) openAt = e.occurred_at;
      } else if (openAt !== null) {
        // BID_RESUMED with a matching open pause - shade [pause, resume].
        intervals.push({ x0: openAt, x1: e.occurred_at });
        openAt = null;
      }
      // An orphan BID_RESUMED (no open pause) is deliberately ignored.
      // It means the daemon saw a paused->active transition but never
      // recorded the pause start - the bid was paused during daemon
      // downtime and a restart re-baselined as paused, or Braiins
      // flapped the status for a tick. We have NO pause-start time, so
      // the old `x0: -Infinity` painted the entire history as paused
      // even while hashrate was plainly delivering (operator bug,
      // 2026-06-13). Better to show nothing than a span we can't
      // substantiate. The lone BID_RESUMED glyph marker still renders.
    }
    if (openAt !== null) intervals.push({ x0: openAt, x1: Number.POSITIVE_INFINITY });
    return intervals;
  }, [bidEventsQuery.data?.events]);

  // #287 follow-up v3: run-mode idle bands (DRY_RUN / PAUSED),
  // computed here once for both charts. The per-tick run_mode column
  // gives retroactive coverage but only 1-tick resolution, so an
  // edge derived from ticks alone visibly misses the mode-change
  // marker (which carries the exact press time). For each edge we
  // therefore look for a MODE_CHANGE event inside the bracketing
  // tick gap and snap the edge to it; midpoint of the two ticks is
  // the fallback for history without events.
  const idleModeIntervals = useMemo(() => {
    const points = metricsQuery.data?.points ?? EMPTY_METRIC_POINTS;
    const modeChanges = (bidEventsQuery.data?.events ?? EMPTY_BID_EVENTS)
      .filter((e) => e.kind === 'MODE_CHANGE')
      .map((e) => e.occurred_at)
      .sort((a, b) => a - b);
    // Exact event time if one bracketing-gap event exists, else midpoint.
    const edgeBetween = (prevT: number | null, currT: number): number => {
      if (prevT === null) return currT;
      const snapped = modeChanges.find((t) => t >= prevT && t <= currT);
      return snapped ?? (prevT + currT) / 2;
    };
    const intervals: Array<{ x0: number; x1: number; mode: 'DRY_RUN' | 'PAUSED' }> = [];
    let idleStart: number | null = null;
    let idleMode: 'DRY_RUN' | 'PAUSED' | null = null;
    let prevT: number | null = null;
    for (const p of points) {
      const m = p.run_mode === 'DRY_RUN' || p.run_mode === 'PAUSED' ? p.run_mode : null;
      if (m !== idleMode) {
        const edge = edgeBetween(prevT, p.tick_at);
        if (idleStart !== null && idleMode !== null) {
          intervals.push({ x0: idleStart, x1: edge, mode: idleMode });
        }
        idleStart = m !== null ? edge : null;
        idleMode = m;
      }
      prevT = p.tick_at;
    }
    if (idleStart !== null && idleMode !== null) {
      intervals.push({ x0: idleStart, x1: prevT ?? idleStart, mode: idleMode });
    }
    return intervals;
  }, [metricsQuery.data?.points, bidEventsQuery.data?.events]);

  if (query.isError && query.error instanceof UnauthorizedError) {
    navigate('/login');
    return null;
  }

  if (query.isLoading) return <div className="text-slate-400"><Trans>loading…</Trans></div>;
  if (!query.data) {
    return <div className="text-red-400"><Trans>failed to load: {(query.error as Error)?.message}</Trans></div>;
  }

  const s: StatusResponse = query.data;

  // #167/#173: marketplace-empty banner. Only fires when Braiins is
  // reachable but the orderbook genuinely has no supply. When the API
  // is unreachable, the Next Action descriptor already shows
  // "Braiins API unreachable" and this banner stays silent.
  const marketplaceEmptyNow =
    s.market !== null &&
    s.market.fillable_ask_sat_per_ph_day === null &&
    s.actual_hashrate_ph < 0.05;
  // #244: each top-level dashboard block is a draggable unit. Build the
  // nodes keyed by stable ID here, then render them in the operator's
  // saved order (cardOrder) via <SortableDashboard>. StaleUrlBanner and
  // the rearrange controls stay pinned outside the sortable region.
  const blockNodes: Record<string, React.ReactNode> = {
    hero: (
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 h-full">
          <OperationsCard
            s={s}
            currentBidPH={primaryBidPricePH(s)}
            hashpricePH={financeQuery.data?.ocean?.hashprice_sat_per_ph_day ?? null}
            onRunMode={(m) => runModeMutation.mutate(m)}
            runModePending={runModeMutation.isPending}
          />
        </div>
        <div className="lg:col-span-3 h-full">
          <NextActionCard
            s={s}
            onTickNow={() => tickNowMutation.mutate()}
            tickPending={tickNowMutation.isPending}
            tickResult={tickNowMutation.data}
            marketplaceEmpty={marketplaceEmptyNow}
          />
        </div>
      </section>
    ),
    period: (
      <FilterBar
        range={chartRange}
        activePreset={chartViewport.viewport.activePreset}
        onRangeChange={setChartRange}
        isLiveEdge={chartViewport.isLiveEdge}
        onResetToLive={chartViewport.goLive}
      />
    ),
    indicators: (
      <TilesBar
        tileIds={parseDashboardTiles(configQuery.data?.config?.dashboard_tiles)}
        statsData={statsQuery.data}
        statusData={query.data}
        oceanData={oceanQuery.data}
        soloMinersData={soloMinersQuery.data}
        financeRangeData={financeRangeQuery.data}
        onTilesChange={(next) => {
          // PATCH /api/config with the new tile list. Optimistic
          // - we don't bounce the cache; React Query will refetch
          // - on the next interval. Persist failure surfaces in the
          // - existing config mutation error UI.
          if (!configQuery.data?.config) return;
          const cfg = {
            ...configQuery.data.config,
            dashboard_tiles: JSON.stringify(next),
          };
          void api.updateConfig(cfg).then(() => {
            qc.invalidateQueries({ queryKey: ['config'] });
          });
        }}
      />
    ),
    hashrate: (
      <div className="space-y-1">
        <div className="flex justify-end items-center gap-2 text-[11px] text-slate-400">
          <Trans>right axis</Trans>
          <select
            value={hashrateRightAxis}
            onChange={(e) =>
              setHashrateRightAxisState(e.target.value as HashrateRightAxis)
            }
            className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
          >
            <option value="none">{t`none`}</option>
            <option value="share_log">{t`share_log %`}</option>
            <option value="network_difficulty">{t`network difficulty`}</option>
            <option value="pool_hashrate">{t`pool hashrate`}</option>
            <option value="pool_luck_24h">{t`pool luck (24h)`}</option>
            <option value="pool_luck_7d">{t`pool luck (7d)`}</option>
            <option value="pool_luck_30d">{t`pool luck (30d)`}</option>
            <option value="braiins_rejection_pct">{t`rejection ratio (Braiins)`}</option>
            {/* #149: solo-mining series only listed when the master toggle is on. */}
            {soloMiningEnabled && (
              <>
                <option value="solo_hashrate">{t`Bitaxe hashrate`}</option>
                <option value="solo_device_count">{t`Bitaxe device count`}</option>
                <option value="solo_max_temp">{t`Bitaxe max temp`}</option>
                <option value="solo_best_diff">{t`Bitaxe best difficulty`}</option>
              </>
            )}
          </select>
        </div>
        <HashrateChart
          points={metricsQuery.data?.points ?? EMPTY_METRIC_POINTS}
          range={chartRange}
          onRangeChange={setChartRange}
          ourBlocks={visibleOurBlocks}
          blockExplorerTemplate={configQuery.data?.config?.block_explorer_url_template}
          shareLogPct={oceanQuery.data?.user?.share_log_pct ?? null}
          braiinsSmoothingMinutes={configQuery.data?.config?.braiins_hashrate_smoothing_minutes ?? 1}
          datumSmoothingMinutes={configQuery.data?.config?.datum_hashrate_smoothing_minutes ?? 1}
          rightAxisSeries={hashrateRightAxis}
          soloSeries={soloSeries}
          bestDiffEvents={bestDiffEvents}
          speedEditEvents={speedEditEvents}
          markersHiddenCount={markersHiddenCount}
          bidPauseIntervals={bidPauseIntervals}
          idleModeIntervals={idleModeIntervals}
          viewportHandlers={chartViewport.handlers}
          wheelRef={chartViewport.wheelRef}
          isDragging={chartViewport.isDragging}
          isFocused={chartViewport.isFocused}
          viewportSince={effectiveViewportSince}
          viewportUntil={chartViewport.viewport.until_ms}
          chartColorOverrides={configQuery.data?.config?.chart_color_overrides}
          ipChangeEvents={ipChangesQuery.data?.events ?? EMPTY_IP_CHANGES}
          crosshair={chartCrosshair}
        />
      </div>
    ),
    price: (
      <div className="space-y-1" id="price-chart-block">
        <div className="flex justify-end items-center gap-2 text-[11px] text-slate-400">
          <Trans>right axis</Trans>
          <select
            value={priceRightAxis}
            onChange={(e) =>
              setPriceRightAxisState(e.target.value as PriceRightAxis)
            }
            className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-[11px]"
          >
            <option value="none">{t`none`}</option>
            <option value="effective_rate">{t`effective rate`}</option>
            <option value="estimated_block_reward">{t`block reward`}</option>
            <option value="btc_usd_price">{t`BTC/USD`}</option>
            <option value="ocean_unpaid_sat">{t`unpaid earnings`}</option>
            <option value="paid_total_sat">{t`paid earnings (lifetime)`}</option>
            <option value="lifetime_earnings_sat">{t`lifetime earnings (paid + unpaid)`}</option>
            <option value="total_balance_sat">{t`Braiins balance`}</option>
            {/* #164: per-tick avg-overpay series, mirroring the two
                stat cards at the bottom of the Braiins panel. */}
            <option value="avg_overpay_intent">{t`avg overpay (intent)`}</option>
            <option value="avg_overpay_settled">{t`avg overpay (settled)`}</option>
            {/* #149: solo power (W) only listed when the master toggle is on. */}
            {soloMiningEnabled && (
              <option value="solo_power_watts">{t`Bitaxe power (W)`}</option>
            )}
          </select>
        </div>
        <PriceChart
          points={metricsQuery.data?.points ?? EMPTY_METRIC_POINTS}
          events={chartBidEvents}
          markersHiddenKind={markersHiddenKind}
          markersHiddenCount={markersHiddenCount}
          showEventKinds={vp.activePreset
            ? CHART_RANGE_SPECS[vp.activePreset].showEventKinds
            : showEventKindsForSpan(vp.until_ms - vp.since_ms)}
          maxOverpayVsHashpriceSatPerPhDay={s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day}
          overpaySatPerPhDay={
            configQuery.data?.config?.overpay_sat_per_eh_day != null
              ? configQuery.data.config.overpay_sat_per_eh_day / EH_PER_PH
              : null
          }
          priceSmoothingMinutes={configQuery.data?.config?.braiins_price_smoothing_minutes ?? 1}
          historicalPayoutsOffsetSat={
            configQuery.data?.config?.historical_payouts_offset_sat ?? 0
          }
          rightAxisSeries={priceRightAxis}
          soloSeries={soloSeries}
          rewardEvents={visibleRewardEvents}
          deposits={depositsQuery.data?.deposits ?? EMPTY_DEPOSITS}
          ourBlocks={visibleOurBlocks}
          blockExplorerTemplate={configQuery.data?.config?.block_explorer_url_template}
          txExplorerTemplate={configQuery.data?.config?.block_explorer_tx_url_template}
          shareLogPct={oceanQuery.data?.user?.share_log_pct ?? null}
          bidPauseIntervals={bidPauseIntervals}
          idleModeIntervals={idleModeIntervals}
          viewportHandlers={chartViewport.handlers}
          wheelRef={chartViewport.wheelRef}
          isDragging={chartViewport.isDragging}
          isFocused={chartViewport.isFocused}
          viewportSince={effectiveViewportSince}
          viewportUntil={chartViewport.viewport.until_ms}
          chartColorOverrides={configQuery.data?.config?.chart_color_overrides}
          ipChangeEvents={ipChangesQuery.data?.events ?? EMPTY_IP_CHANGES}
          crosshair={chartCrosshair}
          focusEventId={focusedEventId}
          onFocusEventRendered={handleFocusEventRendered}
        />
      </div>
    ),
    // Pipeline order: Braiins -> Datum -> Ocean (a share travels
    // Braiins-marketplace -> Datum-gateway -> Ocean-pool). Caps live
    // inside the Braiins card because they only describe what we do in
    // the marketplace. P&L sits below Bids as its own full-width
    // section; it's a financial summary of the pipeline, not a step.
    pipeline: (
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card
          title="Braiins"
          nextRefreshAtMs={s.next_tick_at}
          refetchQueryKey={STATUS_QUERY_KEY}
          badges={
            <ReachabilityBadge
              label={t`API reachable`}
              reachable={s.market !== null}
              downLabel={t`API DOWN`}
              title={t`Braiins marketplace API - reachable when the last observe() read market/orderbook/balance without error.`}
            />
          }
        >
          <Row k={t`delivered`} v={denomination.formatHashrate(s.actual_hashrate_ph)} />
          <Row
            k={t`target`}
            v={
              s.config_summary.cheap_mode_active
                ? `${denomination.formatHashrate(s.config_summary.effective_target_hashrate_ph)} ${t`(cheap mode)`}`
                : denomination.formatHashrate(s.config_summary.target_hashrate_ph)
            }
          />
          <Row k={t`floor`} v={denomination.formatHashrate(s.config_summary.minimum_floor_hashrate_ph)} />
          {/* #243: range-true Braiins rejection rate, computed
              server-side from raw tick_metrics rows (NOT the bucketed
              chart data the chart line uses). Comes through
              financeRangeQuery, which is already keyed off chartRange.
              Bypasses the bucket-MAX precision loss that previously
              made the card inconsistent across range presets - the
              operator caught it on 2026-06-02 when 6h read 0.04% but
              All read 0.17% on the same underlying data. Server picks
              first/last non-null cumulative values in the range and
              returns one number. */}
          <Row
            k={t`rejection ratio`}
            v={(() => {
              const pct = financeRangeQuery.data?.braiins_rejection_pct;
              if (pct === null || pct === undefined) return '—';
              return `${new Intl.NumberFormat(intlLocale, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }).format(pct)}%`;
            })()}
            tooltip={t`Share of Braiins-purchased shares the pool rejected, computed over the selected chart range. Server-side: (Δrejected_m / Δpurchased_m) × 100 across the first and last non-null cumulative counter samples in the range. Updates with the range selector above (3h / 6h / 24h / 1w / 1m / 1y / All). Reference points: Braiins documents ~0.05 % as their inherent marketplace-routing rate (best case when nothing miner-side is wrong); in practice, end-to-end values of 0.05-0.5 % are typical and considered healthy. Sustained values above ~1 % suggest something to investigate - stale shares from Datum being behind, worker identity misconfig, ASIC trouble, or pool-side issues. Rejected shares are still paid for under Braiins's terms (the buyer is responsible for target-pool quality).`}
          />
          {/* #144: gate on current-delivered-below-floor in addition to
              the daemon's debounce-held `below_floor_since` timer. The
              timer is kept non-null for ~3 above-floor ticks after a
              real recovery (FLOOR_DEBOUNCE_TICKS in observe.ts, #10
              -- guards against Braiins's lagged avg_speed_ph clearing
              the drought state on a single flickered tick). Showing
              the warning during that 3-min window misled the operator:
              "delivered 4 PH/s, but warning says below floor". The
              alert pipeline still uses the daemon timer untouched. */}
          {s.below_floor_since &&
            s.actual_hashrate_ph < s.config_summary.minimum_floor_hashrate_ph && (
              <div className="text-xs text-amber-400 mt-1">
                <Trans>below floor since {formatAge(s.below_floor_since)}</Trans>
              </div>
            )}
          {/*
           * Market + pricing block - Braiins-sourced numbers only.
           * Fillable-at-target leads (what we'd actually pay). Then
           * max-bid (+ its dynamic sibling) - the ceiling. Best bid /
           * best ask are market color at the bottom.
           *
           * Hashprice (break-even) is shown in the Ocean card - it's
           * an Ocean-derived figure, not a Braiins one, and mixing
           * them here misled operators into thinking the controller
           * was using a Braiins-sourced break-even reference.
           */}
          <div className="border-t border-slate-800 mt-2 pt-2">
            <Row
              k={s.config_summary.binding_cap === 'fixed' ? t`max bid (binding)` : t`max bid`}
              v={denomination.formatSatPerPhDay(s.config_summary.max_bid_sat_per_ph_day, intlLocale)}
            />
            {s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day !== null && (
              <>
                <Row
                  k={t`max over hashprice`}
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.max_overpay_vs_hashprice_sat_per_ph_day,
                    intlLocale,
                  )}
                />
                <Row
                  k={s.config_summary.binding_cap === 'dynamic' ? t`effective cap (binding)` : t`effective cap`}
                  v={denomination.formatSatPerPhDay(
                    s.config_summary.effective_cap_sat_per_ph_day,
                    intlLocale,
                  )}
                />
              </>
            )}
            <Row k={t`best bid`} v={denomination.formatSatPerPhDay(s.market?.best_bid_sat_per_ph_day ?? null, intlLocale)} />
            <Row k={t`best ask`} v={denomination.formatSatPerPhDay(s.market?.best_ask_sat_per_ph_day ?? null, intlLocale)} />
          </div>
          <div className="border-t border-slate-800 mt-2 pt-2">
            <BraiinsBalances
              balances={s.balances}
              actualSpendPerDaySat3h={s.actual_spend_per_day_sat_3h}
              locale={intlLocale}
              denomination={denomination}
            />
          </div>
          {/* #164: avg overpay above fillable - intent (time-weighted)
              and settled (delta-weighted) side by side. Period follows
              the chart's time-range selector via statsQuery. */}
          <div className="border-t border-slate-800 mt-2 pt-2 grid grid-cols-2 gap-2">
            <OverpayMiniCard
              label={t`avg overpay (intent)`}
              value={statsQuery.data?.avg_intent_overpay_sat_per_ph_day ?? null}
              intlLocale={intlLocale}
              denomination={denomination}
              tooltip={t`Time-weighted average of (our bid - fillable ask) per tick over the selected chart range. Reflects what the controller targeted - the price we posted regardless of whether we were delivering. Compare against the Overpay setting on Config → Pricing; sustained values above your configured overpay usually mean the bid is anchored above target (often by the 10-min price-decrease cooldown).`}
            />
            <OverpayMiniCard
              label={t`avg overpay (settled)`}
              value={statsQuery.data?.avg_settled_overpay_sat_per_ph_day ?? null}
              intlLocale={intlLocale}
              denomination={denomination}
              tooltip={t`Delta-consumed-weighted average of (effective rate paid - fillable ask) per tick. Same delta weighting as the avg cost delivered card so the two stay consistent. Reflects what we actually paid above fillable, post-billing. Zero-delivery ticks contribute nothing. Divergences from the intent card highlight where billing-period weighting matters - brief expensive blips during heavy delivery count more than long cheap stretches with no delivery.`}
            />
          </div>
        </Card>
        <DatumPanel
          url={s.config_summary.pool_url}
          reachable={s.pool.reachable}
          consecutiveFailures={s.pool.consecutive_failures}
          poolError={s.pool.error}
          poolLatencyMs={s.pool.latency_ms}
          datum={s.datum}
          nextTickAt={s.next_tick_at}
        />
        <OceanPanel />
      </section>
    ),
    bids: (
      <section>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Bids</Trans></h3>
        {s.bids.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 text-slate-500 text-sm">
            <Trans>no bids on this account</Trans>
          </div>
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden sm:block bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 bg-slate-900/50">
                  <tr>
                    <th className="text-left py-2 px-3"><Trans>id</Trans></th>
                    <th className="text-left py-2 px-3"><Trans>owner</Trans></th>
                    <th className="text-left py-2 px-3"><Trans>created</Trans></th>
                    <th className="text-right py-2 px-3"><Trans>price</Trans></th>
                    <th className="text-right py-2 px-3"><Trans>delivered / cap</Trans></th>
                    <th className="text-right py-2 px-3"><Trans>budget</Trans></th>
                    <th className="text-left py-2 px-3 w-32"><Trans>progress</Trans></th>
                    <th className="text-left py-2 px-3"><Trans>status</Trans></th>
                  </tr>
                </thead>
                <tbody>
                  {s.bids.map((b) => (
                    <tr key={b.braiins_order_id} className="border-t border-slate-800">
                      <td className="py-2 px-3 font-mono text-xs">
                        <BidIdCell id={b.braiins_order_id} />
                      </td>
                      <td className="py-2 px-3">
                        {b.is_owned ? (
                          <span className="text-emerald-400"><Trans>autopilot</Trans></span>
                        ) : (
                          <span className="text-amber-400"><Trans>unknown</Trans></span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs">
                        {b.created_at_ms ? (
                          <>
                            <div className="text-slate-300">{fmt.timestamp(b.created_at_ms)}</div>
                            <div className="text-[11px] text-slate-500">
                              {formatTimestampUtc(b.created_at_ms)}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-600">-</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        <FormattedValue v={denomination.formatSatPerPhDay(b.price_sat_per_ph_day, intlLocale)} />
                      </td>
                      <td className="py-2 px-3 text-right">
                        {denomination.formatHashrate(b.avg_speed_ph)}
                        <span className="text-xs text-slate-500">
                          {' '}
                          / {b.speed_limit_ph ? denomination.formatHashrate(b.speed_limit_ph) : '∞'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        <FormattedValue v={denomination.formatSat(b.amount_sat, intlLocale)} />
                      </td>
                      <td className="py-2 px-3">
                        <BidProgress pct={b.progress_pct} />
                      </td>
                      <td className={`py-2 px-3 text-xs ${bidStatusClass(b.status)}`}>
                        {bidStatusLabel(b.status)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile: cards */}
            <div className="sm:hidden space-y-2">
              {s.bids.map((b) => (
                <div key={b.braiins_order_id} className="bg-slate-900 border border-slate-800 rounded-lg p-3 space-y-2 text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-medium ${bidStatusClass(b.status)}`}>
                      {bidStatusLabel(b.status)}
                    </span>
                    {b.is_owned ? (
                      <span className="text-xs text-emerald-400"><Trans>autopilot</Trans></span>
                    ) : (
                      <span className="text-xs text-amber-400"><Trans>unknown</Trans></span>
                    )}
                    <span className="ml-auto font-mono text-xs text-slate-400">
                      <BidIdCell id={b.braiins_order_id} />
                    </span>
                  </div>
                  {b.created_at_ms && (
                    <div className="text-xs text-slate-500">
                      {fmt.timestamp(b.created_at_ms)}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <span className="text-slate-500"><Trans>price</Trans></span>
                    <span className="text-right font-mono text-slate-200">
                      <FormattedValue v={denomination.formatSatPerPhDay(b.price_sat_per_ph_day, intlLocale)} />
                    </span>
                    <span className="text-slate-500"><Trans>delivered / cap</Trans></span>
                    <span className="text-right text-slate-200">
                      {denomination.formatHashrate(b.avg_speed_ph)}
                      <span className="text-slate-500">
                        {' '}/ {b.speed_limit_ph ? denomination.formatHashrate(b.speed_limit_ph) : '∞'}
                      </span>
                    </span>
                    <span className="text-slate-500"><Trans>budget</Trans></span>
                    <span className="text-right font-mono text-slate-200">
                      <FormattedValue v={denomination.formatSat(b.amount_sat, intlLocale)} />
                    </span>
                  </div>
                  <BidProgress pct={b.progress_pct} />
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    ),
    finance: (
      <section>
        <FinancePanel
          data={financeQuery.data}
          rangeData={financeRangeQuery.data}
          status={s}
          chartRange={chartRange}
          onRefresh={() => {
            qc.invalidateQueries({ queryKey: ['finance'] });
            qc.invalidateQueries({ queryKey: ['finance-range'] });
          }}
          refreshing={financeQuery.isFetching || financeRangeQuery.isFetching}
        />
      </section>
    ),
    proposals:
      s.last_proposals.length > 0 ? (
        <section>
          <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Last tick proposals</Trans></h3>
          <ul className="space-y-1">
            {s.last_proposals.map((p, i) => (
              <li key={i}>
                <ProposalLine p={p} />
              </li>
            ))}
          </ul>
        </section>
      ) : null,
    bip110: <Bip110ScanCard />,
    solo: <SoloMinersCard />,
  };

  // #244: render blocks in the operator's saved order. Skip any whose
  // node is null this cycle (e.g. `proposals` when there's no last-tick
  // data) - the ID keeps its slot in the saved order for when it
  // returns.
  const blockLabels: Record<string, string> = {
    hero: t`Operations & next action`,
    period: t`Period selector`,
    indicators: t`Indicators`,
    hashrate: t`Hashrate chart`,
    price: t`Price chart`,
    pipeline: t`Pipeline`,
    bids: t`Bids`,
    finance: t`Profit & Loss`,
    proposals: t`Last tick proposals`,
    bip110: t`BIP-110 scan`,
    solo: t`Bitaxe miners`,
  };
  const orderedBlocks: DashboardBlock[] = cardOrder.order
    .filter((id) => blockNodes[id] != null)
    .map((id) => ({ id, label: blockLabels[id] ?? id, node: blockNodes[id] }));

  return (
    <div className="space-y-5">
      {/* #113: stale-URL banner. Renders only when there's a real
          mismatch between config and an active bid - silent otherwise. */}
      <StaleUrlBanner />
      {/* #244 v3: edit-mode hint + redundant Done button. The header
          toggle and this banner's Done are deliberately redundant -
          on mobile the operator shouldn't have to re-open the
          hamburger to confirm. Order is saved on every drag, so Done
          just exits edit mode. */}
      {rearranging && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-slate-500">
          <span>
            <Trans>Drag from the amber grip handle on the left of each card to reorder.</Trans>{' '}
            <Trans>Your layout is saved on this device.</Trans>
          </span>
          {cardOrder.isCustomized && (
            <button
              type="button"
              onClick={cardOrder.reset}
              className="text-slate-400 underline underline-offset-2 hover:text-slate-200"
            >
              <Trans>Reset to default order</Trans>
            </button>
          )}
          <button
            type="button"
            onClick={() => cardOrder.setRearranging(false)}
            className="ml-auto inline-flex items-center gap-1.5 rounded border border-emerald-600 bg-emerald-600/20 px-2.5 py-1 font-medium text-emerald-300 hover:bg-emerald-600/30"
          >
            <Trans>Done rearranging</Trans>
          </button>
        </div>
      )}
      <SortableDashboard
        blocks={orderedBlocks}
        editing={rearranging}
        onReorder={cardOrder.setOrder}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero operations card - run mode, action mode, operator avail, quiet hours.
// ---------------------------------------------------------------------------

const heroColors: Record<StatusResponse['run_mode'], string> = {
  DRY_RUN: 'from-sky-900/60 to-sky-950/40 border-sky-700/40',
  LIVE: 'from-emerald-900/60 to-emerald-950/40 border-emerald-700/40',
  PAUSED: 'from-amber-900/60 to-amber-950/40 border-amber-700/40',
};

/**
 * Pick the price (sat/PH/day) to display in the hero card from a
 * StatusResponse. We want the *current bid*, not the realised
 * effective rate (#69) - the latter is a per-tick measurement
 * artefact that swings with delivery and metering noise even after
 * the 30-min smoothing+cap layer. The bid is what we asked Braiins
 * to charge; under pay-your-bid that's the price actually paid.
 *
 * Returns null when no owned active bid exists yet (fresh install,
 * mid-CREATE, daemon paused). Caller renders an em-dash placeholder.
 */
function primaryBidPricePH(s: StatusResponse): number | null {
  const active = s.bids.find((b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE');
  if (active) return active.price_sat_per_ph_day;
  // Fall back to any owned bid (e.g. BID_STATUS_CREATED while waiting
  // for Telegram confirmation in legacy installs) so the operator
  // still sees what they're about to pay.
  const anyOwned = s.bids.find((b) => b.is_owned);
  return anyOwned ? anyOwned.price_sat_per_ph_day : null;
}

function OperationsCard({
  s,
  currentBidPH,
  hashpricePH,
  onRunMode,
  runModePending,
}: {
  s: StatusResponse;
  /**
   * Current owned-bid price in sat/PH/day. Under pay-your-bid this is
   * exactly the price Braiins charges per delivered EH-day, which is
   * what an operator wants to read at a glance. Distinct from the
   * window-averaged `AVG COST / PH DELIVERED` in the stats row (a
   * post-hoc realised rate where measurement noise washes out over
   * the chart range).
   */
  currentBidPH: number | null;
  /**
   * Current spot hashprice from Ocean, sat/PH/day. The delta next to
   * the price value is computed against this: positive = paying
   * above break-even, negative = paying below.
   */
  hashpricePH: number | null;
  onRunMode: (m: (typeof RUN_MODES)[number]) => void;
  runModePending: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  const actionVisible = s.action_mode !== 'NORMAL';

  const activeOwned = s.bids.filter(
    (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
  );
  const currentPricePH = currentBidPH;

  const deliveredColor =
    s.actual_hashrate_ph < s.config_summary.minimum_floor_hashrate_ph
      ? 'text-red-400'
      : s.actual_hashrate_ph < s.config_summary.target_hashrate_ph
        ? 'text-amber-300'
        : 'text-emerald-300';

  return (
    <section
      className={`bg-gradient-to-br ${heroColors[s.run_mode]} border rounded-xl p-5 h-full flex flex-col justify-center items-center text-center`}
    >
      {currentPricePH !== null ? (
        // #268: stacks vertically on mobile so the BTC-denomination
        // price (e.g. "0,00046582" - much longer than the sat
        // equivalent "46.582") has the full card width and doesn't
        // collide with the DELIVERED column on iPhone.
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full">
          <Tooltip text={t`Current owned-bid price (sat/PH/day). Under pay-your-bid this is exactly what Braiins charges per delivered EH-day - the live price you're paying. The plus/minus next to it is the spread vs Ocean's spot hashprice (positive = paying above break-even, negative = below). For the spend-weighted average paid across the selected chart range (handy when the bid moved during the window), see the AVG COST / PH DELIVERED stats card.`}>
            <div className="flex flex-col items-center cursor-help">
              <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1"><Trans>price</Trans></div>
              {/* #268: number + delta badge.
                  - On sm+ (>=640px): the wrapper is `relative` and the
                    badge is position:absolute outside the flow so the
                    big number stays centered regardless of badge width.
                  - On mobile (<sm): the wrapper is a flex-col so the
                    badge falls BELOW the number. The absolute path
                    overflowed the card on iPhone in BTC mode, where
                    the longer number (10 chars vs ~6 in sat mode)
                    pushed the badge past the right edge. */}
              <div className="leading-none flex flex-col items-center sm:block sm:relative">
                <span className="text-3xl sm:text-4xl font-mono font-semibold text-slate-100 tabular-nums">
                  {(() => {
                    // Route through the same formatter the muted subtitle
                    // uses, then drop the unit. The full formatter returns
                    // "{value} sat/EH/day" / "{value} BTC/PH/day" / "$X/TH/day"
                    // depending on the toggles; the suffix is rendered just
                    // below as <SatSymbol/> / "$" / "BTC" + the per-unit-day
                    // tail, so the big number must show only the value.
                    const full = denomination.formatSatPerPhDay(
                      currentPricePH,
                      intlLocale,
                    );
                    const sp = full.lastIndexOf(' ');
                    if (sp > 0) return full.slice(0, sp);
                    const m = full.match(/^(.+?)\/(?:TH|PH|EH)\/day$/);
                    return m?.[1] ?? full;
                  })()}
                </span>
                <span className="mt-1 sm:mt-0 sm:absolute sm:left-full sm:top-1/2 sm:-translate-y-1/2 sm:ml-1.5 whitespace-nowrap">
                  <PriceDeltaVsHashprice
                    currentPH={currentPricePH}
                    hashpricePH={hashpricePH}
                    intlLocale={intlLocale}
                  />
                </span>
              </div>
              <div className="text-xs text-slate-400 mt-1">
                {(() => {
                  // Strip the leading currency token (we render <SatSymbol/> /
                  // "$" / <BtcSymbol/> inline so the typography matches the
                  // hero number above). What's left is the per-unit-per-day
                  // tail ("/PH/day", "/EH/day", etc).
                  const r = denomination.rateSuffix;
                  const tail = r.replace(/^(sat|₿|\$)/, '');
                  return (
                    <>
                      {denomination.mode === 'usd'
                        ? '$'
                        : denomination.mode === 'btc'
                          ? <BtcSymbol />
                          : <SatSymbol />}
                      {tail}
                    </>
                  );
                })()}{' '}
                {activeOwned.length > 1 ? (
                  <Trans>current bid · primary of {activeOwned.length}</Trans>
                ) : (
                  <Trans>current bid</Trans>
                )}
              </div>
            </div>
          </Tooltip>
          <Tooltip
            text={t`Braiins's own \`state_estimate.avg_speed_ph\` reading - their internal estimate of current matched hashrate. Reacts to a CREATE_BID / EDIT_SPEED within ~3 min. The orange "delivered (Braiins)" line on the Hashrate chart below plots a different signal: real billed PH/s derived from the consumed-sat counter (Δconsumed / (bid × Δt)). That counter signal is the truthful long-run billing record but takes longer to catch up to a capacity bump because matched shares have to accumulate. During a Datum outage the counter goes to zero correctly while this estimate holds elevated for minutes - that's why the chart uses the counter signal.`}
          >
            <div className="flex flex-col items-center">
              <div className="text-[11px] uppercase tracking-wider text-slate-100 mb-1"><Trans>delivered</Trans></div>
              <div className={`text-3xl sm:text-4xl font-mono font-semibold tabular-nums leading-none ${deliveredColor}`}>
                {(() => {
                  const hr = denomination.formatHashrate(s.actual_hashrate_ph, intlLocale);
                  const split = splitUnit(hr);
                  return split ? split.num : hr;
                })()}
              </div>
              <div className="text-xs text-slate-400 mt-1">{denomination.hashrateSuffix}</div>
            </div>
          </Tooltip>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          <div className="text-3xl font-mono text-slate-500">-</div>
          <div className="text-xs text-slate-400 mt-0.5"><Trans>no active bid</Trans></div>
        </div>
      )}
      <RunModeToggle current={s.run_mode} onChange={onRunMode} disabled={runModePending} />
      {actionVisible && (
        <div className="mt-2 text-sm text-amber-200">
          ⚠ {actionModeLabel(s.action_mode)}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Next action card
// ---------------------------------------------------------------------------

const TICK_RESULT_STALE_MS = 30_000;

const TICK_RESULT_OUTCOME_STYLES: Record<string, string> = {
  EXECUTED: 'bg-emerald-900/40 text-emerald-300 border-emerald-700',
  DRY_RUN: 'bg-slate-800 text-slate-300 border-slate-700',
  BLOCKED: 'bg-amber-900/40 text-amber-300 border-amber-700',
  FAILED: 'bg-red-900/40 text-red-300 border-red-700',
};

function NextActionCard({
  s,
  onTickNow,
  tickPending,
  tickResult,
  marketplaceEmpty,
}: {
  s: StatusResponse;
  onTickNow: () => void;
  tickPending: boolean;
  tickResult: TickNowResponse | undefined;
  marketplaceEmpty: boolean;
}) {
  const { i18n } = useLingui();
  void i18n;
  // Auto-fade the tick-result banner after a short window. Without
  // this the "Edit price: executed" line sits there long after the
  // decision ran and confuses "what just happened" with "what's
  // currently happening".
  const [tickResultStale, setTickResultStale] = useState(false);
  useEffect(() => {
    if (!tickResult) {
      setTickResultStale(false);
      return;
    }
    setTickResultStale(false);
    const id = setTimeout(() => setTickResultStale(true), TICK_RESULT_STALE_MS);
    return () => clearTimeout(id);
  }, [tickResult]);
  const showTickResult = tickResult && !tickResultStale;

  const tickResultKindLabels: Record<string, string> = {
    CREATE_BID: t`Create bid`,
    EDIT_PRICE: t`Edit price`,
    EDIT_SPEED: t`Edit speed`,
    CANCEL_BID: t`Cancel bid`,
    PAUSE: t`Pause`,
  };
  const tickResultReasonLabels: Record<string, string> = {
    RUN_MODE_NOT_LIVE: t`not in LIVE mode`,
    RUN_MODE_PAUSED: t`paused`,
    ACTION_MODE_BLOCKS_CREATE_OR_EDIT: t`action mode blocks this`,
    PRICE_DECREASE_COOLDOWN: t`Braiins 10-min cooldown`,
    // #222: a bid's fee_rate_pct is above config.max_acceptable_fee_pct.
    FEE_THRESHOLD_EXCEEDED: t`Braiins fee above your threshold`,
  };

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-lg p-4 h-full flex flex-col">
      <div>
        <h3 className="text-xs uppercase tracking-wider text-slate-100 mb-1"><Trans>Next action</Trans></h3>
        {marketplaceEmpty ? (
          <div className="bg-amber-950/40 border border-amber-700/60 rounded-lg p-3 text-sm text-amber-200 mt-2">
            <Trans>
              <strong>Braiins marketplace empty.</strong> The orderbook has no asks that can fill your target hashrate, and delivery has fallen to zero. The autopilot is still bidding - this resolves automatically when supply returns. Nothing to do.
            </Trans>
          </div>
        ) : (
          <>
            <JustExecutedBanner last={s.next_action.last_executed} />
            <NextActionMessage next={s.next_action} />
            <NextActionProgress next={s.next_action} />
          </>
        )}
      </div>

      {!marketplaceEmpty && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={onTickNow}
            disabled={tickPending}
            title={t`Run the pending decision immediately - clears the post-edit lock and bypasses the patience/escalation timers so a waiting-to-settle EDIT_PRICE fires on this tick instead of after the full window.`}
            className="px-3 py-1.5 text-xs rounded border border-slate-700 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {tickPending ? <Trans>ticking…</Trans> : <Trans>Run decision now</Trans>}
          </button>
        </div>
      )}

      {showTickResult && tickResult && (
        <div className="mt-2 text-xs">
          {tickResult.ok
            ? (() => {
                const executed = tickResult.executed ?? [];
                if (executed.length === 0) {
                  return (
                    <span className="text-slate-400"><Trans>No action needed this tick.</Trans></span>
                  );
                }
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {executed.map((e, i) => {
                      const label = tickResultKindLabels[e.kind] ?? e.kind;
                      const pillClass =
                        TICK_RESULT_OUTCOME_STYLES[e.outcome] ??
                        'bg-slate-800 text-slate-300 border-slate-700';
                      const outcomeLabel = e.outcome.toLowerCase();
                      const reasonLabel = e.reason
                        ? tickResultReasonLabels[e.reason] ?? e.reason
                        : null;
                      return (
                        <span key={i} className="inline-flex items-center gap-1.5">
                          <span className="text-slate-300">{label}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${pillClass}`}
                          >
                            {outcomeLabel}
                          </span>
                          {reasonLabel && (
                            <span className="text-slate-500 text-[11px]">
                              - {reasonLabel}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })()
            : (
              <span className="text-red-400"><Trans>tick failed: {tickResult.error}</Trans></span>
            )}
        </div>
      )}

      <NextActionFooter
        tickAt={s.tick_at}
        nextTickAt={s.next_tick_at}
        tickIntervalMs={s.tick_interval_ms}
      />
    </section>
  );
}

/**
 * Single-line footer on the Next-Action card: left = "last tick" with
 * absolute timestamp + relative age, right = live-ticking countdown to
 * the next blip. The countdown ticks once per second client-side
 * (server poll only refreshes `next_tick_at` every 5s, which would
 * otherwise produce a step-jumping number).
 */
function NextActionFooter({
  tickAt,
  nextTickAt,
  tickIntervalMs,
}: {
  tickAt: number | null;
  nextTickAt: number | null;
  tickIntervalMs: number;
}) {
  const fmt = useFormatters();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // If the server hasn't told us when the next tick is, fall back to
  // tick_at + interval so the countdown still has something to show.
  const eta =
    nextTickAt ?? (tickAt !== null ? tickAt + tickIntervalMs : null);
  const remainingSec =
    eta !== null ? Math.max(0, Math.ceil((eta - now) / 1000)) : null;

  return (
    <div className="mt-3 pt-2 border-t border-slate-800 flex items-baseline justify-between gap-3 text-[11px] text-slate-500 font-mono">
      <span title={tickAt !== null ? formatTimestampUtc(tickAt) : ''}>
        <Trans>last tick:</Trans>{' '}
        <span className="text-slate-400">
          {tickAt !== null ? fmt.timestamp(tickAt) : '-'}
        </span>
        {tickAt !== null && (
          <span className="ml-1 text-slate-600">({formatAge(tickAt)})</span>
        )}
      </span>
      <span>
        {remainingSec === null
          ? '-'
          : remainingSec > 0 ? (
              <Trans>
                next in{' '}
                <span className="text-slate-300 tabular-nums">{remainingSec}s</span>
              </Trans>
            )
          : <span className="text-slate-400"><Trans>refreshing…</Trans></span>}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Effective-rate delta vs hashprice (hero card)
// ---------------------------------------------------------------------------

/**
 * Stock-ticker style ±delta of our effective-paid rate vs the spot
 * hashprice, rendered inline next to the big price number. Negative
 * (emerald) = paying below break-even.
 */
function PriceDeltaVsHashprice({
  currentPH,
  hashpricePH,
  intlLocale,
}: {
  currentPH: number;
  hashpricePH: number | null;
  intlLocale: string | undefined;
}) {
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;
  if (hashpricePH === null) return null;
  const delta = Math.round(currentPH - hashpricePH);
  const hashpricePretty = denomination.formatSatPerPhDay(Math.round(hashpricePH));

  if (delta === 0) {
    return (
      <span
        className="text-xs font-mono text-slate-400 cursor-help"
        title={t`Effective rate equals hashprice (${hashpricePretty}) - breaking even.`}
      >
        ±0
      </span>
    );
  }

  const sign = delta > 0 ? '+' : '−';
  const color = delta > 0 ? 'text-red-300' : 'text-emerald-300';
  const deltaFormatted = denomination.formatSatPerPhDay(Math.abs(delta));
  const tooltip =
    delta > 0
      ? t`Effective rate ${sign}${deltaFormatted} above hashprice (${hashpricePretty}) - positive means paying above break-even, negative means paying below (profitable).`
      : t`Effective rate ${sign}${deltaFormatted} below hashprice (${hashpricePretty}) - positive means paying above break-even, negative means paying below (profitable).`;

  return (
    <Tooltip text={tooltip}>
      <span className={`text-xs font-mono ${color} cursor-help`}>
        {sign}{denomination.mode === 'usd' && denomination.btcPrice
          ? denomination.formatSatPerPhDay(Math.abs(delta)).replace(/\/PH\/day$/, '')
          : formatNumber(Math.abs(delta), {}, intlLocale)}
      </span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// "Just executed" breadcrumb on the Next-Action card
// ---------------------------------------------------------------------------

const JUST_EXECUTED_VISIBLE_MS = 90_000;

/**
 * Briefly surfaces the most recent autopilot mutation so the operator
 * sees explicit confirmation when a tick fires - instead of the panel
 * silently jumping from "Will lower …" to "On target". Auto-fades
 * after ~90s. Re-renders every 5s so the relative-age text refreshes.
 */
/**
 * Translates the next-action message via the operator's active locale
 * by switching on the structured `descriptor` the daemon emits. Falls
 * back to the daemon's English `summary` / `detail` strings when the
 * descriptor is null (older client/server pair or one of the rare
 * paths that hasn't been classified yet).
 */
function NextActionMessage({ next }: { next: NextActionView }) {
  const { i18n } = useLingui();
  void i18n;
  const denomination = useDenomination();
  const d = next.descriptor;
  // Always reserve the detail-line row, mirroring JustExecutedBanner's
  // `&nbsp;`-spacer pattern. Some descriptor kinds (paused,
  // braiins_unreachable, no_market_supply, bid_pending) don't render
  // a detail line; without the spacer, transitioning into or out of
  // those kinds shifts the rest of the panel up or down by ~16 px.
  // The button row, tick-result row, and the rest of the page beneath
  // all move along with that jump - distracting on every state flip.
  const summary = d
    ? renderNextActionSummary(d, denomination)
    : relabelSummary(next.summary, denomination);
  const detail = d
    ? renderNextActionDetail(d, denomination)
    : next.detail
      ? relabelSummary(next.detail, denomination)
      : null;
  return (
    <>
      <div className="text-slate-100">{summary}</div>
      <div className="text-xs text-slate-400 mt-1">
        {detail ?? <span className="invisible select-none">&nbsp;</span>}
      </div>
    </>
  );
}

function renderNextActionSummary(
  d: NonNullable<NextActionView['descriptor']>,
  denomination: ReturnType<typeof useDenomination>,
): React.ReactNode {
  switch (d.kind) {
    case 'paused':
      return <Trans>Paused - no bids will be placed or edited until run mode changes.</Trans>;
    case 'unknown_bids':
      return <Trans>Unknown bid(s) detected - next tick will PAUSE the autopilot.</Trans>;
    case 'braiins_unreachable':
      return <Trans>Braiins API unreachable - waiting for connectivity.</Trans>;
    case 'awaiting_hashprice':
      return <Trans>Waiting for Ocean hashprice - trading is paused until the break-even reference is available.</Trans>;
    case 'no_market_supply':
      return <Trans>No hashrate available on the market right now.</Trans>;
    case 'will_create_bid': {
      const target = denomination.formatSatPerPhDay(d.target_ph);
      return d.run_mode === 'LIVE' ? (
        <Trans>Will place a CREATE_BID at {target} on the next tick.</Trans>
      ) : (
        <Trans>Will log (dry-run) a CREATE_BID at {target} on the next tick.</Trans>
      );
    }
    case 'bid_pending':
      return (
        <Trans>
          Bid {d.id_short} is {d.status} - waiting for it to become active.
        </Trans>
      );
    case 'cooldown_active':
      return <Trans>Bid above target - Braiins price-decrease cooldown active.</Trans>;
    case 'will_edit_bid': {
      const target = denomination.formatSatPerPhDay(d.target_ph);
      return d.run_mode === 'LIVE' ? (
        <Trans>Will edit bid to {target} on the next tick.</Trans>
      ) : (
        <Trans>Will log edit (dry-run) bid to {target} on the next tick.</Trans>
      );
    }
    case 'on_target':
      return d.capped ? (
        <Trans>At effective cap - desired fillable + overpay exceeds the ceiling.</Trans>
      ) : (
        <Trans>On target - bid at fillable + overpay.</Trans>
      );
  }
}

function renderNextActionDetail(
  d: NonNullable<NextActionView['descriptor']>,
  denomination: ReturnType<typeof useDenomination>,
): React.ReactNode | null {
  switch (d.kind) {
    case 'paused':
    case 'braiins_unreachable':
    case 'no_market_supply':
      return null;
    case 'unknown_bids':
      return <Trans>IDs: {d.ids.join(', ')}</Trans>;
    case 'awaiting_hashprice':
      return (
        <Trans>
          Ocean hashprice is required to evaluate the dynamic cap you configured. If this persists,
          check Ocean's reachability in the Ocean panel.
        </Trans>
      );
    case 'will_create_bid': {
      const targetHr = denomination.formatHashrate(d.target_hashrate_ph);
      if (d.budget.kind === 'configured') {
        const sat = denomination.formatSat(d.budget.sat);
        return <Trans>{targetHr} target, {sat} budget.</Trans>;
      }
      if (d.budget.kind === 'full_wallet') {
        const sat = denomination.formatSat(d.budget.available_sat);
        return (
          <Trans>
            {targetHr} target, {sat} budget (full wallet).
          </Trans>
        );
      }
      return (
        <Trans>{targetHr} target, full wallet balance (awaiting balance).</Trans>
      );
    }
    case 'bid_pending':
      // Telegram confirmation hint kept English-only on purpose: the
      // bot itself only speaks English. (Daemon-side `detail` is
      // non-null only when status is BID_STATUS_CREATED; in any other
      // pending state the detail line is absent.)
      return null;
    case 'cooldown_active': {
      const target = denomination.formatSatPerPhDay(d.target_ph);
      const current = denomination.formatSatPerPhDay(d.current_ph);
      return d.direction === 'lower' ? (
        <Trans>
          Will lower to {target} in ~{d.mins_left} min (current {current}).
        </Trans>
      ) : (
        <Trans>
          Will raise to {target} in ~{d.mins_left} min (current {current}).
        </Trans>
      );
    }
    case 'will_edit_bid': {
      const current = denomination.formatSatPerPhDay(d.current_ph);
      return d.clamped ? (
        <Trans>Current {current} - tracking fillable + overpay (clamped).</Trans>
      ) : (
        <Trans>Current {current} - tracking fillable + overpay.</Trans>
      );
    }
    case 'on_target': {
      const speed = denomination.formatHashrate(d.avg_speed_ph);
      return <Trans>Bid filling at {speed}.</Trans>;
    }
  }
}

function JustExecutedBanner({ last }: { last: NextActionView['last_executed'] }) {
  const [now, setNow] = useState(() => Date.now());
  const denomination = useDenomination();
  useEffect(() => {
    if (!last) return;
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [last]);

  // #154: always reserve the row even when there's nothing to show,
  // so the rest of the dashboard doesn't jump down by one line when a
  // recent mutation appears and back up when it ages out. Empty
  // container holds the same vertical space as a rendered banner.
  // `&nbsp;` keeps the text-line metrics; visibility-hidden on the
  // children would also work but invisible-but-present children muddle
  // a11y readers more than an inert spacer.
  const visible = last !== null && now - last.executed_at_ms <= JUST_EXECUTED_VISIBLE_MS;
  return (
    <div className="mb-2 flex items-baseline gap-2 text-xs">
      {visible ? (
        <>
          <span className="text-emerald-400">✓</span>
          <span className="text-emerald-200">{relabelSummary(last.summary, denomination)}</span>
          <span className="text-slate-500 text-[11px]">({formatAge(last.executed_at_ms)})</span>
        </>
      ) : (
        <span className="invisible select-none">&nbsp;</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next-action progress bar (issue #4)
// ---------------------------------------------------------------------------

const EVENT_COLORS: Record<NonNullable<NextActionView['event_kind']>, string> = {
  escalation: 'bg-amber-400',
  lower_after_override: 'bg-sky-400',
  lower_after_patience: 'bg-sky-400',
  lower_after_cooldown: 'bg-sky-400',
};

function NextActionProgress({ next }: { next: NextActionView }) {
  const { i18n } = useLingui();
  void i18n;
  // Re-render every second so the bar visibly creeps even between the
  // 5s status polls. Hook is only useful when an event is queued; gate
  // the interval below to avoid burning a timer in steady state.
  const hasEvent =
    next.eta_ms !== null && next.event_started_ms !== null && next.event_kind !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasEvent) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasEvent]);

  // Always reserve the progress-bar's vertical footprint (label row +
  // bar row). When no event is queued, render an invisible placeholder
  // of the same height so transitioning into/out of an event (cooldown,
  // escalation, patience, override) doesn't shift the rest of the
  // panel by ~30 px.
  if (!hasEvent) {
    return (
      <div className="mt-3" aria-hidden="true">
        <div className="flex items-baseline justify-between text-[11px] text-slate-400 mb-1 font-mono invisible select-none">
          <span>&nbsp;</span>
          <span>&nbsp;</span>
        </div>
        <div className="h-1.5 bg-slate-800/0 rounded overflow-hidden" />
      </div>
    );
  }
  const start = next.event_started_ms!;
  const end = next.eta_ms!;
  const span = Math.max(1, end - start);
  const elapsed = Math.max(0, Math.min(span, now - start));
  const fraction = elapsed / span;
  const remainingMs = Math.max(0, end - now);
  const overdue = end < now;
  const eventLabels: Record<NonNullable<NextActionView['event_kind']>, string> = {
    escalation: t`Escalation in`,
    lower_after_override: t`Override lock clears in`,
    lower_after_patience: t`Patience clears in`,
    lower_after_cooldown: t`Cooldown clears in`,
  };
  const label = eventLabels[next.event_kind!];
  const fillColor = overdue ? 'bg-red-400' : EVENT_COLORS[next.event_kind!];
  const remainingFormatted = formatRemaining(remainingMs);
  const overdueFormatted = formatRemaining(now - end);

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between text-[11px] text-slate-400 mb-1 font-mono">
        <span>{label}</span>
        <span className={overdue ? 'text-red-300' : ''}>
          {overdue ? <Trans>overdue {overdueFormatted}</Trans> : remainingFormatted}
        </span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded overflow-hidden">
        <div
          className={`h-full ${fillColor} transition-[width] duration-1000 ease-linear`}
          style={{ width: `${(fraction * 100).toFixed(2)}%` }}
        />
      </div>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tuning stats bar (between charts and cards)
// ---------------------------------------------------------------------------

const EH_PER_PH = 1000;


function FilterBar({
  range,
  activePreset,
  onRangeChange,
  isLiveEdge,
  onResetToLive,
}: {
  range: ChartRange;
  activePreset: ChartRange | null;
  onRangeChange: (r: ChartRange) => void;
  isLiveEdge: boolean;
  onResetToLive: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  return (
    // #266 follow-up: moved the time-range buttons to the LEFT side
    // of the period block so the tiles bar's "+ add tile" affordance
    // (anchored at the top-right of the indicators block right below
    // this one) doesn't overlap with them. The right side of this row
    // is now empty real estate the tile UI can use.
    <section className="flex items-center justify-start flex-wrap gap-2">
      {!isLiveEdge && (
        <button
          onClick={onResetToLive}
          className="text-xs px-2 py-1 rounded bg-amber-700/60 text-amber-200 hover:bg-amber-700"
        >
          {t`live`} &rarr;
        </button>
      )}
      <div className="flex gap-1">
        {CHART_RANGES.map((r) => (
          <button
            key={r}
            onClick={() => onRangeChange(r)}
            className={`text-xs px-2 py-1 rounded ${
              r === activePreset
                ? 'bg-emerald-700 text-emerald-100'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
            }`}
          >
            {localizedRangeLabel(r, i18n.locale)}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Four KPIs from the server-side `/api/stats` endpoint. The server
 * computes duration-weighted averages from the raw tick_metrics table
 * using SQL LEAD() window function, so each tick is weighted by its
 * actual duration - not an equal-weight approximation that distorts
 * on pre-aggregated chart buckets (1w/1m).
 *
 * Responds to the chart range filter (same query param) so the
 * operator can compare stats across 6h/24h/1w etc.
 */
function StatsBar({ statsData }: { statsData: StatsResponse | undefined }) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  if (!statsData) {
    const placeholderCards = [
      t`uptime`,
      t`avg braiins`,
      t`avg datum`,
      t`avg ocean`,
      t`avg cost delivered`,
      t`avg cost vs hashprice`,
    ];
    return (
      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {placeholderCards.map((label) => (
          <StatCard key={label} label={label} value="-" tooltip={t`Loading or daemon restart required.`} />
        ))}
      </section>
    );
  }

  if (statsData.tick_count < 2) return null;

  const {
    uptime_pct,
    uptime_bid_coverage_pct,
    uptime_delivery_when_bid_active_pct,
    avg_hashrate_ph,
    avg_datum_hashrate_ph,
    avg_ocean_hashrate_ph,
    avg_cost_per_ph_sat_per_ph_day,
    avg_overpay_vs_hashprice_sat_per_ph_day,
  } = statsData;
  // total_ph_hours + mutation_count remain on the server-side
  // StatsResponse even though no card consumes them - keeping the
  // shape stable so we can re-surface either later without a backend
  // round-trip.
  void statsData.total_ph_hours;
  void statsData.mutation_count;

  return (
    <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
      <StatCard
        label={t`uptime`}
        value={uptime_pct !== null ? `${formatNumber(uptime_pct, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, intlLocale)}%` : '\u2014'}
        tooltip={
          // #254: surface the orderbook-coverage vs delivery-quality
          // breakdown so the operator can tell "expected" downtime
          // (no order met our criteria) from "unexpected" downtime
          // (hardware / connection / Datum-side failure while a bid
          // was active). uptime_pct = bid_coverage \u00d7 delivery_when_bid_active.
          uptime_bid_coverage_pct !== null && uptime_delivery_when_bid_active_pct !== null
            ? t`Duration-weighted % of time with delivered hashrate > 0, computed over the selected chart range. Decomposes as bid coverage \u00d7 delivery rate while bidding: ${formatNumber(
                uptime_bid_coverage_pct,
                { minimumFractionDigits: 1, maximumFractionDigits: 1 },
                intlLocale,
              )}% of the window had an active Braiins bid (orderbook availability \u2014 low value here = "nothing matched my criteria", which is expected idle); of that bid-active time, ${formatNumber(
                uptime_delivery_when_bid_active_pct,
                { minimumFractionDigits: 1, maximumFractionDigits: 1 },
                intlLocale,
              )}% was actually delivering hashrate (hardware / connection / Datum-side quality \u2014 low value here = unexpected downtime). Each tick is weighted by its actual duration (time until the next tick) so gaps after restarts count proportionally. Updates with the range selector above.`
            : t`Duration-weighted % of time with delivered hashrate > 0, computed over the selected chart range. Each tick is weighted by its actual duration (time until the next tick) so gaps after restarts count proportionally. Updates with the range selector above.`
        }
        color={
          uptime_pct === null
            ? 'text-slate-400'
            : uptime_pct >= 90
              ? 'text-emerald-300'
              : uptime_pct >= 50
                ? 'text-amber-300'
                : 'text-red-300'
        }
      />
      <StatCard
        label={t`avg braiins`}
        value={denomination.formatHashrate(avg_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Braiins reports delivering, computed over the selected chart range. Includes downtime (where delivered = 0) so a bad stretch shows up in the average, not just the live card. Updates with the range selector above.`}
      />
      <StatCard
        label={t`avg datum`}
        value={denomination.formatHashrate(avg_datum_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Datum measures at the gateway, computed over the selected chart range. A sustained gap below Avg Braiins means Braiins is billing for hashrate Datum never saw arrive. Updates with the range selector above.`}
      />
      <StatCard
        label={t`avg ocean`}
        value={denomination.formatHashrate(avg_ocean_hashrate_ph, intlLocale)}
        tooltip={t`Duration-weighted average of the hashrate Ocean credits to our payout address, computed over the selected chart range. Each tick (every 60 s) the daemon calls Ocean's /v1/user_hashrate endpoint and reads the \`hashrate_300s\` field - Ocean's own 5-minute sliding-window estimate for this wallet. So: sampled every minute, each sample is a 5-minute smoothed value. A sustained gap below Avg Braiins / Avg Datum means the pool isn't crediting work we think we delivered. Updates with the range selector above.`}
      />
      <StatCard
        label={t`avg cost delivered`}
        value={avg_cost_per_ph_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_cost_per_ph_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip={t`Average effective rate over the selected chart range - what Braiins actually charged per PH/day delivered. Computed as the delta-weighted harmonic mean of the bid: SUM(Δconsumed_sat) ÷ SUM(Δconsumed_sat ÷ bid). Under pay-your-bid the bid IS the price, so when the bid is constant across the window this equals the bid exactly; when the bid varies (mid-window edits) it's the spend-weighted average. Periods of zero delivery contribute zero to both sides and don't skew the result. For the current bid price see the NEXT ACTION panel.`}
      />
      <StatCard
        label={t`avg cost vs hashprice`}
        value={avg_overpay_vs_hashprice_sat_per_ph_day !== null ? denomination.formatSatPerPhDay(Math.round(avg_overpay_vs_hashprice_sat_per_ph_day), intlLocale) : '\u2014'}
        tooltip={t`(avg cost delivered) minus the delta-weighted average hashprice during periods we were actually billed, computed over the selected chart range. Negative means we paid below break-even (good - cheaper than mining at current difficulty), positive means above. Same delta weighting as the avg cost card so the two stay consistent. Updates with the range selector above.`}
        color={
          avg_overpay_vs_hashprice_sat_per_ph_day === null
            ? 'text-slate-100'
            : avg_overpay_vs_hashprice_sat_per_ph_day < 0
              ? 'text-emerald-300'
              : avg_overpay_vs_hashprice_sat_per_ph_day > 0
                ? 'text-red-300'
                : 'text-slate-100'
        }
      />
    </section>
  );
}

function StatCard({
  label,
  value,
  tooltip,
  color = 'text-slate-100',
}: {
  label: string;
  value: string;
  tooltip: string;
  color?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 cursor-help text-center">
        {/* Reserve two lines for the label so single-line cards
            ("uptime") line up with two-line cards ("avg cost / PH
            delivered") - otherwise the big numbers underneath
            don't share a baseline. */}
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2 min-h-8 leading-4 flex items-start justify-center">
          <span>{label}</span>
        </div>
        <div className={`text-2xl font-mono tabular-nums ${color}`}>
          {split ? split.num : value}
        </div>
        {split && (
          <div className="text-xs text-slate-500 mt-0.5"><SatUnit unit={split.unit} /></div>
        )}
      </div>
    </Tooltip>
  );
}

/**
 * #164: compact two-up stat card used inside the Braiins panel for
 * the avg-overpay (intent / settled) pair. Smaller than the
 * top-strip StatCard - the Braiins panel is already dense; a full
 * StatCard would dwarf the existing label/value rows above it.
 * Sign-coloured: positive values (bid above fillable, expected
 * under pay-your-bid) render in the regular slate; deeply negative
 * values (rare; bid below fillable, usually a transient marketplace
 * artefact) render in emerald to flag them as unusual.
 */
function OverpayMiniCard({
  label,
  value,
  intlLocale,
  denomination,
  tooltip,
}: {
  label: string;
  value: number | null;
  intlLocale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
  tooltip: string;
}) {
  const formatted = value !== null
    ? denomination.formatSatPerPhDay(Math.round(value), intlLocale)
    : '-';
  const split = splitUnit(formatted);
  const color = value !== null && value < 0 ? 'text-emerald-300' : 'text-slate-100';
  return (
    <Tooltip text={tooltip}>
      <div className="bg-slate-950/40 border border-slate-800 rounded p-2 cursor-help text-center">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1 leading-tight">
          {label}
        </div>
        <div className={`text-sm font-mono tabular-nums ${color}`}>
          {split ? split.num : formatted}
        </div>
        {split && (
          <div className="text-[10px] text-slate-500 mt-0.5">
            <SatUnit unit={split.unit} />
          </div>
        )}
      </div>
    </Tooltip>
  );
}

function formatFillTime(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m`;
}

// ---------------------------------------------------------------------------

/**
 * Self-ticking "updated X ago" label. Re-renders every 10 s so the
 * operator actually sees the age climb (previously it was pinned to
 * "0s ago" because `checked_at_ms` was Date.now() on every response).
 */
function TickingAge({ epochMs }: { epochMs: number | null | undefined }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return <span><Trans>updated {formatAgePrecise(epochMs)}</Trans></span>;
}

/**
 * Forward countdown - "refreshes in 42s", "refreshes in 2m 13s".
 * The panel decides when it will next fetch and hands us that
 * timestamp; we re-render once per second so the digits tick visibly.
 * Prefer this over {@link TickingAge} on panels that refresh on a
 * predictable cadence - operators want to know how long until new
 * data, not how old the current data is.
 */
function RefreshCountdown({
  nextAtMs,
  refetchQueryKey,
}: {
  nextAtMs: number | null | undefined;
  /**
   * When the countdown hits zero, invalidate this query so the
   * panel's data catches up without waiting for react-query's next
   * scheduled poll. Needed on panels whose `nextAtMs` tracks a
   * server-side cadence (daemon tick) that's faster than the
   * dashboard's background poll interval - otherwise "refreshing…"
   * sits on screen for up to the poll interval (30s for /api/status)
   * even when the underlying data source is instant.
   */
  refetchQueryKey?: readonly unknown[];
}) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!refetchQueryKey || nextAtMs == null) return;
    // Self-rescheduling timer. Naive setTimeout(..., msUntil + 300) is
    // not enough: `next_tick_at` is derived from `runtime.last_tick_at
    // + tickIntervalMs`, and `last_tick_at` is only written *after*
    // the tick's observe/decide/execute/persist chain finishes. If the
    // refetch lands while the daemon is mid-tick, the response still
    // carries the previous `next_tick_at` - same number as before, so
    // the effect-deps don't change, and the countdown stays on
    // "refreshing…" until the next react-query poll (up to
    // refetchInterval, i.e. 30 s for /api/status). Instead we keep
    // invalidating every 2 s while the current `nextAtMs` is still in
    // the past; the first fresh response updates `nextAtMs`, the
    // effect re-runs with a new dep value, and the polling stops.
    let cancelled = false;
    let handle: ReturnType<typeof setTimeout>;
    const schedule = (delayMs: number) => {
      handle = setTimeout(() => {
        if (cancelled) return;
        const msUntil = nextAtMs - Date.now();
        if (msUntil > 0) {
          // Not yet expired. This can only happen on the first fire
          // (initial schedule) if the clock jumped, or if the tab was
          // backgrounded and the timer fired late. Reschedule to the
          // real expiry.
          schedule(msUntil + 300);
          return;
        }
        qc.invalidateQueries({ queryKey: refetchQueryKey });
        schedule(2_000);
      }, Math.max(0, delayMs));
    };
    schedule(Math.max(300, nextAtMs - Date.now() + 300));
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [nextAtMs, refetchQueryKey, qc]);
  if (nextAtMs == null) return <span>-</span>;
  const msUntil = nextAtMs - now;
  // Once the countdown crosses zero we're waiting on either the
  // server's next tick (which runs on the interval timer) or the
  // dashboard's next react-query poll. Either way "now" stuck on
  // screen for 30 seconds reads as broken; "refreshing…" is honest
  // about what's happening.
  if (msUntil <= 0) return <span><Trans>refreshing…</Trans></span>;
  return <span><Trans>refreshes in {formatCountdownPrecise(msUntil)}</Trans></span>;
}

function BidIdCell({ id }: { id: string }) {
  // Full ID on sm+ viewports; shortened head…tail with a copy button
  // on mobile. The raw ID is 18 chars and `break-all` wraps it one
  // char per line on narrow screens (#34). Keeping the full ID always
  // visible on desktop preserves the #26 behavior.
  const [copied, setCopied] = useState(false);
  const { i18n } = useLingui();
  void i18n;
  const copy = async () => {
    try {
      await copyToClipboard(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard fell back to execCommand and still failed; no-op */
    }
  };
  const shortId = id.length <= 10 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`;
  return (
    <>
      <span className="hidden sm:inline whitespace-nowrap">{id}</span>
      <span className="sm:hidden flex items-center gap-1.5">
        <span>{shortId}</span>
        <button
          onClick={copy}
          aria-label={copied ? t`copied bid ID` : t`copy bid ID`}
          title={copied ? t`copied bid ID` : t`copy bid ID`}
          className={
            'shrink-0 p-0.5 rounded border border-slate-700 hover:bg-slate-800 ' +
            (copied ? 'text-emerald-300' : 'text-slate-400')
          }
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </span>
    </>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * Pill-style status indicator used across Braiins / Datum / Ocean
 * panels to show reachability of the underlying external service.
 * Renders a coloured dot + label inside a bordered chip.
 */
function ReachabilityBadge({
  label,
  reachable,
  downLabel,
  title,
}: {
  label: string;
  reachable: boolean;
  /** Override for the text when !reachable (e.g. "DOWN (3 consecutive)"). */
  downLabel?: string;
  title?: string;
}) {
  const { i18n } = useLingui();
  void i18n;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs border ' +
        (reachable
          ? 'border-emerald-700 bg-emerald-900/30 text-emerald-300'
          : 'border-red-700 bg-red-900/30 text-red-300')
      }
      title={title}
    >
      <span
        className={
          'w-1.5 h-1.5 rounded-full ' + (reachable ? 'bg-emerald-400' : 'bg-red-400')
        }
      />
      {reachable ? label : (downLabel ?? t`${label} DOWN`)}
    </span>
  );
}

/**
 * Vertical money panel: cost on top, then the two income sources,
 * then net at the bottom. Reads naturally as a profit-and-loss page -
 * the two incomes obviously add up to "what we'll have", which is
 * then offset against "what we paid".
 *
 *   spent     - lifetime sat consumed across all autopilot-owned bids
 *   expected  - Ocean's "Unpaid Earnings" (pending next payout)
 *   collected - on-chain UTXOs at the configured payout address
 *   net       - collected + expected − spent (final result)
 *
 * Each input renders "-" when its source isn't reporting yet; net
 * stays "-" until both income halves have at least one observation.
 */
function BraiinsBalances({
  balances,
  actualSpendPerDaySat3h,
  locale,
  denomination,
}: {
  balances: readonly BalanceView[];
  /**
   * Actual sat/day spend over the last 3 h, from
   * `/api/status.actual_spend_per_day_sat_3h` (primary_bid_consumed_sat
   * deltas scaled to 24h). Null until the daemon has enough matched
   * data in the window. Drives the runway forecast; the old
   * bid × delivered model was lying under CLOB.
   */
  actualSpendPerDaySat3h: number | null;
  locale: string | undefined;
  denomination: ReturnType<typeof useDenomination>;
}) {
  const dailySpendSat = actualSpendPerDaySat3h ?? 0;
  const nowMs = Date.now();
  const { i18n } = useLingui();
  void i18n;
  // #X: dates render in the UI language, not the operator's number-
  // format preference. Picking nl-NL for "1.234,56" should not flip
  // month abbreviations to Dutch when the UI is in English.
  const dateLocale = useDateTimeLocale();
  if (balances.length === 0) {
    // Braiins API down (or no creds configured): keep the four-row
    // structure visible with em-dash values so the operator
    // recognises the section instead of seeing a single bare dash
    // and assuming the feature was removed. The "API DOWN" pill at
    // the top of the card already names the cause.
    return (
      <div>
        <Row k={t`available`} v={'\u2014'} />
        <Row k={t`blocked`} v={'\u2014'} />
        <Row k={t`total`} v={'\u2014'} />
        <Row k={t`runway`} v={'\u2014'} />
      </div>
    );
  }
  return (
    <>
      {balances.map((b) => {
        const runwayDays =
          dailySpendSat > 0 && b.total_balance_sat > 0
            ? b.total_balance_sat / dailySpendSat
            : null;
        const runwayText = (() => {
          if (runwayDays === null) return '\u2014';
          const exhaustAt = new Date(nowMs + runwayDays * 86_400_000);
          const dateLabel = exhaustAt.toLocaleDateString(dateLocale, {
            month: 'short',
            day: 'numeric',
          });
          const daysCount = runwayDays >= 10
            ? formatNumber(Math.round(runwayDays), {}, locale)
            : formatNumber(runwayDays, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, locale);
          return t`${daysCount} days \u00b7 ~${dateLabel}`;
        })();
        return (
          <div key={b.subaccount}>
            <Row k={t`available`} v={denomination.formatSat(b.available_balance_sat, locale)} />
            <Row k={t`blocked`} v={denomination.formatSat(b.blocked_balance_sat, locale)} />
            <Row k={t`total`} v={denomination.formatSat(b.total_balance_sat, locale)} />
            <Row k={t`runway`} v={runwayText} />
          </div>
        );
      })}
    </>
  );
}

/**
 * Render the panel's "pool blocks Nh" row from the daemon-side luck
 * value (computed in services/pool-luck.ts and surfaced via the
 * /api/ocean route). Same number the chart's right-axis pool-luck
 * series plots, so panel and chart agree at the moment of every
 * find.
 */
function renderPoolBlocksRow(
  count: number,
  luck: number | null,
  locale: string | undefined,
): string {
  if (luck === null) return String(count);
  const luckStr = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(luck);
  // Wording: "× expected" rather than "× lucky/unlucky". The
  // multiplier compares observed-rate to the Poisson-derived
  // expected-rate; the words "lucky/unlucky" added a misleading
  // double-negative below 1.0× ("0.99× unlucky" parses as a double
  // negation). The number is the verdict; tooltip explains the math.
  return `${count} (${luckStr}× ${t`expected`})`;
}

function OceanPanel() {
  const { intlLocale } = useLocale();
  const dateTimeLocale = useDateTimeLocale();
  const denomination = useDenomination();
  const { i18n } = useLingui();
  void i18n;

  // React-query dedupes by queryKey, so this shares the in-flight
  // fetch + cached response with the parent's own `['ocean']` query
  // (used for the hashrate-chart block markers).
  const oceanQuery = useQuery({
    queryKey: ['ocean'],
    queryFn: api.ocean,
    refetchInterval: 60_000,
  });
  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
  });
  const explorerTemplate =
    configQuery.data?.config?.block_explorer_url_template ??
    'https://mempool.space/block/{hash}';

  const o = oceanQuery.data;

  if (!o || !o.configured) {
    return (
      <Card title="Ocean">
        <div className="text-slate-500 text-sm"><Trans>Not configured</Trans></div>
      </Card>
    );
  }

  // Ocean refreshes every minute client-side (and server caches for
  // the same). Countdown = last fetch + 1 min; reachable whenever
  // the last response carried data.
  const nextOceanRefreshMs =
    o.fetched_at_ms !== null ? o.fetched_at_ms + 60_000 : null;

  return (
    <Card
      title="Ocean"
      nextRefreshAtMs={nextOceanRefreshMs}
      badges={
        <ReachabilityBadge
          label={t`API reachable`}
          reachable={o.fetched_at_ms !== null && o.pool !== null}
          downLabel={t`API DOWN`}
          title={t`Ocean stats API - reachable when the last /api/ocean fetch returned a pool snapshot.`}
        />
      }
    >
      {/* Current observations - same genre as Datum's "datum hashrate"
          or Braiins' "delivered": what the pool reports about our
          wallet right now. */}
      {o.user && (
        <>
          <Row
            k={t`ocean hashrate`}
            v={denomination.formatHashrate(o.user.hashrate_5m_ph, intlLocale)}
            tooltip={t`Hashrate Ocean credits to our payout address (5-min sliding window). Sourced per-tick from /v1/user_hashrate.hashrate_300s. Compare against AVG BRAIINS / AVG DATUM at the top of the page; sustained gaps mean shares are getting lost somewhere in the Braiins → Datum → Ocean pipeline.`}
          />
          {o.user.hashprice_sat_per_ph_day != null && (
            <Row
              k={t`hashprice (break-even)`}
              v={denomination.formatSatPerPhDay(o.user.hashprice_sat_per_ph_day, intlLocale)}
              tooltip={t`Network's break-even rate at current difficulty + block reward: (block_reward_sat * 144 blocks/day) / network_hashrate. If you're paying ABOVE this for hashrate you're losing money vs mining; below this you're winning. The autopilot's max-overpay-vs-hashprice cap clamps your bid relative to this number.`}
            />
          )}
        </>
      )}

      {/* Our accrued / projected earnings. */}
      {o.user && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          <Row
            k={t`share log`}
            v={
              o.user.share_log_pct !== null
                ? `${formatNumber(o.user.share_log_pct, { minimumFractionDigits: 4, maximumFractionDigits: 4 }, intlLocale)}%`
                : '\u2014'
            }
            tooltip={t`Our slice of Ocean's TIDES window. Ocean's payout system rewards us proportionally to this fraction every block the pool finds. As Ocean's total hashrate grows or our delivered PH/s shrinks, this drifts down; as we deliver more or pool shrinks, it drifts up.`}
          />
          <Row
            k={t`unpaid`}
            v={denomination.formatSat(o.user.unpaid_sat, intlLocale)}
            tooltip={t`Sats accrued to our wallet on Ocean since the last on-chain payout. Climbs continuously between payouts; drops to zero when a payout is sent (Ocean pays out when this passes the threshold, ~0.01 BTC by default).`}
          />
          <Row
            k={t`next block est.`}
            v={denomination.formatSat(o.user.next_block_sat, intlLocale)}
            tooltip={t`How many sats we'd earn from the next block Ocean finds, assuming current share_log holds. Equals (next_block_reward * share_log_pct / 100). Sanity-check vs a typical Ocean block reward (~3.13 BTC).`}
          />
          <Row
            k={t`income/day est.`}
            v={denomination.formatSat(o.user.daily_estimate_sat, intlLocale)}
            tooltip={t`Ocean's own 'daily_estimate' for our address - what they expect to credit us per day at our 3h hashrate. Derived from user_hashrate * hashprice. Always 3h-based regardless of the chart range above.`}
          />
          {o.user.time_to_payout_text && (
            <Row
              k={t`next payout`}
              v={formatNextPayout(o.user.time_to_payout_text, dateTimeLocale)}
              tooltip={
                // State-aware: when the daemon emits the literal
                // 'Next block' string the balance is already past
                // threshold and the wording flips to explain that it's
                // Ocean's projection - settlement is a batched sweep tx,
                // not a coinbase of an Ocean-mined block.
                o.user.time_to_payout_text === 'Next block'
                  ? t`Our unpaid balance (${denomination.formatSat(
                      o.user.unpaid_sat,
                      intlLocale,
                    )}) has already crossed the payout threshold (${denomination.formatSat(
                      o.user.payout_threshold_sat,
                      intlLocale,
                    )} ≈ 0,01 BTC), so Ocean has queued us for payout. "Next block" is Ocean's own projection, not a literal trigger: Ocean settles operator payouts as a batched payment transaction from its pool wallet, broadcast on its own cadence and mined into whatever block by whatever pool - it is NOT a coinbase output and NOT necessarily an Ocean-mined block. When it confirms, a payout marker appears on the price chart.`
                  : t`Projected time until our unpaid balance (${denomination.formatSat(
                      o.user.unpaid_sat,
                      intlLocale,
                    )}) crosses the payout threshold (${denomination.formatSat(
                      o.user.payout_threshold_sat,
                      intlLocale,
                    )} ≈ 0,01 BTC), at the current ${denomination.formatSat(
                      o.user.daily_estimate_sat,
                      intlLocale,
                    )}/day earn rate. Once crossed, the actual payout lands on the next pool block Ocean wins (not on a fixed schedule). Updates as our hashrate moves, the pool's block-find luck shifts, and the unpaid balance keeps climbing.`
              }
            />
          )}
        </div>
      )}

      {/* Pool-wide context - less important day-to-day, so it lives
          at the bottom of the panel. */}
      <div className="border-t border-slate-800 mt-2 pt-2">
        {o.last_block ? (
          <>
            <LinkRow
              k={t`last pool block`}
              v={`#${o.last_block.height.toLocaleString(intlLocale)}`}
              href={applyExplorerTemplate(explorerTemplate, {
                block_hash: o.last_block.block_hash,
                height: o.last_block.height,
              })}
            />
            <Row
              k={t`found`}
              v={o.last_block.ago_text}
              tooltip={t`Time since Ocean found its most recent block. Ocean's average block-find interval is the inverse of its share of network: at ~5% network share, ~5-6 hours between blocks on average. A 24h gap is unusual but well within Poisson variance; multi-day droughts suggest something structural.`}
            />
            {(() => {
              const blockShareLog =
                o.our_recent_blocks[0]?.share_log_pct_at_block ?? null;
              const liveShareLog = o.user?.share_log_pct ?? null;
              const effective =
                blockShareLog !== null && blockShareLog > 0
                  ? blockShareLog
                  : liveShareLog;
              return (
                <Row
                  k={t`our earnings (est.)`}
                  v={
                    effective !== null
                      ? denomination.formatSat(
                          Math.round(
                            (o.last_block.total_reward_sat * effective) / 100,
                          ),
                          intlLocale,
                        )
                      : '\u2014'
                  }
                  tooltip={t`What this last block earned us, estimated as block_reward * share_log_pct / 100. Uses the share_log recorded at the block's moment when our tick history covers it; falls back to the live share_log for older blocks.`}
                />
              );
            })()}
          </>
        ) : (
          <Row k={t`last pool block`} v={'\u2014'} />
        )}
        {(() => {
          // Live pool share derived from current Ocean stats. The
          // tooltip used to hardcode "~5%" which drifted out of date
          // (Ocean was ~1.7% per mempool.space at the time the
          // operator caught it). Now computed per render so the
          // tooltip reflects whatever Ocean's share is right now.
          const pool = o.pool;
          const sharePct =
            pool?.pool_hashrate_ph && pool.network_difficulty && pool.network_difficulty > 0
              ? (pool.pool_hashrate_ph * 1e15 * 600) /
                (pool.network_difficulty * 2 ** 32) /
                0.01
              : null;
          const fmt = (n: number, digits: number): string =>
            new Intl.NumberFormat(intlLocale, {
              minimumFractionDigits: digits,
              maximumFractionDigits: digits,
            }).format(n);
          const shareStr = sharePct !== null ? `${fmt(sharePct, 2)}%` : null;
          const expected24h = sharePct !== null ? sharePct * 144 / 100 : null;
          const expected7d = sharePct !== null ? sharePct * 144 * 7 / 100 : null;
          const tooltip24h =
            shareStr && expected24h !== null
              ? t`Blocks Ocean found in the last 24h. The "X.XX\u00d7 expected" multiplier is the observed rate divided by the Poisson-derived expected rate: Ocean's current share of network hashrate is ${shareStr}, so the expectation over 24h (~144 blocks on the network) is ~${fmt(expected24h, 2)} blocks. The denominator extends with elapsed-since-last-block so the value decays continuously between finds; at the moment of each find it equals exactly count / expected_for_window. >1.00\u00d7 means we found more than expected, <1.00\u00d7 means fewer. Same number the chart's right-axis pool-luck line plots. Wide variance is normal at 24h - Poisson \u03c3 is large at this window.`
              : t`Blocks Ocean found in the last 24h. The "X.XX\u00d7 expected" multiplier compares observed vs Poisson-expected. Pool hashrate / network difficulty unavailable right now; tooltip will show live share % once Ocean stats are reachable again.`;
          const tooltip7d =
            shareStr && expected7d !== null
              ? t`Blocks Ocean found in the last 7d. Same observed-vs-Poisson-expected ratio as the 24h row, with the window extended: at Ocean's current share of ${shareStr}, the 7d expectation is ~${fmt(expected7d, 1)} blocks. 7d smooths the short-term Poisson variance: a sustained <0.70\u00d7 over a week suggests something structural (lower hashrate share than the estimator implies, or a real upstream issue at Ocean).`
              : t`Blocks Ocean found in the last 7d, same observed-vs-Poisson-expected ratio as the 24h row. Pool hashrate / network difficulty unavailable right now; tooltip will show live numbers once Ocean stats are reachable again.`;
          const expected30d = sharePct !== null ? sharePct * 144 * 30 / 100 : null;
          const tooltip30d =
            shareStr && expected30d !== null
              ? t`Blocks Ocean found in the last 30d. At Ocean's current share of ${shareStr}, the 30d expectation is ~${fmt(expected30d, 0)} blocks. 30d smooths almost all Poisson variance - a sustained deviation here points to a real share change.`
              : t`Blocks Ocean found in the last 30d. Pool hashrate / network difficulty unavailable right now.`;
          const tooltipAllTime = t`Total blocks Ocean has found since the daemon started tracking. The luck multiplier covers the entire window from the first tracked block to now.`;
          return (
            <>
              <Row
                k={t`pool blocks 24h`}
                v={renderPoolBlocksRow(o.blocks_24h, o.pool_luck_24h, intlLocale)}
                tooltip={tooltip24h}
              />
              <Row
                k={t`pool blocks 7d`}
                v={renderPoolBlocksRow(o.blocks_7d, o.pool_luck_7d, intlLocale)}
                tooltip={tooltip7d}
              />
              <Row
                k={t`pool blocks 30d`}
                v={renderPoolBlocksRow(o.blocks_30d, o.pool_luck_30d, intlLocale)}
                tooltip={tooltip30d}
              />
              <Row
                k={t`pool blocks since start`}
                v={renderPoolBlocksRow(o.blocks_all_time, o.pool_luck_all_time, intlLocale)}
                tooltip={tooltipAllTime}
              />
            </>
          );
        })()}
      </div>
      {o.pool && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          {o.pool.active_users !== null && (
            <Row
              k={t`pool users`}
              v={o.pool.active_users.toLocaleString(intlLocale)}
              tooltip={t`Distinct payout addresses currently mining on Ocean.`}
            />
          )}
          {o.pool.active_workers !== null && (
            <Row
              k={t`pool workers`}
              v={o.pool.active_workers.toLocaleString(intlLocale)}
              tooltip={t`Total worker connections on Ocean (one address can have many workers).`}
            />
          )}
        </div>
      )}
    </Card>
  );
}

function FinancePanel({
  data,
  rangeData,
  status,
  chartRange,
  onRefresh,
  refreshing,
}: {
  data: FinanceResponse | undefined;
  rangeData: FinanceRangeResponse | undefined;
  status: StatusResponse;
  chartRange: ChartRange;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const qc = useQueryClient();
  const [rebuilding, setRebuilding] = useState(false);
  const { i18n } = useLingui();
  void i18n;

  const handleRebuild = async () => {
    if (rebuilding) return;
    if (!window.confirm(t`Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh? This is safe but slower than a normal refresh.`)) {
      return;
    }
    setRebuilding(true);
    try {
      await api.rebuildSpendCache();
      qc.invalidateQueries({ queryKey: ['finance'] });
    } finally {
      setRebuilding(false);
    }
  };

  // Per-day run-rate view (issue #43). Prefers the range-aware
  // aggregates from /api/finance/range (avg_price × avg_delivered and
  // avg_hashprice × avg_delivered over the selected chart range);
  // falls back to the instantaneous formula when the server doesn't
  // have enough ticks yet (fresh install, post-prune, daemon just
  // started). The "Ocean est." row is always the 3h snapshot from
  // Ocean's `daily_estimate_sat` regardless of range - it's
  // authoritative for the pool-view estimate.
  //
  // Computed BEFORE the `!data` early return so hook count is stable
  // across the null → defined transition of `data` (React error #310).
  const {
    dailySpendSat,
    hasDailySpend,
    oceanDailyIncomeSat,
    projectedDailyIncomeSat,
    dailyNetSat,
    dailyNetColor,
    rangeFallback,
  } = useMemo(() => {
    const hasActive = status.bids.some(
      (b) => b.is_owned && b.status === 'BID_STATUS_ACTIVE',
    );

    // Range-aware path: derived fields are null when the server
    // returns `insufficient_history`. Fall back to the 3h actual
    // spend rate carried on /api/status - which also derives from
    // primary_bid_consumed_sat deltas, just over a fixed 3h window
    // instead of the selected range.
    const haveRange =
      rangeData !== undefined &&
      !rangeData.insufficient_history &&
      rangeData.actual_spend_per_day_sat !== null;

    const spend = haveRange
      ? rangeData!.actual_spend_per_day_sat!
      : status.actual_spend_per_day_sat_3h ?? 0;
    const projectedIncome = haveRange
      ? rangeData!.projected_income_per_day_sat
      : null;
    const oceanIncome = data?.ocean?.daily_estimate_sat ?? null;
    // Net keyed off projected income (range-symmetric with spend)
    // when available; otherwise Ocean income to keep the old
    // behaviour on fresh installs where range can't be computed.
    const referenceIncome = projectedIncome ?? oceanIncome;
    const net =
      referenceIncome !== null ? Math.round(referenceIncome - spend) : null;

    return {
      dailySpendSat: spend,
      hasDailySpend: hasActive,
      oceanDailyIncomeSat: oceanIncome,
      projectedDailyIncomeSat: projectedIncome,
      dailyNetSat: net,
      dailyNetColor:
        net === null ? '' : net >= 0 ? 'text-emerald-300' : 'text-red-300',
      rangeFallback: !haveRange,
    };
  }, [
    status.bids,
    status.actual_spend_per_day_sat_3h,
    data?.ocean?.daily_estimate_sat,
    rangeData,
  ]);

  if (!data) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-lg p-4">
        <div className="text-xs uppercase tracking-wider text-slate-100 mb-2"><Trans>Profit &amp; Loss</Trans></div>
        <div className="text-slate-500 text-sm"><Trans>loading…</Trans></div>
      </section>
    );
  }

  const netColor =
    data.net_sat === null
      ? 'text-slate-400'
      : data.net_sat >= 0
        ? 'text-emerald-300'
        : 'text-red-300';

  const hasPerDay =
    oceanDailyIncomeSat !== null ||
    projectedDailyIncomeSat !== null ||
    hasDailySpend ||
    dailyNetSat !== null ||
    data.ocean?.hashprice_sat_per_ph_day != null ||
    data.ocean?.lifetime_sat != null ||
    !!data.ocean?.time_to_payout_text;

  // Range label shown next to the headline numbers so the operator
  // can glance-check what window the avg is over. Matches the chart
  // range dropdown labels from CHART_RANGE_SPECS.
  const rangeLabel = localizedRangeLabel(chartRange, i18n.locale);

  // P&L now refreshes every 60s (matches the rest of the dashboard).
  // Dashboard countdown is derived from checked_at_ms + 60s so the
  // operator sees how long until fresh numbers without guessing the
  // cadence. Earlier 1h cadence was too coarse - block-find events
  // that bump `unpaid earnings (Ocean)` by ~38k sats took up to an
  // hour to land in the panel even though /api/ocean had the new
  // number within seconds.
  const nextRefreshAtMs = data.checked_at_ms + 60_000;

  const headerControls = (
    <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono">
      <RefreshCountdown nextAtMs={nextRefreshAtMs} />
      <button
        onClick={onRefresh}
        disabled={refreshing}
        className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
        title={t`Refresh the money panel now (auto-refreshes every 60s).`}
      >
        {refreshing ? '…' : '↻'}
      </button>
      {data.spent_scope === 'account' && (
        <button
          onClick={handleRebuild}
          disabled={rebuilding}
          className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-400 hover:bg-slate-800 disabled:opacity-50"
          title={t`Wipe the local terminal-bid cache and re-paginate every bid from Braiins on the next refresh. Use if the 'spent (whole account)' figure looks wrong.`}
        >
          {rebuilding ? '…' : <Trans>rebuild</Trans>}
        </button>
      )}
    </div>
  );

  // Two separate cards: per-day run-rate and lifetime totals. Same
  // data source, but visually distinct so the operator reads them as
  // two different questions - "am I burning money per day right now?"
  // vs "did I end up ahead over the whole run?".
  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {/* Left card - per-day run-rate */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Profit &amp; Loss · per day</Trans>
          </div>
          {headerControls}
        </div>
        {hasPerDay ? (
          // Per-day values are all projections / estimates (Ocean's
          // 3h-hashrate extrapolation for income, live bid price ×
          // delivered for spend). Label them "projected" so the
          // operator reads them as forecasts rather than facts. The
          // exceptions - hashprice (current market break-even) and
          // ocean lifetime (actual earnings) - keep their existing
          // plain labels.
          //
          // Rows always render once we're past the initial loading
          // gate - hiding them on transient nulls (Ocean hasn't
          // reported yet, bid stopped filling this tick, etc.) made
          // the panel look broken whenever one piece was missing.
          // "calculating…" makes the loading state explicit instead
          // of a silent empty panel.
          <div className="space-y-1.5 text-sm font-mono">
            {/* Inputs - the averages that the projections below
                multiply. Surfaced explicitly so projected income /
                spend / net read as derivations, not magic numbers.
                Hidden when rangeFallback is active because the
                fallback path uses current bid × 3h hashrate instead,
                not the range averages. */}
            {!rangeFallback && rangeData && (
              <>
                <FinanceFootnote
                  label={t`avg delivered (${rangeLabel})`}
                  value={
                    rangeData.avg_delivered_ph !== null
                      ? denomination.formatHashrate(rangeData.avg_delivered_ph, intlLocale)
                      : t`calculating…`
                  }
                  tooltip={t`Average delivered hashrate over the selected chart range. Multiplied by avg hashprice to get projected income. Spend is measured directly (primary_bid_consumed_sat deltas), so this is not a factor on the spend side.`}
                />
                <FinanceFootnote
                  label={t`avg hashprice (${rangeLabel})`}
                  value={
                    rangeData.avg_hashprice_sat_per_ph_day !== null
                      ? denomination.formatSatPerPhDay(
                          rangeData.avg_hashprice_sat_per_ph_day,
                          intlLocale,
                        )
                      : t`calculating…`
                  }
                  tooltip={t`Average break-even unit price over the selected range. Multiplied by avg delivered to get projected income. Different from the spot hashprice row below - this is what the projection actually uses.`}
                />
              </>
            )}
            {/* Derivations - built from the three averages above. */}
            <div
              className={
                !rangeFallback && rangeData
                  ? 'pt-2 mt-2 border-t border-slate-800 space-y-1.5'
                  : 'space-y-1.5'
              }
            >
            <FinanceFootnote
              label={t`projected income/day (${rangeLabel})`}
              value={
                projectedDailyIncomeSat !== null
                  ? denomination.formatSat(Math.round(projectedDailyIncomeSat), intlLocale)
                  : rangeFallback
                    ? t`insufficient history`
                    : t`calculating…`
              }
              tooltip={t`Projection: avg hashprice × avg delivered (rows above), both averaged over the selected chart range. Range-aware counterpart to Ocean's own 3h estimate.`}
            />
            <FinanceFootnote
              label={rangeFallback ? t`spend/day (${localizedRangeLabel('3h', i18n.locale)})` : t`spend/day (${rangeLabel})`}
              value={denomination.formatSat(Math.round(dailySpendSat), intlLocale)}
              tooltip={
                rangeFallback
                  ? t`Actual sat consumed over the last 3 h, scaled to a 24h rate. Uses Braiins\u2019s authoritative primary_bid_consumed_sat counter, not a bid \u00d7 delivered model. Fallback used when the selected range has fewer than ~5 ticks.`
                  : t`Actual sat consumed across the selected range, scaled to a 24h rate. Derived from primary_bid_consumed_sat deltas (what Braiins charged us), not a modelled bid \u00d7 delivered.`
              }
            />
            <FinanceFootnote
              label={rangeFallback ? t`net/day (${localizedRangeLabel('3h', i18n.locale)})` : t`net/day (${rangeLabel})`}
              value={
                dailyNetSat !== null
                  ? denomination.mode === 'usd' && denomination.btcPrice !== null
                    ? `${dailyNetSat >= 0 ? '+' : ''}${denomination.formatSat(dailyNetSat, intlLocale)}`
                    : `${dailyNetSat >= 0 ? '+' : ''}${formatNumber(dailyNetSat, {}, intlLocale)} sat`
                  : t`calculating\u2026`
              }
              tooltip={t`Projected income \u2212 actual spend (rows above). Positive = the autopilot is profitable at current rates; negative = burning money per day. Income is a projection (avg hashprice \u00d7 avg delivered); spend is measured. Don\u2019t confuse with the lifetime net on the other panel.`}
              valueClass={dailyNetColor}
            />
            </div>
            {/* Reference rows - alternate views (pool-side estimate,
                spot hashprice, lifetime) that the projection doesn't
                derive from. */}
            <div className="pt-2 mt-2 border-t border-slate-800 space-y-1.5">
              <FinanceFootnote
                label={t`ocean est. income/day (${localizedRangeLabel('3h', i18n.locale)})`}
                value={
                  oceanDailyIncomeSat !== null
                    ? denomination.formatSat(oceanDailyIncomeSat, intlLocale)
                    : t`calculating…`
                }
                tooltip={t`Ocean's own estimate - the pool extrapolates from the address's last 3-hour hashrate and its share of pool output. Always 3h-based regardless of the chart range you've picked, so it may differ from projected income at other ranges.`}
              />
              {data.ocean?.hashprice_sat_per_ph_day != null && (
                <FinanceFootnote
                  label={t`hashprice (now)`}
                  value={denomination.formatSatPerPhDay(data.ocean.hashprice_sat_per_ph_day, intlLocale)}
                  tooltip={t`Current (spot) market break-even. Revenue per PH/s per day from mining at the current network difficulty + block reward. The avg-hashprice row above is what the projection uses; this one is the spot value right now for quick market-drift comparison.`}
                />
              )}
              {data.ocean?.lifetime_sat != null && (
                <FinanceFootnote
                  label={t`ocean lifetime`}
                  value={denomination.formatSat(data.ocean.lifetime_sat, intlLocale)}
                  tooltip={t`Total earned at this address since first share, per Ocean.`}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-600"><Trans>no active bids</Trans></div>
        )}
      </div>

      {/* Right card - lifetime totals (the actual P&L ledger) */}
      <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col">
        <div className="flex items-baseline justify-between mb-3">
          <div className="text-xs uppercase tracking-wider text-slate-100">
            <Trans>Profit &amp; Loss · lifetime</Trans>
          </div>
          {/* refresh/rebuild controls live on the per-day card only -
              they refresh the same data, no point duplicating them */}
        </div>
        {/* The panel reads as the arithmetic of the net line: an
            explicit leading sign tells the operator which side of the
            ledger each row sits on. Spent is the only subtraction;
            Ocean + on-chain are the additions; the bottom line is the
            sum. */}
        <FinanceRow
          sign="minus"
          label={data.spent_scope === 'account' ? t`spent (whole account)` : t`spent (autopilot)`}
          value={data.spent_sat}
          tooltip={
            data.spent_scope === 'account'
              ? t`Sum of counters_committed.amount_consumed_sat across every bid on /v1/spot/bid - covers active + historical bids, including any that existed before the autopilot was switched on. May lag the latest hour of active-bid consumption (Braiins only updates committed counters on each hourly settlement tick). Switch via Config → P&L panel.`
              : t`Lifetime sum of (amount_sat − amount_remaining_sat) across every bid the autopilot has tagged. Excludes any bids placed before the autopilot was switched on. Switch to "whole account" via Config → Money panel.`
          }
        />
        {data.spent_scope === 'account' &&
          data.spent_closed_sat !== null &&
          data.spent_active_sat !== null && (
            <>
              <FinanceSubRow
                label={t`closed bids`}
                value={data.spent_closed_sat}
                tooltip={t`Sum across terminal bids - status CANCELED or FULFILLED (is_current=false). Money that has definitively left the account.`}
              />
              <FinanceSubRow
                label={t`active (in-flight)`}
                value={data.spent_active_sat}
                tooltip={t`Sum across still-running bids - status ACTIVE / PAUSED / etc. (is_current=true). Live in-flight consumption; not yet settled in Braiins' hourly ledger.`}
              />
            </>
          )}
        <FinanceRow
          sign="plus"
          label={t`unpaid earnings (Ocean)`}
          value={data.expected_sat}
          tooltip={
            data.ocean
              ? t`Ocean's Unpaid Earnings - what will land on-chain at the next payout. Threshold: ${formatSats(data.ocean.payout_threshold_sat)} sat (~0.01 BTC).`
              : t`Ocean stats unavailable.`
          }
        />
        <FinanceRow
          sign="plus"
          label={t`collected (on-chain)`}
          value={data.collected_sat}
          status={data.collected_status}
          tooltip={
            data.collected_status === 'computing'
              ? t`Payout observer is starting up. Waiting for the first balance scan to complete - usually a few seconds with an Electrum server, up to a minute with bitcoind scantxoutset.`
              : data.collected_sat !== null
                ? t`UTXOs at the configured payout address. Read via your Electrum server (preferred, instant) or bitcoind RPC (slower).`
                : t`Not configured. Go to Config → On-chain payouts and select Electrum server or Bitcoin Knots RPC to track your on-chain balance. The net line treats missing collected as 0 so the arithmetic still reads - a blank row here is the hint that a piece of the income side isn't wired up.`
          }
        />
        {/* #170 follow-up: operator-entered pre-installation /
            off-chain earnings. Hidden when the field is 0 (default)
            so the panel stays uncluttered for the common case. */}
        {data.historical_offset_sat > 0 && (
          <FinanceRow
            sign="plus"
            label={t`pre-installation (manual)`}
            value={data.historical_offset_sat}
            tooltip={t`Operator-entered offset for earnings the on-chain payout observer can't see - Lightning payouts, pre-autopilot Ocean history that's already been swept, etc. Set under Config → Pool & Payout → On-chain payouts.`}
          />
        )}

        <div className="mt-3 pt-3 border-t border-slate-800">
          <FinanceRow
            sign="equals"
            label={t`net`}
            value={data.net_sat}
            // Only the bottom-line gets a sentiment color - green when
            // the autopilot has paid for itself, red when it's still
            // digging out of the initial deposit. Keeps the rest of
            // the panel calm so the eye lands on the conclusion.
            valueClass={netColor}
            tooltip={t`Collected on-chain + pre-installation (manual) + Ocean's unpaid earnings − spent on bids. Missing collected is treated as 0 (the on-chain row still shows - so the operator sees the gap). Negative = still recouping the initial deposit.`}
          />
          {/* #249: rate of return on its own row so the sat column
              stays right-aligned across all four lines above. Same
              green/red sentiment as `= net` since it's the same
              quantity expressed as a ratio. Empty sign slot keeps the
              label aligned under "net". splitUnit pulls the `%` into
              its own muted span so the percent symbol gets the same
              recede-into-the-background treatment as the sat symbol
              on the rows above. */}
          {data.net_sat !== null && data.spent_sat > 0 && (() => {
            const pct = (data.net_sat / data.spent_sat) * 100;
            const signStr = pct >= 0 ? '+' : '';
            const pctStr = `${signStr}${formatNumber(
              pct,
              { minimumFractionDigits: 1, maximumFractionDigits: 1 },
              intlLocale,
            )}%`;
            const split = splitUnit(pctStr);
            return (
              <Tooltip
                text={t`Net divided by spent, expressed as a percentage. −100% means we've spent everything with nothing to show, 0% means we've broken even, and positive means we've earned more than we paid for hashrate.`}
              >
                <div className="cursor-help flex items-baseline text-xs py-0.5 gap-2 text-slate-500">
                  <span className="font-mono tabular-nums w-3" aria-hidden="true" />
                  <span className="flex-1">{t`return on spend`}</span>
                  <span className={`font-mono ${netColor}`}>
                    {split ? (
                      <>
                        {split.num}
                        <span className="text-slate-500 text-[11px] ml-1">
                          <SatUnit unit={split.unit} />
                        </span>
                      </>
                    ) : (
                      pctStr
                    )}
                  </span>
                </div>
              </Tooltip>
            );
          })()}
        </div>
      </div>
    </section>
  );
}

/**
 * One row in the vertical money stack: label on the left, value on
 * the right (right-aligned, monospace, tabular-nums so the digits
 * line up across rows). `value=null` renders as "-".
 */
function FinanceRow({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-100',
  sign,
  status,
}: {
  label: string;
  value: number | null;
  tooltip: string;
  valueClass?: string;
  /** Leading arithmetic sign. Turns the panel into a readable sum
   *  rather than a dictionary of unrelated figures. */
  sign?: 'plus' | 'minus' | 'equals';
  /**
   * #97 - when 'computing', renders a small inline spinner instead of
   * the standard em-dash so the operator does not mistake "first scan
   * still in flight after a daemon restart" for "this integration is
   * broken". Only the collected (on-chain) row currently passes this.
   */
  status?: 'computing' | 'ready' | 'idle';
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  // Match the size + label-color of the standard <Row> used by the
  // sibling Hashrate-and-market and Braiins-balance cards so the three
  // panels read as a set. Only the value's *color* varies (caller can
  // override via valueClass - used for the green/red net bottom line).
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  const signChar = sign === 'plus' ? '+' : sign === 'minus' ? '−' : sign === 'equals' ? '=' : '';
  const signColor =
    sign === 'plus'
      ? 'text-emerald-400'
      : sign === 'minus'
        ? 'text-red-400'
        : 'text-slate-500';
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-sm py-0.5 gap-2">
        {sign && (
          <span
            className={`font-mono tabular-nums w-3 text-center ${signColor}`}
            aria-hidden="true"
          >
            {signChar}
          </span>
        )}
        <span className="text-slate-400 flex-1">{label}</span>
        <span className={`font-mono ${valueClass}`}>
          {value === null ? (
            status === 'computing' ? (
              <span
                className="inline-block w-3 h-3 align-middle rounded-full border-2 border-slate-600 border-t-slate-300 animate-spin"
                aria-label={t`computing\u2026`}
                role="status"
              />
            ) : (
              '\u2014'
            )
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Indented sub-line under a main FinanceRow. Used to break "spent
 * (whole account)" into its closed vs active halves without competing
 * for visual weight with the top-level additions and subtraction.
 * No arithmetic sign - it's a breakdown, not another operand.
 */
function FinanceSubRow({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: number | null;
  tooltip: string;
}) {
  const { intlLocale } = useLocale();
  const denomination = useDenomination();
  const formatted = denomination.formatSat(value, intlLocale);
  const split = splitUnit(formatted);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline text-[11px] py-0 pl-7 gap-2 text-slate-500">
        <span className="flex-1">{label}</span>
        <span className="font-mono">
          {value === null ? (
            '\u2014'
          ) : split ? (
            <>
              {split.num}
              <span className="text-slate-600 text-[10px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            formatted
          )}
        </span>
      </div>
    </Tooltip>
  );
}

function FinanceFootnote({
  label,
  value,
  tooltip,
  valueClass = 'text-slate-300',
}: {
  label: string;
  value: string;
  tooltip: string;
  valueClass?: string;
}) {
  const split = splitUnit(value);
  return (
    <Tooltip text={tooltip}>
      <div className="cursor-help flex items-baseline justify-between gap-2">
        <span>{label}</span>
        <span className={`text-right ${valueClass}`}>
          {split ? (
            <>
              {split.num}
              <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
            </>
          ) : (
            value
          )}
        </span>
      </div>
    </Tooltip>
  );
}

/**
 * Turn Ocean's "Estimated Time Until Minimum Payout" string ("11 days",
 * "5 hours", "Below threshold", etc.) into a footnote value that
 * includes both the raw text and a concrete date - easier to plan
 * around than counting days mentally.
 *
 * Falls back to the raw text if it can't be parsed (e.g. "Below
 * threshold" when the rate is so low Ocean refuses to estimate, or
 * any future format we haven't seen yet).
 */
function formatNextPayout(raw: string, intlLocale: string | undefined): string {
  const ms = parseDurationMs(raw);
  if (ms === null || ms <= 0) return localizeDurationRaw(raw);
  const eta = new Date(Date.now() + ms);
  const date = new Intl.DateTimeFormat(intlLocale, {
    day: '2-digit',
    month: 'short',
  }).format(eta);
  return `${localizeDurationRaw(raw)} · ~${date}`;
}

// Ocean's API hands us short English duration strings like "11 days",
// "5 hours", "30 minutes". Translate each unit while preserving the
// number; preserves any unrecognised raw form unchanged so a future
// API surprise doesn't render blank.
function localizeDurationRaw(raw: string): string {
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return raw;
  const n = Number.parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const plural = n !== 1;
  switch (unit) {
    case 'minute':
      return plural ? t`${n} minutes` : t`${n} minute`;
    case 'hour':
      return plural ? t`${n} hours` : t`${n} hour`;
    case 'day':
      return plural ? t`${n} days` : t`${n} day`;
    case 'week':
      return plural ? t`${n} weeks` : t`${n} week`;
    case 'month':
      return plural ? t`${n} months` : t`${n} month`;
  }
  return raw;
}

const DURATION_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

function parseDurationMs(raw: string): number | null {
  // Ocean uses friendly units: "11 days", "5 hours", "30 minutes",
  // "2 weeks". Single + plural; case-insensitive on the unit.
  const m = raw.match(/^\s*(\d+)\s+(minute|hour|day|week|month)s?\s*$/i);
  if (!m || !m[1] || !m[2]) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n)) return null;
  const u = DURATION_UNIT_MS[m[2].toLowerCase()];
  return u ? n * u : null;
}

function DatumPanel({
  url,
  reachable,
  consecutiveFailures,
  poolError,
  poolLatencyMs,
  datum,
  nextTickAt,
}: {
  url: string;
  reachable: boolean;
  consecutiveFailures: number;
  poolError: string | null;
  poolLatencyMs: number | null;
  datum: StatusResponse['datum'];
  nextTickAt: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  // Split the pool URL into scheme / host / port so the card doesn't
  // wrap an unreadable 60-character string. Pool URLs on Ocean look
  // like stratum+tcp://myrig.example.com:23334 - we care about
  // the host most, the scheme rarely, the port sometimes. Rendering
  // three aligned rows beats a wrapped monofont URL every time.
  const urlParts = splitPoolUrl(url);
  const copy = async () => {
    try {
      await copyToClipboard(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard fell back to execCommand and still failed; no-op */
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">Datum Gateway</div>
        <div className="text-[11px] text-slate-500 font-mono">
          <RefreshCountdown nextAtMs={nextTickAt} refetchQueryKey={STATUS_QUERY_KEY} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ReachabilityBadge
          label={t`stratum reachable`}
          reachable={reachable}
          downLabel={t`stratum DOWN (${consecutiveFailures} consecutive)`}
          title={
            reachable
              ? t`TCP probe of the Datum gateway's stratum port.` +
                (poolLatencyMs !== null ? ` ${poolLatencyMs}ms` : '')
              : poolError
                ? t`TCP probe failed: ${poolError}`
                : t`TCP probe of the Datum gateway's stratum port.`
          }
        />
        {datum && (
          <ReachabilityBadge
            label={t`API reachable`}
            reachable={datum.reachable}
            downLabel={t`API unreachable (${datum.consecutive_failures})`}
            title={t`Datum /umbrel-api HTTP poll.`}
          />
        )}
      </div>
      {datum ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400"><Trans>datum hashrate</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {datum.hashrate_ph !== null ? denomination.formatHashrate(datum.hashrate_ph) : '-'}
          </div>
          <div className="text-slate-400"><Trans>workers connected</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {datum.connections ?? '-'}
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-500">
          <Trans>
            Datum stats not configured - set <span className="font-mono text-slate-400">datum_api_url</span>{' '}
            in Config to display connected workers and reported hashrate. See{' '}
            <span className="font-mono text-slate-400">docs/setup-datum-api.md</span>.
          </Trans>
        </div>
      )}
      {/* Pool info lives at the bottom - stratum URL rarely changes
          after initial setup, so it deserves less visual weight than
          the live numbers above. Icon-only copy button keeps the
          footprint small. */}
      <div className="mt-3 pt-2 border-t border-slate-800">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>pool</Trans></div>
          <button
            onClick={copy}
            aria-label={copied ? t`copied URL` : t`copy URL`}
            title={copied ? t`copied URL` : t`copy URL`}
            className={
              'shrink-0 p-1 rounded border border-slate-700 hover:bg-slate-800 ' +
              (copied ? 'text-emerald-300' : 'text-slate-400')
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <div className="text-slate-400"><Trans>protocol</Trans></div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.scheme ?? '\u2014'}
          </div>
          <div className="text-slate-400"><Trans>host</Trans></div>
          <div className="text-right font-mono text-slate-200 break-all">
            {urlParts.host ?? '\u2014'}
          </div>
          <div className="text-slate-400"><Trans>port</Trans></div>
          <div className="text-right font-mono text-slate-200">
            {urlParts.port ?? '\u2014'}
          </div>
        </div>
      </div>
    </div>
  );
}

function BidProgress({ pct }: { pct: number | null }) {
  const { intlLocale } = useLocale();
  if (pct === null || pct === undefined) return <span className="text-slate-600 text-xs">-</span>;
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-slate-800 rounded overflow-hidden">
        <div className="h-full bg-emerald-500" style={{ width: `${clamped}%` }} />
      </div>
      <span className="text-xs text-slate-400 font-mono tabular-nums w-9 text-right">
        {formatNumber(clamped, {}, intlLocale)}%
      </span>
    </div>
  );
}

/**
 * Parse a pool URL like `stratum+tcp://myrig.example.com:23334`
 * into its three human-readable pieces. Any part that can't be
 * extracted comes back null (the component renders "-" for missing
 * pieces). This is cosmetic-only - the copy button still copies the
 * original unparsed string.
 */
function splitPoolUrl(url: string): {
  scheme: string | null;
  host: string | null;
  port: string | null;
} {
  if (!url) return { scheme: null, host: null, port: null };
  const schemeMatch = /^([a-zA-Z][\w+.-]*):\/\//.exec(url);
  const scheme = schemeMatch ? schemeMatch[1] : null;
  const rest = schemeMatch ? url.slice(schemeMatch[0].length) : url;
  const [hostPart, portPart] = rest.split(':', 2);
  return {
    scheme: scheme ?? null,
    host: hostPart || null,
    port: portPart ? portPart.split('/')[0] || null : null,
  };
}

function Card({
  title,
  nextRefreshAtMs,
  refetchQueryKey,
  badges,
  children,
}: {
  title: string;
  /** When set, renders a "refreshes in X" countdown in the header. */
  nextRefreshAtMs?: number | null;
  /** Query key to invalidate when the countdown hits zero. */
  refetchQueryKey?: readonly unknown[];
  /** Optional reachability pills rendered under the title. */
  badges?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wider text-slate-100">{title}</div>
        {nextRefreshAtMs != null && (
          <div className="text-[11px] text-slate-500 font-mono">
            <RefreshCountdown nextAtMs={nextRefreshAtMs} refetchQueryKey={refetchQueryKey} />
          </div>
        )}
      </div>
      {badges && <div className="flex items-center gap-2 mb-2 flex-wrap">{badges}</div>}
      {children}
    </div>
  );
}

/**
 * Renders a pre-formatted value string (e.g. "45,662 sat/PH/day")
 * with the unit muted and the "sat" word replaced by the icon.
 * Use this anywhere a denomination-formatted string is rendered
 * outside of Row/FinanceRow/StatCard (which do their own splitting).
 */
function FormattedValue({ v, className = '' }: { v: string; className?: string }) {
  const split = splitUnit(v);
  if (!split) return <span className={className}>{v}</span>;
  return (
    <span className={className}>
      {split.num}
      <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
    </span>
  );
}

/**
 * Renders a unit string with "sat" replaced by the ₿-style sat
 * symbol icon. Handles "sat", "sat/PH/day", "PH/s" (no replacement
 * for non-sat units). Only applies in sats mode - USD values like
 * "$4.75/PH/day" don't match splitUnit so they render as plain text.
 *
 * Single-character symbols (≡, %, ₿) get a fixed-width centered slot
 * (`w-3 text-center`) so their visible centers align across rows
 * even though their intrinsic glyph widths differ - without this,
 * a row showing `0,0107 %` and a row showing `722.513 ≡` right-align
 * the bounding boxes of the unit spans but the visible glyphs drift
 * a couple of pixels because % is wider than ≡. Compound units like
 * `≡/PH/day` skip the fixed slot and render naturally - they're not
 * the alignment-sensitive case.
 */
function SatUnit({ unit }: { unit: string }) {
  const { i18n } = useLingui();
  void i18n;
  // Replace the `/PH/day` slug with the localized form before
  // rendering. Done as a string substitution rather than a wholesale
  // <Trans> because `unit` may also carry trailing parenthetical hints
  // (e.g. "(in this range)") that we don't want to lose.
  const phDayLabel = t`/PH/day`;
  const localized = unit.replace('/PH/day', phDayLabel);
  if (localized === 'sat' || localized === '₿') {
    return (
      <span className="inline-block w-3 text-center">
        {localized === 'sat' ? <SatSymbol className="opacity-70" /> : localized}
      </span>
    );
  }
  if (localized === '%') {
    return <span className="inline-block w-3 text-center">{localized}</span>;
  }
  if (localized.startsWith('sat')) {
    return (
      <>
        <SatSymbol className="opacity-70" />
        {localized.slice(3)}
      </>
    );
  }
  return <>{localized}</>;
}

/**
 * Key-value row used across all info cards. Detects trailing unit
 * suffixes (sat, PH/s, sat/PH/day) and renders them in a muted
 * smaller style so the number pops and the unit recedes - matching
 * the aesthetic the Money panel's FinanceRow already uses.
 */
function Row({ k, v, tooltip }: { k: string; v: string; tooltip?: string }) {
  const split = splitUnit(v);
  const body = (
    <div className="flex justify-between text-sm py-0.5">
      <span className={'text-slate-400' + (tooltip ? ' cursor-help' : '')}>{k}</span>
      <span className="text-slate-100 font-mono">
        {split ? (
          <>
            {split.num}
            <span className="text-slate-500 text-[11px] ml-1"><SatUnit unit={split.unit} /></span>
          </>
        ) : (
          v
        )}
      </span>
    </div>
  );
  return tooltip ? <Tooltip text={tooltip}>{body}</Tooltip> : body;
}

/**
 * Variant of {@link Row} whose value is a link opening in a new tab.
 * Used by the Ocean panel's "last pool block" row to jump into the
 * configured block explorer (issue #22).
 */
function LinkRow({ k, v, href }: { k: string; v: string; href: string }) {
  return (
    <div className="flex justify-between text-sm py-0.5">
      <span className="text-slate-400">{k}</span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 hover:text-sky-300 font-mono"
      >
        {v}
      </a>
    </div>
  );
}

/**
 * Split a pre-formatted display value like "45,662 sat/PH/day" into
 * `{ num: "45,662", unit: "sat/PH/day" }` so the caller can render
 * the unit in a muted style. Handles the full matrix of units the
 * dashboard now produces:
 *   - hashrate: "X TH/s" | "X PH/s" | "X EH/s" | "X PH·h"
 *   - bare currency: "X sat" | "X BTC" | "$X"
 *   - rates with space separator: "X sat/{TH|PH|EH}/day" |
 *     "X BTC/{TH|PH|EH}/day"
 *   - rates with no space (USD-prefix): "$X/{TH|PH|EH}/day"
 * Returns null for values without a recognised unit suffix.
 */
/**
 * Rewrite a daemon-emitted summary string ("EDIT ... 48,189 -> 48,444
 * sat/PH/day", "Just lowered bid: 48,924 → 48,461 sat/PH/day", "Bid
 * filling at 3.17 PH/s.", etc.) so embedded unit-bearing values follow
 * the operator's currency + hashrate-unit toggles. Daemon currently
 * ships these as plain strings rather than structured fields, so a
 * regex sweep is the pragmatic shim until ProposalView /
 * NextActionView grow typed price/hashrate fields.
 *
 * Numbers are parsed permissively (commas as thousands separators,
 * dots or commas as decimal separators - daemon emits en-US so dots
 * decimal/commas thousands; we strip commas and let parseFloat handle
 * the rest).
 *
 * Patterns covered:
 *   - rate arrows: "X (->|→) Y sat/{PH|EH}/day" -> joined formatted pair
 *   - bare rates: "X sat/{PH|EH}/day" -> formatSatPerPhDay
 *   - hashrate arrows: "A (->|→) B {TH|PH|EH}/s" -> joined formatted pair
 *   - bare hashrates: "X {TH|PH|EH}/s" -> formatHashrate
 *
 * Both rate and hashrate sides are normalised to a canonical
 * sat/PH/day or PH/s value before passing to the formatter, so the
 * daemon's choice of units doesn't matter.
 *
 * Order-sensitive: longer/specific patterns (arrows + sat/EH/day) run
 * before shorter ones (bare + sat/PH/day) so we don't half-rewrite a
 * pair.
 */
const RATE_RE = /(-?[\d,.]+)\s*(?:->|→|→)\s*(-?[\d,.]+)\s*sat\/(PH|EH)\/day|(-?[\d,.]+)\s*sat\/(PH|EH)\/day/g;
const HR_RE = /(-?[\d,.]+)\s*(?:->|→|→)\s*(-?[\d,.]+)\s*(TH|PH|EH)\/s|(-?[\d,.]+)\s*(TH|PH|EH)\/s/g;

function relabelSummary(
  s: string,
  denomination: ReturnType<typeof useDenomination>,
): string {
  if (!s) return s;
  // The daemon emits numbers via .toLocaleString('en-US') so the
  // input invariably uses comma as thousand-separator and period as
  // decimal separator - regardless of the operator's display
  // locale. We must NOT re-process our own output: formatSatPerPhDay
  // renders in nl-NL ("48.500" with period thousand-sep) which a
  // naive bare-rate pass would re-parse as 48.5 and re-emit as "49"
  // - the bug the operator hit on the just-raised banner.
  //
  // Solution: combine the arrow-pair and bare patterns into ONE
  // regex per dimension (rate / hashrate) and run each as a single
  // .replace pass. The regex engine does not re-scan the output of
  // a replace callback within the same pass, so the arrow case
  // gobbles "X → Y unit" wholesale and the bare alternative cannot
  // re-match the formatted result.
  const parseEnUsNum = (raw: string): number =>
    Number.parseFloat(raw.replace(/,/g, ''));
  const toSatPerPhDay = (raw: string, unit: 'PH' | 'EH'): number => {
    const n = parseEnUsNum(raw);
    if (!Number.isFinite(n)) return NaN;
    return unit === 'EH' ? n / 1000 : n;
  };
  const toPh = (raw: string, unit: 'TH' | 'PH' | 'EH'): number => {
    const n = parseEnUsNum(raw);
    if (!Number.isFinite(n)) return NaN;
    return unit === 'TH' ? n / 1000 : unit === 'EH' ? n * 1000 : n;
  };

  // Rate pass: arrow OR bare, single combined regex. The arrow
  // alternative is listed first so the regex engine prefers it
  // when both could match (the engine is left-to-right + greedy
  // within the first alternative).
  RATE_RE.lastIndex = 0;
  let out = s.replace(
    RATE_RE,
    (
      _m,
      arrowA: string | undefined,
      arrowB: string | undefined,
      arrowUnit: 'PH' | 'EH' | undefined,
      bareN: string | undefined,
      bareUnit: 'PH' | 'EH' | undefined,
    ) => {
      if (arrowA !== undefined && arrowB !== undefined && arrowUnit) {
        const aPh = toSatPerPhDay(arrowA, arrowUnit);
        const bPh = toSatPerPhDay(arrowB, arrowUnit);
        if (!Number.isFinite(aPh) || !Number.isFinite(bPh)) return _m;
        return `${denomination.formatSatPerPhDay(aPh)} → ${denomination.formatSatPerPhDay(bPh)}`;
      }
      if (bareN !== undefined && bareUnit) {
        const ph = toSatPerPhDay(bareN, bareUnit);
        return Number.isFinite(ph) ? denomination.formatSatPerPhDay(ph) : _m;
      }
      return _m;
    },
  );

  // Hashrate pass: same idea.
  HR_RE.lastIndex = 0;
  out = out.replace(
    HR_RE,
    (
      _m,
      arrowA: string | undefined,
      arrowB: string | undefined,
      arrowUnit: 'TH' | 'PH' | 'EH' | undefined,
      bareN: string | undefined,
      bareUnit: 'TH' | 'PH' | 'EH' | undefined,
    ) => {
      if (arrowA !== undefined && arrowB !== undefined && arrowUnit) {
        const aPh = toPh(arrowA, arrowUnit);
        const bPh = toPh(arrowB, arrowUnit);
        if (!Number.isFinite(aPh) || !Number.isFinite(bPh)) return _m;
        return `${denomination.formatHashrate(aPh)} → ${denomination.formatHashrate(bPh)}`;
      }
      if (bareN !== undefined && bareUnit) {
        const ph = toPh(bareN, bareUnit);
        return Number.isFinite(ph) ? denomination.formatHashrate(ph) : _m;
      }
      return _m;
    },
  );

  return out;
}

function splitUnit(v: string): { num: string; unit: string } | null {
  // Whitespace-separated unit tail (rates and hashrate).
  // Order: match the longer rate suffix before the shorter "sat"/"₿"/"PH/s".
  const spaced = v.match(
    /^(.+?)\s+((?:sat|₿)\/(?:TH|PH|EH)\/day|(?:TH|PH|EH)\/s|PH·h|sat|₿)(\s*(?:\(.*\))?)$/,
  );
  if (spaced?.[1] && spaced[2]) return { num: spaced[1], unit: spaced[2] + (spaced[3] ?? '') };
  // USD-prefixed rate: "$4.75/PH/day" -> { num: "$4.75", unit: "/PH/day" }
  const usdRate = v.match(/^(.+?)(\/(?:TH|PH|EH)\/day)$/);
  if (usdRate?.[1] && usdRate[2]) return { num: usdRate[1], unit: usdRate[2] };
  // Trailing percent sign, no whitespace. Lets share log / uptime /
  // return-on-spend / rejection rate all share the same number-then-
  // muted-unit treatment the sat values get: small space between
  // number and symbol, symbol in muted slate. Asked for by the
  // operator: "Why is the Satoshi symbol muted gray and the
  // percentage symbol not? Just makes it a bit more logical."
  const pct = v.match(/^(.+?)(%)$/);
  if (pct?.[1] && pct[2]) return { num: pct[1], unit: pct[2] };
  return null;
}

// Operator-friendly labels for gate reasons. The raw enum-style
// strings (PRICE_DECREASE_COOLDOWN etc.) leaked into the proposals
// strip; this maps each to the same human-readable label the
// tick-result feedback row uses (line ~923), so both surfaces speak
// the same language.
function gateReasonLabel(reason: string): string {
  switch (reason) {
    case 'PRICE_DECREASE_COOLDOWN':
      return t`Braiins 10-min cooldown`;
    case 'RUN_MODE_NOT_LIVE':
      return t`not in LIVE mode`;
    case 'RUN_MODE_PAUSED':
      return t`paused`;
    case 'ACTION_MODE_BLOCKS_CREATE_OR_EDIT':
      return t`action mode blocks this`;
    // #222: any active bid's fee_rate_pct above max_acceptable_fee_pct.
    case 'FEE_THRESHOLD_EXCEEDED':
      return t`Braiins fee above your threshold`;
    default:
      // Fall back to a humanised form of the raw enum -
      // PRICE_DECREASE_COOLDOWN → "price decrease cooldown" - so an
      // unknown reason still reads decently.
      return reason.toLowerCase().replace(/_/g, ' ');
  }
}

function ProposalLine({ p }: { p: ProposalView }) {
  const denomination = useDenomination();
  const badge =
    p.executed === 'EXECUTED'
      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-800'
      : p.executed === 'DRY_RUN'
        ? 'bg-sky-900/40 text-sky-300 border-sky-800'
        : p.executed === 'BLOCKED'
          ? 'bg-red-900/40 text-red-300 border-red-800'
          : 'bg-amber-900/40 text-amber-300 border-amber-800';
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <span className={`inline-block font-mono text-xs uppercase mr-2 border rounded px-1.5 ${badge}`}>
        {p.executed.toLowerCase().replace('_', ' ')}
      </span>
      <span className="text-slate-100">{relabelSummary(p.summary, denomination)}</span>
      {p.gate_reason && (
        <span className="text-xs text-red-400 ml-2">({gateReasonLabel(p.gate_reason)})</span>
      )}
    </div>
  );
}

function RunModeToggle({
  current,
  onChange,
  disabled,
}: {
  current: StatusResponse['run_mode'];
  onChange: (m: (typeof RUN_MODES)[number]) => void;
  disabled: boolean;
}) {
  const { i18n } = useLingui();
  void i18n;
  const labelFor = (m: (typeof RUN_MODES)[number]) => {
    switch (m) {
      case 'DRY_RUN':
        return t`DRY RUN`;
      case 'LIVE':
        return t`LIVE`;
      case 'PAUSED':
        return t`PAUSED`;
    }
  };
  return (
    <div className="inline-flex gap-1.5 bg-slate-950/70 border border-slate-800 rounded-xl p-1.5 mt-5">
      {RUN_MODES.map((m) => {
        const active = m === current;
        return (
          <button
            key={m}
            disabled={disabled || active}
            onClick={() => onChange(m)}
            className={
              'px-5 py-2.5 text-sm rounded-lg transition font-medium tracking-wide ' +
              (active
                ? 'bg-amber-400 text-slate-900'
                : 'text-slate-300 hover:bg-slate-800 disabled:opacity-50')
            }
          >
            {labelFor(m)}
          </button>
        );
      })}
    </div>
  );
}

// Silence linter - ModeBadge is imported for consistency elsewhere in the app.
void ModeBadge;