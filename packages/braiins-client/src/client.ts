/**
 * Braiins Hashpower API client — thin typed wrapper over the generated
 * OpenAPI types. See SPEC §13 and RESEARCH.md §2.
 *
 * Exposes the GET subset used for observation (M1) plus POST/PUT/DELETE
 * for bid mutations (M4). Mutations require an owner token; GETs on
 * account-scoped data require at least a read-only token.
 *
 * Retry policy:
 *   - 429 Too Many Requests — retried with exponential backoff (safe; the
 *     rate limiter rejects before any server-side commit).
 *   - 5xx — retried on GETs and DELETEs (idempotent). Not retried on
 *     POST/PUT, to avoid double-committing a mutation whose outcome is
 *     unknown.
 *   - SPEC §6.1: a 2FA-confirmation timeout is a controller-level state
 *     transition, not a retry condition; we surface the 4xx unchanged.
 */

import createOpenApiFetchClient from 'openapi-fetch';

import { type AuthRole, type BraiinsTokens, selectToken } from './auth.js';
import { BraiinsApiError, BraiinsNetworkError, readGrpcMessage } from './errors.js';
import type { components, paths } from './generated/types.js';

interface RawResult {
  data?: unknown;
  error?: unknown;
  response: Response;
}

/**
 * Production base URL for the Braiins Hashpower API.
 *
 * Note: this deviates from the `servers:` block in the OpenAPI spec
 * (`https://hashpower.braiins.com/api/v1`), which 404s in production.
 * Empirically, `/v1/...` is the live route. Probed 2026-04-15 via curl;
 * see RESEARCH.md §2 and the M1 smoke test.
 */
export const BRAIINS_BASE_URL = 'https://hashpower.braiins.com/v1';

export interface BraiinsClientConfig extends BraiinsTokens {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Max retry attempts for transient failures (429, 5xx when safe). Default 3. */
  readonly maxRetries?: number;
  /** Sleep function (override for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

// Pull response body types out of the generated paths map for a clean public
// surface. If the generated shape changes these aliases surface that early.
export type MarketStats = components['schemas']['SpotGetMarketStatsResponse'];
export type MarketSettings = components['schemas']['MarketSettings'];
export type FeeSchedule = components['schemas']['GetFeeStructureResponse'];
export type OrderbookSnapshot = components['schemas']['SpotGetOrderBookResponse'];
export type AccountBalance = components['schemas']['AccountBalance'];
export type AccountBalances = components['schemas']['GetAccountBalancesResponse'];
export type BidsResponse = components['schemas']['SpotGetBidsResponse'];
export type TransactionsResponse = components['schemas']['GetTransactionsResponse'];
export type Transaction = components['schemas']['Transaction'];
export type BidItem = components['schemas']['SpotGetBidsResponseItem'];
export type BidDetail = components['schemas']['SpotGetBidDetailResponse'];
export type PlaceBidRequest = components['schemas']['SpotPlaceBidRequest'];
export type PlaceBidResponse = components['schemas']['PlaceOrderResponse'];
export type EditBidRequest = components['schemas']['SpotEditBidRequest'];
export type CancelResponse = components['schemas']['CancelResponse'];

export interface CancelBidParams {
  readonly order_id?: string;
  readonly cl_order_id?: string;
}

export interface BraiinsClient {
  getStats(): Promise<MarketStats>;
  getOrderbook(): Promise<OrderbookSnapshot>;
  getSettings(): Promise<MarketSettings>;
  getFee(): Promise<FeeSchedule>;
  getBalance(): Promise<AccountBalances>;
  getCurrentBids(): Promise<BidsResponse>;
  /**
   * List the user's bids — historical + active — with pagination.
   *
   * Mirrors the OpenAPI `GET /spot/bid` endpoint. `limit` is capped at
   * 1000 by the server; default 200 to stay polite. Default order is
   * descending by creation time; set `reverse: true` for ascending.
   */
  listBids(opts?: {
    limit?: number;
    offset?: number;
    reverse?: boolean;
    exclude_active?: boolean;
  }): Promise<BidsResponse>;
  getTransactions(opts?: { limit?: number; offset?: number }): Promise<TransactionsResponse>;
  getBidDetail(orderId: string): Promise<BidDetail>;
  placeBid(request: PlaceBidRequest): Promise<PlaceBidResponse>;
  editBid(request: EditBidRequest): Promise<void>;
  cancelBid(params: CancelBidParams): Promise<CancelResponse>;
}

