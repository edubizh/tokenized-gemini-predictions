// Typed access to the relayer's API through the app's own proxy, one function per route. The
// browser never talks to the relayer directly.

import type { ApiDepth, ApiError, ApiEvent, ApiEventDetail, ApiHealth, ApiHistory, ApiMarket, ApiOrder, ApiStatus, ApiTrade } from "@outcome/relayer/api-types";

export class RelayerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayerError";
    this.status = status;
  }

  /** True when the relayer could not be reached at all. */
  get offline(): boolean {
    return this.status === 502 || this.status === 0;
  }
}

const BASE = "/api/relayer";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  } catch {
    throw new RelayerError(0, "The app server did not answer.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body !== null && typeof body === "object" && typeof (body as ApiError).error === "string" ? (body as ApiError).error : `HTTP ${response.status}`;
    throw new RelayerError(response.status, message);
  }
  return body as T;
}

async function orNullOn404<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof RelayerError && error.status === 404) return null;
    throw error;
  }
}

const market = (symbol: string) => `/markets/${encodeURIComponent(symbol)}`;

export function getHealth(signal?: AbortSignal): Promise<ApiHealth> {
  return request("/health", { signal });
}

/** Every listed event that has not expired, with its contracts and their quotes. Soonest expiry first. */
export async function getEvents(signal?: AbortSignal): Promise<ApiEvent[]> {
  return (await request<{ events: ApiEvent[] }>("/events", { signal })).events;
}

/** One event with its description and rules, expired or not. Null when the relayer does not know the ticker. */
export function getEvent(ticker: string, signal?: AbortSignal): Promise<ApiEventDetail | null> {
  return orNullOn404(request<ApiEventDetail>(`/events/${encodeURIComponent(ticker)}`, { signal }));
}

/** The markets that exist on-chain: only these can hold positions or orders. Newest expiry first, at most 500. */
export async function getMarkets(signal?: AbortSignal): Promise<ApiMarket[]> {
  return (await request<{ markets: ApiMarket[] }>("/markets", { signal })).markets;
}

/** Null when the relayer does not know the symbol. */
export function getMarket(symbol: string, signal?: AbortSignal): Promise<ApiMarket | null> {
  return orNullOn404(request<ApiMarket>(market(symbol), { signal }));
}

/**
 * Asks the relayer to create the on-chain market if it does not exist yet. The proxy lets this
 * through for a logged-in user only, so it needs the login token.
 */
export function ensureMarket(symbol: string, token: string, signal?: AbortSignal): Promise<ApiMarket> {
  return request(`${market(symbol)}/ensure`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal });
}

/** Resting orders of one contract, best price first on each side. Null when the relayer does not know the symbol. */
export function getDepth(symbol: string, signal?: AbortSignal): Promise<ApiDepth | null> {
  return orNullOn404(request<ApiDepth>(`${market(symbol)}/depth`, { signal }));
}

/** Trades at the venue, newest first, at most 50. Null when the relayer does not know the symbol. */
export async function getTrades(symbol: string, signal?: AbortSignal): Promise<ApiTrade[] | null> {
  return (await orNullOn404(request<{ trades: ApiTrade[] }>(`${market(symbol)}/trades`, { signal })))?.trades ?? null;
}

/** Price history, oldest first; empty until the contract has traded. Null when the relayer does not know the symbol. */
export function getHistory(symbol: string, signal?: AbortSignal): Promise<ApiHistory | null> {
  return orNullOn404(request<ApiHistory>(`${market(symbol)}/history`, { signal }));
}

/** Newest first, at most 100. */
export async function getOrders(user: string, signal?: AbortSignal): Promise<ApiOrder[]> {
  return (await request<{ orders: ApiOrder[] }>(`/orders?user=${encodeURIComponent(user)}`, { signal })).orders;
}

/** Null until the relayer has seen the order. */
export function getOrder(address: string, signal?: AbortSignal): Promise<ApiOrder | null> {
  return orNullOn404(request<ApiOrder>(`/orders/${encodeURIComponent(address)}`, { signal }));
}

export function getStatus(signal?: AbortSignal): Promise<ApiStatus> {
  return request("/status", { signal });
}
