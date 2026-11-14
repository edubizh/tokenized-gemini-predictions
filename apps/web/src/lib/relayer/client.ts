// Typed access to the relayer's API through the app's own proxy. The browser never talks to the
// relayer directly.

import type { ApiError, ApiHealth, ApiMarket, ApiOrder, ApiStatus } from "@outcome/relayer/api-types";

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

export function getHealth(signal?: AbortSignal): Promise<ApiHealth> {
  return request("/health", { signal });
}

export async function getMarkets(scope: "live" | "all" = "live", signal?: AbortSignal): Promise<ApiMarket[]> {
  return (await request<{ markets: ApiMarket[] }>(`/markets?scope=${scope}`, { signal })).markets;
}

/** Null when the relayer does not know the symbol. */
export async function getMarket(symbol: string, signal?: AbortSignal): Promise<ApiMarket | null> {
  return orNullOn404(request<ApiMarket>(`/markets/${encodeURIComponent(symbol)}`, { signal }));
}

/** Asks the relayer to create the on-chain market if it does not exist yet. */
export function ensureMarket(symbol: string, signal?: AbortSignal): Promise<ApiMarket> {
  return request(`/markets/${encodeURIComponent(symbol)}/ensure`, { method: "POST", signal });
}

/** Newest first, at most 100. */
export async function getOrders(user: string, signal?: AbortSignal): Promise<ApiOrder[]> {
  return (await request<{ orders: ApiOrder[] }>(`/orders?user=${encodeURIComponent(user)}`, { signal })).orders;
}

/** Null until the relayer has seen the order. */
export async function getOrder(address: string, signal?: AbortSignal): Promise<ApiOrder | null> {
  return orNullOn404(request<ApiOrder>(`/orders/${encodeURIComponent(address)}`, { signal }));
}

export function getStatus(signal?: AbortSignal): Promise<ApiStatus> {
  return request("/status", { signal });
}

async function orNullOn404<T>(pending: Promise<T>): Promise<T | null> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof RelayerError && error.status === 404) return null;
    throw error;
  }
}