export function createBraiinsClient(config: BraiinsClientConfig = {}): BraiinsClient {
  const baseUrl = config.baseUrl ?? BRAIINS_BASE_URL;
  const maxRetries = config.maxRetries ?? 3;
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const api = createOpenApiFetchClient<paths>({
    baseUrl,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });

  const authHeaders = (role: AuthRole): Record<string, string> => {
    const token = selectToken(role, config);
    return token ? { apikey: token } : {};
  };

  const unwrap = <T>(endpoint: string, result: RawResult): T => {
    const { data, error, response } = result;
    if (!response.ok) {
      throw new BraiinsApiError({
        status: response.status,
        endpoint,
        grpcMessage: readGrpcMessage(response.headers),
        body: (error ?? data) as unknown,
      });
    }
    if (data === undefined) {
      throw new BraiinsApiError({
        status: response.status,
        endpoint,
        body: null,
        message: `Braiins API ${endpoint} returned ${response.status} with no body`,
      });
    }
    return data as T;
  };

  const withNetworkErrorWrap = async <T>(endpoint: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BraiinsApiError) throw err;
      throw new BraiinsNetworkError(endpoint, err);
    }
  };

  const withRetry = async <T>(
    endpoint: string,
    fn: () => Promise<T>,
    opts: { retryOn5xx: boolean; retryOnNetworkError: boolean },
  ): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const isLast = attempt >= maxRetries;
        const transient = isTransient(err, opts);
        if (isLast || !transient) throw err;
        // Exponential backoff capped at 2s.
        const delay = Math.min(200 * 2 ** (attempt - 1), 2000);
        await sleep(delay);
      }
    }
    throw lastErr;
  };

  const isTransient = (
    err: unknown,
    opts: { retryOn5xx: boolean; retryOnNetworkError: boolean },
  ): boolean => {
    if (err instanceof BraiinsApiError) {
      if (err.status === 429) return true;
      if (opts.retryOn5xx && err.status >= 500 && err.status < 600) return true;
      return false;
    }
    if (err instanceof BraiinsNetworkError) return opts.retryOnNetworkError;
    return false;
  };

  // Reads: retry all transient classes.
  const read = <T>(endpoint: string, fn: () => Promise<T>): Promise<T> =>
    withRetry(endpoint, () => withNetworkErrorWrap(endpoint, fn), {
      retryOn5xx: true,
      retryOnNetworkError: true,
    });

  // Mutations (create/edit): never retry 5xx or network errors — outcome
  // may be indeterminate on the server. 429 is safe (pre-commit rejection).
  const mutate = <T>(endpoint: string, fn: () => Promise<T>): Promise<T> =>
    withRetry(endpoint, () => withNetworkErrorWrap(endpoint, fn), {
      retryOn5xx: false,
      retryOnNetworkError: false,
    });

  // Cancel is idempotent — retry more liberally.
  const cancel = <T>(endpoint: string, fn: () => Promise<T>): Promise<T> =>
    withRetry(endpoint, () => withNetworkErrorWrap(endpoint, fn), {
      retryOn5xx: true,
      retryOnNetworkError: true,
    });

  return {
    getStats: () =>
      read('/spot/stats', async () => {
        const res = await api.GET('/spot/stats', { headers: authHeaders('PUBLIC') });
        return unwrap<MarketStats>('/spot/stats', res);
      }),

    getOrderbook: () =>
      read('/spot/orderbook', async () => {
        const res = await api.GET('/spot/orderbook', { headers: authHeaders('PUBLIC') });
        return unwrap<OrderbookSnapshot>('/spot/orderbook', res);
      }),

    getSettings: () =>
      read('/spot/settings', async () => {
        const res = await api.GET('/spot/settings', { headers: authHeaders('READ_ONLY') });
        return unwrap<MarketSettings>('/spot/settings', res);
      }),

    getFee: () =>
      read('/spot/fee', async () => {
        const res = await api.GET('/spot/fee', { headers: authHeaders('READ_ONLY') });
        return unwrap<FeeSchedule>('/spot/fee', res);
      }),

    getBalance: () =>
      read('/account/balance', async () => {
        const res = await api.GET('/account/balance', { headers: authHeaders('READ_ONLY') });
        return unwrap<AccountBalances>('/account/balance', res);
      }),

    getCurrentBids: () =>
      read('/spot/bid/current', async () => {
        const res = await api.GET('/spot/bid/current', { headers: authHeaders('READ_ONLY') });
        return unwrap<BidsResponse>('/spot/bid/current', res);
      }),

    listBids: ({ limit = 200, offset = 0, reverse, exclude_active } = {}) =>
      read('/spot/bid', async () => {
        // Build query object with only the fields set — passing
        // `undefined` through openapi-fetch's query serializer renders
        // as `&reverse=undefined`, which some servers reject.
        const query: Record<string, string | number | boolean> = { limit, offset };
        if (reverse !== undefined) query.reverse = reverse;
        if (exclude_active !== undefined) query.exclude_active = exclude_active;
        const res = await api.GET('/spot/bid', {
          params: { query },
          headers: authHeaders('READ_ONLY'),
        });
        return unwrap<BidsResponse>('/spot/bid', res);
      }),

    getTransactions: ({ limit = 200, offset = 0 } = {}) =>
      read('/account/transaction', async () => {
        const res = await api.GET('/account/transaction', {
          params: { query: { limit, offset } },
          headers: authHeaders('READ_ONLY'),
        });
        return unwrap<TransactionsResponse>('/account/transaction', res);
      }),

    getBidDetail: (orderId: string) =>
      read('/spot/bid/detail/{order_id}', async () => {
        const res = await api.GET('/spot/bid/detail/{order_id}', {
          params: { path: { order_id: orderId } },
          headers: authHeaders('READ_ONLY'),
        });
        return unwrap<BidDetail>('/spot/bid/detail/{order_id}', res);
      }),

    placeBid: (request: PlaceBidRequest) =>
      mutate('POST /spot/bid', async () => {
        const res = await api.POST('/spot/bid', {
          body: request,
          headers: authHeaders('OWNER'),
        });
        return unwrap<PlaceBidResponse>('POST /spot/bid', res);
      }),

    editBid: (request: EditBidRequest) =>
      mutate('PUT /spot/bid', async () => {
        const res = await api.PUT('/spot/bid', {
          body: request,
          headers: authHeaders('OWNER'),
        });
        // PUT returns an empty 200.
        if (!res.response.ok) {
          throw new BraiinsApiError({
            status: res.response.status,
            endpoint: 'PUT /spot/bid',
            grpcMessage: readGrpcMessage(res.response.headers),
            body: res.error ?? null,
          });
        }
      }),

    cancelBid: (params: CancelBidParams) =>
      cancel('DELETE /spot/bid', async () => {
        // Empirical: Braiins rejects `DELETE /spot/bid?order_id=…` with
        // "ID is required" (grpc-status 3, E_ID_REQUIRED). It expects the
        // ID in the JSON body instead, despite the OpenAPI spec marking
        // it as a query parameter. Bypass openapi-fetch and do the raw
        // request so the body is actually sent. Probed 2026-04-15.
        const fetchImpl = config.fetch ?? fetch;
        const headers: Record<string, string> = {
          ...authHeaders('OWNER'),
          'content-type': 'application/json',
          accept: 'application/json',
        };
        const response = await fetchImpl(`${baseUrl}/spot/bid`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify(params),
        });
        if (!response.ok) {
          let errBody: unknown = null;
          try {
            errBody = await response.json();
          } catch {
            /* empty body is normal for 4xx here */
          }
          throw new BraiinsApiError({
            status: response.status,
            endpoint: 'DELETE /spot/bid',
            grpcMessage: readGrpcMessage(response.headers),
            body: errBody,
          });
        }
        const data = (await response.json().catch(() => ({ affected_ids: { id: [] } }))) as CancelResponse;
        return data;
      }),
  };
}
