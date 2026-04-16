/**
 * Tiny Ocean-pool stats client.
 *
 * Ocean (ocean.xyz) doesn't publish a JSON API — its own dashboard polls
 * three HTML template fragments per address, each containing a few
 * labelled "blocks-label" + "<span>X.XXXXXXXX BTC</span>" pairs:
 *
 *   /template/workers/payoutcards?user=<address>     — Unpaid Earnings,
 *                                                      Estimated Payout
 *                                                      Next Block,
 *                                                      Estimated Time
 *                                                      Until Minimum
 *                                                      Payout
 *   /template/workers/lifetimecards?user=<address>   — Share Log %,
 *                                                      Estimated Earnings
 *                                                      Per Day, Lifetime
 *                                                      Earnings
 *   /template/workers/earningscards?user=<address>   — Shares In Reward
 *                                                      Window, Estimated
 *                                                      Rewards In Window,
 *                                                      Estimated Earnings
 *                                                      Next Block
 *
 * The fragments are tiny (sub-1 KB each) so even three serial GETs are
 * cheap. We cache the merged result in-memory with a TTL since the
 * underlying numbers only update on Ocean's share submission cadence
 * (multi-second).
 *
 * Output amounts are sat (integer). All BTC values from Ocean are
 * floating-point with 8 decimals — converted via Math.round(btc * 1e8).
 */

const OCEAN_BASE = 'https://ocean.xyz';
// Ocean's block-find threshold for an on-chain payout. Quoted on the
// dashboard itself ("The on-chain payout threshold is 0.01048576 BTC").
const PAYOUT_THRESHOLD_SAT = 1_048_576;

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

const SAT_PER_BTC = 100_000_000;

export interface OceanStats {
  /** Unpaid earnings — what would land on-chain at the next payout. */
  readonly unpaid_sat: number | null;
  /** Lifetime earnings — total ever earned at this address. */
  readonly lifetime_sat: number | null;
  /** Estimated rewards from shares already in the reward window. */
  readonly rewards_in_window_sat: number | null;
  /** Estimated earnings if a block is found right now. */
  readonly next_block_sat: number | null;
  /** Estimated earnings per day at the address's 3 h hashrate. */
  readonly daily_estimate_sat: number | null;
  /**
   * Time-until-payout text from Ocean ("11 days", "Below threshold",
   * etc.). Rendered verbatim — Ocean already formats it humanly and
   * the strings vary too much to safely re-parse.
   */
  readonly time_to_payout_text: string | null;
  /** Share-log fraction, surfaced for a sanity-check sub-line. */
  readonly share_log_pct: number | null;
  /** Pool's published payout threshold, repeated here for the UI. */
  readonly payout_threshold_sat: number;
  /** ms when this snapshot was fetched. */
  readonly fetched_at_ms: number;
}

export interface OceanClient {
  fetchStats(address: string): Promise<OceanStats | null>;
}

export interface OceanClientOptions {
  readonly fetch?: typeof fetch;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

export function createOceanClient(opts: OceanClientOptions = {}): OceanClient {
  const fetchImpl = opts.fetch ?? fetch;
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  const cache = new Map<string, OceanStats>();

  return {
    async fetchStats(address: string): Promise<OceanStats | null> {
      const cached = cache.get(address);
      if (cached && now() - cached.fetched_at_ms < ttl) return cached;

      try {
        const [payout, lifetime, earnings] = await Promise.all([
          getFragment(fetchImpl, `/template/workers/payoutcards?user=${address}`),
          getFragment(fetchImpl, `/template/workers/lifetimecards?user=${address}`),
          getFragment(fetchImpl, `/template/workers/earningscards?user=${address}`),
        ]);

        const stats: OceanStats = {
          unpaid_sat: parseBtcLabel(payout, 'Unpaid Earnings'),
          time_to_payout_text:
            parseRawSpanLabel(payout, 'Estimated Time Until Minimum Payout') ??
            parseRawSpanLabel(payout, 'Estimated Payout Next Block'),
          lifetime_sat: parseBtcLabel(lifetime, 'Lifetime Earnings'),
          daily_estimate_sat: parseBtcLabel(lifetime, 'Estimated Earnings Per Day'),
          share_log_pct: parsePctLabel(lifetime, 'Share Log %'),
          rewards_in_window_sat: parseBtcLabel(earnings, 'Estimated Rewards In Window'),
          next_block_sat: parseBtcLabel(earnings, 'Estimated Earnings Next Block'),
          payout_threshold_sat: PAYOUT_THRESHOLD_SAT,
          fetched_at_ms: now(),
        };
        cache.set(address, stats);
        return stats;
      } catch (err) {
        // Surface for the daemon log but don't crash the tick. The
        // dashboard treats `null` as "Ocean unavailable".
        console.warn(
          `[ocean] fetchStats(${address}) failed: ${(err as Error).message}`,
        );
        return null;
      }
    },
  };
}

async function getFragment(
  fetchImpl: typeof fetch,
  path: string,
): Promise<string> {
  const res = await fetchImpl(`${OCEAN_BASE}${path}`, {
    headers: { 'user-agent': 'braiins-hashrate-autopilot/0.1' },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} returned ${res.status}`);
  }
  return res.text();
}

/**
 * Find the value `<span>0.00356948 BTC</span>` that follows a
 * `<div class="blocks-label">Unpaid Earnings ...` block. Robust to
 * tooltip nesting and whitespace; case-sensitive on the label so we
 * don't accidentally pick up "Estimated Payout..." when looking for
 * "Estimated Earnings...".
 */
function parseBtcLabel(html: string, label: string): number | null {
  const re = new RegExp(
    String.raw`blocks-label">\s*` +
      escapeRegex(label) +
      String.raw`[\s\S]*?<span>\s*([\d.]+)\s*BTC\s*</span>`,
  );
  const m = html.match(re);
  if (!m || !m[1]) return null;
  const btc = Number.parseFloat(m[1]);
  if (!Number.isFinite(btc)) return null;
  return Math.round(btc * SAT_PER_BTC);
}

function parsePctLabel(html: string, label: string): number | null {
  const re = new RegExp(
    String.raw`blocks-label">\s*` +
      escapeRegex(label) +
      String.raw`[\s\S]*?<span>\s*([\d.]+)\s*%\s*</span>`,
  );
  const m = html.match(re);
  if (!m || !m[1]) return null;
  const pct = Number.parseFloat(m[1]);
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Generic "label -> text inside the value <span>". Used for the
 * time-until-payout and threshold-status text which aren't BTC values
 * (e.g. "11 days", "Below threshold").
 *
 * Subtle bug worth keeping commented: the .blocks-label DIV nests a
 * `tooltip tooltip-info` block whose `<span class="tooltiptext">...`
 * comes BEFORE the actual value `<span>`. Any pattern that accepts
 * `<span[^>]*>` matches the tooltip first and we end up rendering
 * Ocean's hover help-text on the dashboard instead of "11 days".
 * Constrain to bare `<span>` with no attributes — that's the value
 * convention Ocean's templates use throughout.
 */
function parseRawSpanLabel(html: string, label: string): string | null {
  const re = new RegExp(
    String.raw`blocks-label">\s*` +
      escapeRegex(label) +
      String.raw`[\s\S]*?<span>([\s\S]*?)</span>`,
  );
  const m = html.match(re);
  if (!m || !m[1]) return null;
  // Strip nested anchors / tags (the "Below threshold" branch wraps
  // the text in an <a>).
  const text = m[1].replace(/<[^>]+>/g, '').trim();
  return text.length > 0 ? text : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
