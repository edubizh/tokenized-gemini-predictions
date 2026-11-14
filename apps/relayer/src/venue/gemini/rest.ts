import { createHmac } from "node:crypto";

export const SANDBOX_REST_HOST = "https://api.sandbox.gemini.com";

const DEFAULT_SIGNED_SPACING_MS = 1_100;
const PUBLIC_SPACING_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RestClientOptions {
  /** Must be exactly the sandbox host. */
  host: string;
  apiKey: string;
  apiSecret: string;
  fetch?: FetchLike;
  /** Epoch milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum time between the starts of two signed calls. */
  minSpacingMs?: number;
  /** Every request is aborted after this long. */
  timeoutMs?: number;
}

export interface RestClient {
  publicGet(path: string): Promise<unknown>;
  signed(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<unknown>;
  /**
   * Takes one turn in the signed queue without sending anything. Opening the private socket uses
   * a nonce second of the same key, so it waits here first.
   */
  reserveSlot(): Promise<void>;
}

/** A response that is not 2xx, or a 2xx response whose body is not JSON. */
export class RestError extends Error {
  readonly status: number;
  /** The parsed response body, or its text when it is not JSON. */
  readonly body: unknown;

  constructor(status: number, body: unknown, method: string, path: string) {
    super(`HTTP ${status} from ${method} ${path}`);
    this.name = "RestError";
    this.status = status;
    this.body = body;
  }
}

/**
 * REST access to the sandbox. Signed calls run one at a time and start at least `minSpacingMs`
 * apart: the key uses time-based nonces (epoch seconds) that must strictly increase per call.
 */
export function createRestClient(options: RestClientOptions): RestClient {
  if (options.host !== SANDBOX_REST_HOST) {
    throw new Error(`refusing REST host ${JSON.stringify(options.host)}: this build is sandbox only`);
  }
  const { host, apiKey, apiSecret } = options;
  const send: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signedQueue = createQueue(options.minSpacingMs ?? DEFAULT_SIGNED_SPACING_MS, now, sleep);
  const publicQueue = createQueue(PUBLIC_SPACING_MS, now, sleep);

  async function call(method: string, path: string, url: string, headers?: Record<string, string>): Promise<unknown> {
    const init: RequestInit = { method, signal: AbortSignal.timeout(timeoutMs) };
    if (headers !== undefined) init.headers = headers;
    const response = await send(url, init);
    const text = await response.text();
    let body: unknown = text;
    let isJson = true;
    try {
      body = parseLossless(text);
    } catch {
      isJson = false;
    }
    if (!response.ok || !isJson) throw new RestError(response.status, body, method, path);
    return body;
  }

  return {
    publicGet(path) {
      return publicQueue(() => call("GET", path, host + path));
    },
    signed(method, path, params = {}, query) {
      return signedQueue(() => {
        const nonce = Math.floor(now() / 1000);
        const payload = Buffer.from(JSON.stringify({ request: path, ...params, nonce })).toString("base64");
        const signature = createHmac("sha384", apiSecret).update(payload).digest("hex");
        const search = query === undefined ? "" : `?${new URLSearchParams(query).toString()}`;
        return call(method, path, host + path + search, {
          "Content-Type": "text/plain",
          "Content-Length": "0",
          "Cache-Control": "no-cache",
          "X-GEMINI-APIKEY": apiKey,
          "X-GEMINI-PAYLOAD": payload,
          "X-GEMINI-SIGNATURE": signature,
        });
      });
    },
    reserveSlot() {
      return signedQueue(async () => {});
    },
  };
}

/**
 * Runs tasks one at a time, each starting at least `spacingMs` after the previous one started.
 * A failed task does not stop the queue.
 */
function createQueue(spacingMs: number, now: () => number, sleep: (ms: number) => Promise<void>) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastStartMs = Number.NEGATIVE_INFINITY;
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const turn = tail.then(async () => {
      const waitMs = lastStartMs + spacingMs - now();
      if (waitMs > 0) await sleep(waitMs);
      lastStartMs = now();
      return task();
    });
    tail = turn.catch(() => {});
    return turn;
  };
}

const LONG_INTEGER = /^-?\d{16,}$/;

/**
 * JSON.parse that returns integer literals of 16 or more digits as strings (order ids have 18
 * digits and do not fit a Number). Throws rather than rounding when the runtime does not pass
 * the source text of a number to the reviver.
 */
function parseLossless(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    const source = context?.source;
    if (source === undefined) throw new Error("JSON.parse did not provide the source text of a number");
    return LONG_INTEGER.test(source) ? source : value;
  });
}
