import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { parseFrame } from "../frames.ts";
import type { VenueFrame } from "../frames.ts";

export const SANDBOX_WS_URL = "wss://ws.sandbox.gemini.com";

const OPEN = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 60_000;

/** The part of the `ws` client this module uses. */
export interface SocketLike {
  readonly readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type WebSocketConstructor = new (url: string, options: { headers: Record<string, string> }) => SocketLike;

export type AckFrame = Extract<VenueFrame, { kind: "ack" }>;

export type CloseInfo =
  /** Nothing arrived for the liveness timeout: the socket was terminated. */
  | { reason: "liveness" }
  | { reason: "closed"; code: number }
  | { reason: "error"; detail: string };

export interface SocketOptions {
  /** Must be exactly the sandbox url. */
  url: string;
  WebSocketImpl?: WebSocketConstructor;
  /** Receives the text of every frame before it is parsed. */
  onFrame?(raw: string): void;
  /** Receives every frame after parsing, acks included. */
  onMessage?(frame: VenueFrame): void;
  /** Called once, and only for a socket that had opened. */
  onClose(info: CloseInfo): void;
  livenessTimeoutMs?: number;
  requestTimeoutMs?: number;
  openTimeoutMs?: number;
}

export interface PrivateSocketOptions extends SocketOptions {
  apiKey: string;
  apiSecret: string;
  /** Epoch milliseconds. */
  now?: () => number;
  /**
   * Awaited right before the upgrade request. The upgrade uses a nonce second of the key, so the
   * caller can queue it behind its signed REST calls.
   */
  beforeConnect?: () => Promise<void>;
}

export interface VenueSocket {
  readonly isOpen: boolean;
  /** Sends `{ id, method, params }` and resolves with the ack carrying that id, whatever its status. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<AckFrame>;
  close(): void;
}

/** The socket closed, or never opened. */
export class SocketClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketClosedError";
  }
}

/** No ack arrived in time. The request may or may not have been processed. */
export class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

interface Pending {
  resolve(ack: AckFrame): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Opens the authenticated socket: the account's streams and its orders. */
export async function openPrivateSocket(options: PrivateSocketOptions): Promise<VenueSocket> {
  assertSandbox(options.url);
  await options.beforeConnect?.();
  const nonce = String(Math.floor((options.now ?? Date.now)() / 1000));
  const payload = Buffer.from(nonce).toString("base64");
  return open(options, {
    "X-GEMINI-APIKEY": options.apiKey,
    "X-GEMINI-NONCE": nonce,
    "X-GEMINI-PAYLOAD": payload,
    "X-GEMINI-SIGNATURE": createHmac("sha384", options.apiSecret).update(payload).digest("hex"),
  });
}

/** Opens the same socket without credentials: market data streams and requests only. */
export async function openPublicSocket(options: SocketOptions): Promise<VenueSocket> {
  assertSandbox(options.url);
  return open(options, {});
}

function assertSandbox(url: string): void {
  if (url !== SANDBOX_WS_URL) throw new Error(`refusing socket url ${JSON.stringify(url)}: this build is sandbox only`);
}

/**
 * Opens a socket with the given upgrade headers and resolves once it is open. The socket never
 * reconnects by itself: after `onClose` it is dead and the caller decides what to do.
 *
 * Liveness: the server sends a protocol ping about every 20 s. A connection can also die without
 * a close event, so when neither a frame nor a ping arrives for `livenessTimeoutMs` the socket is
 * terminated and reported closed.
 */
async function open(options: SocketOptions, headers: Record<string, string>): Promise<VenueSocket> {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
  const Impl: WebSocketConstructor = options.WebSocketImpl ?? (WebSocket as unknown as WebSocketConstructor);
  const ws = new Impl(options.url, { headers });

  const pending = new Map<string, Pending>();
  let nextId = 1;
  let opened = false;
  let finished = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let failOpen: (error: Error) => void = () => {};

  const finish = (info: CloseInfo): void => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new SocketClosedError(`socket closed (${info.reason}) before the ack for request ${id}`));
    }
    pending.clear();
    if (opened) options.onClose(info);
  };

  const alive = (): void => {
    if (finished) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      ws.terminate();
      finish({ reason: "liveness" });
    }, livenessTimeoutMs);
  };

  ws.on("message", (data) => {
    if (finished) return;
    const raw = toText(data);
    options.onFrame?.(raw);
    alive();
    const frame = parseFrame(raw);
    options.onMessage?.(frame);
    if (frame.kind !== "ack") return;
    const entry = pending.get(frame.id);
    if (entry === undefined) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.resolve(frame);
  });
  ws.on("ping", alive);
  ws.on("close", (code) => {
    failOpen(new SocketClosedError("socket closed before it opened"));
    finish({ reason: "closed", code: typeof code === "number" ? code : 1006 });
  });
  ws.on("error", (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    ws.terminate();
    failOpen(new SocketClosedError(`socket failed to open: ${detail}`));
    finish({ reason: "error", detail });
  });
  ws.on("unexpected-response", (_request, response) => {
    const status = (response as { statusCode?: unknown } | undefined)?.statusCode;
    ws.terminate();
    failOpen(new SocketClosedError(`socket upgrade failed: HTTP ${String(status)}`));
    finish({ reason: "error", detail: "upgrade failed" });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      failOpen(new SocketClosedError(`socket did not open within ${openTimeoutMs} ms`));
      finish({ reason: "error", detail: "open timeout" });
    }, openTimeoutMs);
    failOpen = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    ws.on("open", () => {
      clearTimeout(timer);
      failOpen = () => {};
      if (finished) return;
      opened = true;
      alive();
      resolve();
    });
  });

  return {
    get isOpen() {
      return !finished && ws.readyState === OPEN;
    },
    request(method, params, timeoutMs = requestTimeoutMs) {
      return new Promise<AckFrame>((resolve, reject) => {
        if (finished) return reject(new SocketClosedError(`socket is closed: ${method} was not sent`));
        const id = String(nextId++);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RequestTimeoutError(`no ack for ${method} (id ${id}) within ${timeoutMs} ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close() {
      if (!finished) ws.close();
    },
  };
}

/** `ws` hands a text frame to listeners as a Buffer (or a list of them), not as a string. */
function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data as Uint8Array[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}
