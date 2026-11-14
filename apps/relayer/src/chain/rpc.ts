// An RPC client that waits and retries when the endpoint rate-limits it. The public devnet
// endpoint answers HTTP 429 once an address exceeds its request budget, and the relayer, the web
// app and the scripts all share one address. Browser-safe: no Node imports.

import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type RpcTransport,
} from "@solana/kit";

export interface RetryOptions {
  /** How many times one request is retried before its error is thrown. Default 5. */
  retries?: number;
  /** First wait; doubles on each retry. Default 500 ms. */
  baseDelayMs?: number;
  /** Longest single wait. Default 5_000 ms. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; statusCode: number }) => void;
}

/** Statuses that mean "not processed, try again": rate limit and gateway trouble. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The HTTP status of a transport error, or null when the error is something else. */
export function httpStatusOf(error: unknown): number | null {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  const status = (error.context as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : null;
}

/** Seconds from a `Retry-After` header, as milliseconds; null when absent or unreadable. */
function retryAfterMs(error: unknown): number | null {
  if (!isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) return null;
  const headers = (error.context as { headers?: unknown }).headers;
  if (!(headers instanceof Headers)) return null;
  const seconds = Number(headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * Wraps a transport so that a rate-limited or briefly unavailable endpoint is retried with
 * growing waits. Re-sending is safe for every Solana RPC call: reads have no effect, and a
 * signed transaction sent twice is processed once.
 */
export function withRetry<TTransport extends RpcTransport>(transport: TTransport, options: RetryOptions = {}): TTransport {
  const retries = options.retries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? defaultSleep;

  const retrying = async <TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport<TResponse>(config);
      } catch (error) {
        const statusCode = httpStatusOf(error);
        if (statusCode === null || !RETRYABLE_STATUS.has(statusCode) || attempt >= retries) throw error;
        if (config.signal?.aborted) throw error;
        const delayMs = Math.min(maxDelayMs, retryAfterMs(error) ?? baseDelayMs * 2 ** attempt);
        options.onRetry?.({ attempt: attempt + 1, delayMs, statusCode });
        await sleep(delayMs);
      }
    }
  };
  return retrying as TTransport;
}

/** `createSolanaRpc` with the retrying transport. */
export function createRetryingRpc(url: string, options: RetryOptions = {}) {
  return createSolanaRpcFromTransport(withRetry(createDefaultRpcTransport({ url }), options));
}
