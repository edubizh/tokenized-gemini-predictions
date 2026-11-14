// The relayer's local HTTP API: JSON only, read-mostly, bound to the loopback interface. The
// routes and shapes are the ones listed in `types.ts`.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Journal, JournalOrder } from "../journal.ts";
import { MarketError } from "../markets.ts";
import type { VenueFill } from "../venue/types.ts";
import type { ApiError, ApiHealth, ApiMarket, ApiOrder, ApiStatus } from "./types.ts";

export interface ApiHandlers {
  health(): ApiHealth;
  markets(scope: "live" | "all"): ApiMarket[];
  market(symbol: string): ApiMarket | undefined;
  /** Creates the on-chain market if it is missing. Rejects with a `MarketError` when it may not. */
  ensureMarket(symbol: string): Promise<ApiMarket>;
  /** Newest first. */
  orders(user: string, limit: number): ApiOrder[];
  order(address: string): ApiOrder | undefined;
  status(): ApiStatus;
}

export interface ApiServerOptions {
  port: number;
  /** Default "127.0.0.1". */
  host?: string;
  handlers: ApiHandlers;
  /** Receives the detail of every request that failed with a 500. */
  log?: (line: string) => void;
  /** Unix milliseconds. */
  now?: () => number;
}

export interface ApiServer {
  /** Starts listening and resolves with the port. */
  listen(): Promise<number>;
  address(): { address: string; port: number } | null;
  close(): Promise<void>;
}

const SYMBOL = /^[A-Z0-9-]{1,64}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ORDERS = 100;
/** Market creations (calls that reach the chain) allowed per window, over all symbols. */
const ENSURE_CALLS = 6;
const ENSURE_WINDOW_MS = 60_000;

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const fail = (status: number, error: string, headers?: Record<string, string>): Reply => {
  const body: ApiError = { error };
  return headers === undefined ? { status, body } : { status, body, headers };
};
const ok = (body: unknown): Reply => ({ status: 200, body });

export function createApiServer(options: ApiServerOptions): ApiServer {
  const { handlers } = options;
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  /** Market creations in flight, by symbol. */
  const flights = new Map<string, Promise<ApiMarket>>();
  /** Start times of the creations of the last minute. */
  const recentEnsures: number[] = [];

  async function ensure(symbol: string): Promise<Reply> {
    const known = handlers.market(symbol);
    if (known === undefined) return fail(404, "unknown market");
    if (known.onchain !== null) return ok(known);

    let flight = flights.get(symbol);
    if (flight === undefined) {
      const at = now();
      while (recentEnsures.length > 0 && recentEnsures[0]! <= at - ENSURE_WINDOW_MS) recentEnsures.shift();
      if (recentEnsures.length >= ENSURE_CALLS) {
        const retryAfterSecs = Math.max(1, Math.ceil((recentEnsures[0]! + ENSURE_WINDOW_MS - at) / 1_000));
        return fail(429, "too many market creations, try again shortly", { "Retry-After": String(retryAfterSecs) });
      }
      recentEnsures.push(at);
      // The handler may throw before it returns a promise.
      flight = Promise.resolve()
        .then(() => handlers.ensureMarket(symbol))
        .finally(() => flights.delete(symbol));
      flights.set(symbol, flight);
    }
    try {
      return ok(await flight);
    } catch (error) {
      if (error instanceof MarketError) return error.code === "unknown" ? fail(404, "unknown market") : fail(409, error.message);
      throw error;
    }
  }

  async function route(method: string, segments: string[], query: URLSearchParams): Promise<Reply> {
    const [head, id, action, ...rest] = segments;
    const only = (allowed: "GET" | "POST", reply: () => Reply | Promise<Reply>): Reply | Promise<Reply> =>
      method === allowed ? reply() : fail(405, "method not allowed", { Allow: allowed });
    if (head === undefined || rest.length > 0) return fail(404, "not found");

    if (id === undefined) {
      switch (head) {
        case "health":
          return only("GET", () => ok(handlers.health()));
        case "status":
          return only("GET", () => ok(handlers.status()));
        case "markets":
          return only("GET", () => {
            const scope = query.get("scope") ?? "live";
            if (scope !== "live" && scope !== "all") return fail(400, "scope must be live or all");
            return ok({ markets: handlers.markets(scope) });
          });
        case "orders":
          return only("GET", () => {
            const user = query.get("user");
            if (user === null || !ADDRESS.test(user)) return fail(400, "invalid user address");
            const limitText = query.get("limit");
            const limit = limitText === null ? MAX_ORDERS : /^\d{1,3}$/.test(limitText) ? Number(limitText) : 0;
            if (limit < 1 || limit > MAX_ORDERS) return fail(400, `limit must be 1 to ${MAX_ORDERS}`);
            return ok({ orders: handlers.orders(user, limit) });
          });
        default:
          return fail(404, "not found");
      }
    }

    if (head === "markets" && (action === undefined || action === "ensure")) {
      return only(action === undefined ? "GET" : "POST", () => {
        if (!SYMBOL.test(id)) return fail(400, "invalid symbol");
        if (action === "ensure") return ensure(id);
        const found = handlers.market(id);
        return found === undefined ? fail(404, "unknown market") : ok(found);
      });
    }
    if (head === "orders" && action === undefined) {
      return only("GET", () => {
        if (!ADDRESS.test(id)) return fail(400, "invalid order address");
        const found = handlers.order(id);
        return found === undefined ? fail(404, "unknown order") : ok(found);
      });
    }
    return fail(404, "not found");
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Request bodies are not used by any route.
    request.resume();
    const method = request.method ?? "GET";
    let reply: Reply;
    let pathname = "";
    try {
      const url = new URL(request.url ?? "/", "http://relayer.invalid");
      pathname = url.pathname;
      let segments: string[] | null;
      try {
        segments = pathname.split("/").filter((part) => part !== "").map(decodeURIComponent);
      } catch {
        segments = null;
      }
      reply = segments === null ? fail(400, "invalid path") : await route(method, segments, url.searchParams);
    } catch (error) {
      log(`api ${method} ${pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      reply = fail(500, "internal error");
    }
    const text = JSON.stringify(reply.body, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    response.writeHead(reply.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
      ...reply.headers,
    });
    response.end(text);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });

  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    },

    address() {
      const bound = server.address();
      return bound === null || typeof bound === "string" ? null : { address: bound.address, port: bound.port };
    },

    close() {
      return new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** A journal row and its fills in the API's shape. */
export function toApiOrder(row: JournalOrder, fills: VenueFill[]): ApiOrder {
  return {
    address: row.orderAddress,
    user: row.user,
    symbol: row.symbol,
    kind: row.kind,
    side: row.side,
    units: row.units.toString(),
    limitPx: row.limitPx.toString(),
    maxFeeMicros: row.maxFeeMicros.toString(),
    expiresAt: row.expiresAt,
    state: row.state,
    venueOrderId: row.venueOrderId,
    filledUnits: row.filledUnits.toString(),
    amountMicros: row.amountMicros.toString(),
    feeMicros: row.feeMicros.toString(),
    fills: fills.map((fill) => ({
      tradeId: fill.tradeId,
      units: fill.units.toString(),
      px: fill.px.toString(),
      feeMicros: fill.feeMicros.toString(),
    })),
    chainSignature: row.chainSignature,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The handlers of a running relayer: health and status from the daemon, markets from the manager, orders from the journal. */
export function createApiHandlers(parts: {
  daemon: { health(): ApiHealth; status(): ApiStatus };
  manager: { views(scope: "live" | "all"): ApiMarket[]; view(symbol: string): ApiMarket | undefined; ensureOnchain(symbol: string): Promise<ApiMarket> };
  journal: Pick<Journal, "byUser" | "get" | "fills">;
}): ApiHandlers {
  const { daemon, manager, journal } = parts;
  const withFills = (row: JournalOrder): ApiOrder => toApiOrder(row, journal.fills(row.orderAddress));
  return {
    health: () => daemon.health(),
    markets: (scope) => manager.views(scope),
    market: (symbol) => manager.view(symbol),
    ensureMarket: (symbol) => manager.ensureOnchain(symbol),
    orders: (user, limit) => journal.byUser(user, limit).map(withFills),
    order: (address) => {
      const row = journal.get(address);
      return row === undefined ? undefined : withFills(row);
    },
    status: () => daemon.status(),
  };
}
