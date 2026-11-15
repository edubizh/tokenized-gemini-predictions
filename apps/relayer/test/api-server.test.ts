import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandlers, createApiServer, toApiOrder } from "../src/api/server.ts";
import type { ApiHandlers, ApiServer } from "../src/api/server.ts";
import type { ApiDepth, ApiEvent, ApiEventDetail, ApiHealth, ApiHistory, ApiMarket, ApiOrder, ApiStatus, ApiTrade } from "../src/api/types.ts";
import { openJournal } from "../src/journal.ts";
import { MarketError } from "../src/markets.ts";

const SYMBOL = "TEST-BTC15M2611140300-UP";
const TICKER = "BTC15M2611140300";
// Synthetic addresses: valid base58 text, not real accounts.
const USER = "U".repeat(44);
const ORDER = "o".repeat(32);

const HEALTH = { ok: true, cluster: "localnet", venue: "mock", chainTime: 1_800_000_000 } as ApiHealth;
const STATUS = { markets: [], relayerLamports: "5", alerts: [] } as unknown as ApiStatus;
const DEPTH: ApiDepth = { bids: [{ px: "4000", units: "500" }], asks: [{ px: "4500", units: "700" }], at: 1_000_000 };
const TRADES: ApiTrade[] = [{ id: "5000000000000001", at: 999_000, px: "4500", units: "100", taker: "buy" }];
const HISTORY: ApiHistory = { stepSecs: 60, points: [{ at: 960_000, px: "4500" }] };

function market(symbol: string, onchain = false): ApiMarket {
  return { symbol, tradable: true, onchain: onchain ? { market: "M".repeat(44) } : null } as ApiMarket;
}

function event(ticker: string): ApiEvent {
  return { ticker, title: "BTC price today at 3am", markets: [market(SYMBOL)] } as ApiEvent;
}

function eventDetail(ticker: string): ApiEventDetail {
  return { ...event(ticker), description: "A synthetic event", source: null, termsUrl: null, rules: { [SYMBOL]: "Resolves to Yes." } };
}

function order(address: string): ApiOrder {
  return { address, user: USER, symbol: SYMBOL, units: "300" } as ApiOrder;
}

function stubs(overrides: Partial<ApiHandlers> = {}): ApiHandlers {
  return {
    health: () => HEALTH,
    events: () => [event(TICKER)],
    event: (ticker) => (ticker === TICKER ? eventDetail(ticker) : undefined),
    markets: () => [market("TEST-OLD", true)],
    market: (symbol) => (symbol === SYMBOL ? market(symbol) : undefined),
    ensureMarket: async (symbol) => market(symbol, true),
    depth: async (symbol) => (symbol === SYMBOL ? DEPTH : undefined),
    trades: async (symbol) => (symbol === SYMBOL ? TRADES : undefined),
    history: async (symbol) => (symbol === SYMBOL ? HISTORY : undefined),
    orders: (user, limit) => (user === USER ? [order(ORDER), order(`limit${limit}`)] : []),
    order: (address) => (address === ORDER ? order(address) : undefined),
    status: () => STATUS,
    ...overrides,
  };
}

const servers: ApiServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function serve(overrides: Partial<ApiHandlers> = {}, clock = { ms: 1_000_000 }) {
  const logs: string[] = [];
  const handlers = stubs(overrides);
  const server = createApiServer({ port: 0, handlers, log: (line) => logs.push(line), now: () => clock.ms });
  servers.push(server);
  const port = await server.listen();
  const call = async (method: string, path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    return { status: response.status, headers: response.headers, body: (await response.json()) as unknown };
  };
  return { call, get: (path: string) => call("GET", path), post: (path: string) => call("POST", path), logs, clock, handlers };
}

describe("routes", () => {
  it("serves JSON that is never cached, on the loopback interface only", async () => {
    const { get } = await serve();
    const response = await get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(HEALTH);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(servers[0]!.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("refuses any request a browser page sends: one with an Origin header", async () => {
    const ensureMarket = vi.fn(async (symbol: string) => market(symbol, true));
    const { call } = await serve({ ensureMarket });
    for (const origin of ["https://evil.example", "http://localhost:3000", "null"]) {
      expect(await call("GET", "/events", { Origin: origin })).toMatchObject({ status: 403, body: { error: "forbidden" } });
      expect(await call("POST", `/markets/${SYMBOL}/ensure`, { Origin: origin })).toMatchObject({ status: 403, body: { error: "forbidden" } });
    }
    expect(ensureMarket).not.toHaveBeenCalled();
    expect(await call("POST", `/markets/${SYMBOL}/ensure`)).toMatchObject({ status: 200 });
  });

  it("GET /events lists the events with their markets", async () => {
    const { get } = await serve();
    expect(await get("/events")).toMatchObject({ status: 200, body: { events: [event(TICKER)] } });
  });

  it("GET /events/:ticker returns one event in full, 404 for an unknown one, 400 for a malformed ticker", async () => {
    const { get } = await serve();
    expect(await get(`/events/${TICKER}`)).toMatchObject({ status: 200, body: eventDetail(TICKER) });
    expect(await get("/events/NOPE2611140300")).toMatchObject({ status: 404, body: { error: "unknown event" } });
    expect(await get("/events/btc15m2611140300")).toMatchObject({ status: 400, body: { error: "invalid ticker" } });
    expect(await get(`/events/${"A".repeat(65)}`)).toMatchObject({ status: 400, body: { error: "invalid ticker" } });
  });

  it("GET /markets lists the markets that exist on-chain", async () => {
    const { get } = await serve();
    expect(await get("/markets")).toMatchObject({ status: 200, body: { markets: [market("TEST-OLD", true)] } });
  });

  it("GET /markets/:symbol/depth, /trades and /history answer from the venue's market data", async () => {
    const { get } = await serve();
    expect(await get(`/markets/${SYMBOL}/depth`)).toMatchObject({ status: 200, body: DEPTH });
    expect(await get(`/markets/${SYMBOL}/trades`)).toMatchObject({ status: 200, body: { trades: TRADES } });
    expect(await get(`/markets/${SYMBOL}/history`)).toMatchObject({ status: 200, body: HISTORY });
    for (const data of ["depth", "trades", "history"]) {
      expect(await get(`/markets/TEST-NOPE/${data}`)).toMatchObject({ status: 404, body: { error: "unknown market" } });
      expect(await get(`/markets/bad_symbol/${data}`)).toMatchObject({ status: 400, body: { error: "invalid symbol" } });
    }
  });

  it("answers 500 when the venue cannot be read for market data, with the detail in the log", async () => {
    const { get, logs } = await serve({
      depth: async () => {
        throw new Error("venue said 400 for /v1/book");
      },
    });
    expect(await get(`/markets/${SYMBOL}/depth`)).toMatchObject({ status: 500, body: { error: "internal error" } });
    expect(logs).toEqual([`api GET /markets/${SYMBOL}/depth failed: venue said 400 for /v1/book`]);
  });

  it("GET /markets/:symbol returns one market, 404 for an unknown one, 400 for a malformed symbol", async () => {
    const { get } = await serve();
    expect(await get(`/markets/${SYMBOL}`)).toMatchObject({ status: 200, body: market(SYMBOL) });
    expect(await get("/markets/TEST-NOPE")).toMatchObject({ status: 404, body: { error: "unknown market" } });
    expect(await get("/markets/test-lower")).toMatchObject({ status: 400, body: { error: "invalid symbol" } });
    expect(await get(`/markets/${"A".repeat(65)}`)).toMatchObject({ status: 400, body: { error: "invalid symbol" } });
    expect(await get("/markets/%E0%A4%A")).toMatchObject({ status: 400 });
  });

  it("GET /orders lists a user's orders with a limit of 1 to 100", async () => {
    const { get } = await serve();
    expect(await get(`/orders?user=${USER}`)).toMatchObject({ status: 200, body: { orders: [order(ORDER), order("limit100")] } });
    expect((await get(`/orders?user=${USER}&limit=7`)).body).toEqual({ orders: [order(ORDER), order("limit7")] });
    expect((await get(`/orders?user=${"V".repeat(32)}`)).body).toEqual({ orders: [] });
    expect(await get("/orders")).toMatchObject({ status: 400, body: { error: "invalid user address" } });
    expect(await get("/orders?user=0OIl")).toMatchObject({ status: 400, body: { error: "invalid user address" } });
    expect(await get(`/orders?user=${"U".repeat(45)}`)).toMatchObject({ status: 400 });
    for (const limit of ["0", "101", "ten", "1.5", ""]) {
      expect(await get(`/orders?user=${USER}&limit=${limit}`)).toMatchObject({ status: 400, body: { error: "limit must be 1 to 100" } });
    }
  });

  it("GET /orders/:address returns one order, 404 for an unknown one, 400 for a malformed address", async () => {
    const { get } = await serve();
    expect(await get(`/orders/${ORDER}`)).toMatchObject({ status: 200, body: order(ORDER) });
    expect(await get(`/orders/${USER}`)).toMatchObject({ status: 404, body: { error: "unknown order" } });
    expect(await get("/orders/short")).toMatchObject({ status: 400, body: { error: "invalid order address" } });
  });

  it("GET /status returns the status", async () => {
    const { get } = await serve();
    expect(await get("/status")).toMatchObject({ status: 200, body: STATUS });
  });

  it("answers 404 for unknown paths and 405 for the wrong method", async () => {
    const { get, post, call } = await serve();
    const paths = ["/", "/nope", "/health/more", `/events/${TICKER}/markets`, `/markets/${SYMBOL}/halt`, `/markets/${SYMBOL}/toString`, `/markets/${SYMBOL}/ensure/again`, `/markets/${SYMBOL}/depth/10`, `/orders/${ORDER}/fills`];
    for (const path of paths) {
      expect(await get(path)).toMatchObject({ status: 404, body: { error: "not found" } });
    }
    const wrong = await post("/health");
    expect(wrong).toMatchObject({ status: 405, body: { error: "method not allowed" } });
    expect(wrong.headers.get("allow")).toBe("GET");
    expect(await call("DELETE", `/markets/${SYMBOL}`)).toMatchObject({ status: 405 });
    expect(await post(`/orders?user=${USER}`)).toMatchObject({ status: 405 });
    const ensure = await get(`/markets/${SYMBOL}/ensure`);
    expect(ensure.status).toBe(405);
    expect(ensure.headers.get("allow")).toBe("POST");
    for (const path of ["/events", `/events/${TICKER}`, `/markets/${SYMBOL}/depth`, `/markets/${SYMBOL}/trades`, `/markets/${SYMBOL}/history`]) {
      const posted = await post(path);
      expect(posted.status).toBe(405);
      expect(posted.headers.get("allow")).toBe("GET");
    }
  });

  it("writes BigInt values as decimal strings", async () => {
    const { get } = await serve({ health: () => ({ ...HEALTH, minOrderUnits: 12_345_678_901_234_567_890n }) as unknown as ApiHealth });
    expect((await get("/health")).body).toMatchObject({ minOrderUnits: "12345678901234567890" });
  });

  it("answers 500 with a generic message and keeps the detail in the log", async () => {
    const { get, logs } = await serve({
      status: () => {
        throw new Error("database is locked at /secret/path");
      },
    });
    expect(await get("/status")).toEqual(expect.objectContaining({ status: 500, body: { error: "internal error" } }));
    expect(logs).toEqual(["api GET /status failed: database is locked at /secret/path"]);
  });
});

describe("POST /markets/:symbol/ensure", () => {
  it("creates the market and returns it", async () => {
    const ensureMarket = vi.fn(async (symbol: string) => market(symbol, true));
    const { post } = await serve({ ensureMarket });
    expect(await post(`/markets/${SYMBOL}/ensure`)).toMatchObject({ status: 200, body: market(SYMBOL, true) });
    expect(ensureMarket).toHaveBeenCalledExactlyOnceWith(SYMBOL);
    expect(await post("/markets/bad_symbol/ensure")).toMatchObject({ status: 400, body: { error: "invalid symbol" } });
  });

  it("answers from the cached view when the market is already on-chain", async () => {
    const ensureMarket = vi.fn(async (symbol: string) => market(symbol, true));
    const { post } = await serve({ ensureMarket, market: (symbol) => market(symbol, true) });
    for (let i = 0; i < 10; i++) expect(await post(`/markets/${SYMBOL}/ensure`)).toMatchObject({ status: 200, body: market(SYMBOL, true) });
    expect(ensureMarket).not.toHaveBeenCalled();
  });

  it("maps an unknown market to 404 and a market that may not be listed to 409 with the reason", async () => {
    const refusals: Record<string, MarketError> = {
      "TEST-GONE": new MarketError("unknown", "unknown market TEST-GONE"),
      "TEST-DOGE": new MarketError("not_allowed", "market TEST-DOGE is not active at the venue"),
      "TEST-LATE": new MarketError("expired", "market TEST-LATE has expired"),
    };
    const { post } = await serve({
      market: (symbol) => (symbol === "TEST-NEVER" ? undefined : market(symbol)),
      ensureMarket: async (symbol) => {
        throw refusals[symbol] ?? new Error("rpc node said no: http://rpc.example.test/?key=abc");
      },
    });
    expect(await post("/markets/TEST-NEVER/ensure")).toMatchObject({ status: 404, body: { error: "unknown market" } });
    expect(await post("/markets/TEST-GONE/ensure")).toMatchObject({ status: 404, body: { error: "unknown market" } });
    expect(await post("/markets/TEST-DOGE/ensure")).toMatchObject({ status: 409, body: { error: "market TEST-DOGE is not active at the venue" } });
    expect(await post("/markets/TEST-LATE/ensure")).toMatchObject({ status: 409, body: { error: "market TEST-LATE has expired" } });
    expect(await post("/markets/TEST-BOOM/ensure")).toMatchObject({ status: 500, body: { error: "internal error" } });
  });

  it("allows six calls a minute over all symbols", async () => {
    const ensureMarket = vi.fn(async (symbol: string) => market(symbol, true));
    const { post, clock } = await serve({ ensureMarket, market: (symbol) => market(symbol) });
    for (let i = 0; i < 6; i++) {
      clock.ms += 1_000;
      expect((await post(`/markets/TEST-M${i}/ensure`)).status).toBe(200);
    }
    const refused = await post("/markets/TEST-M7/ensure");
    expect(refused).toMatchObject({ status: 429, body: { error: "too many market creations, try again shortly" } });
    expect(refused.headers.get("retry-after")).toBe("55");
    expect(ensureMarket).toHaveBeenCalledTimes(6);

    clock.ms += 54_999;
    expect((await post("/markets/TEST-M7/ensure")).status).toBe(429);
    clock.ms += 1;
    expect((await post("/markets/TEST-M7/ensure")).status).toBe(200);
  });
});

describe("handlers over the relayer's parts", () => {
  it("builds an order with its fills from the journal, numbers as strings, and passes the rest on", async () => {
    const journal = openJournal(":memory:");
    try {
      journal.recordSeen({
        orderAddress: ORDER,
        clientOrderId: "o-0123",
        user: USER,
        kind: "buy",
        side: "YES",
        symbol: SYMBOL,
        units: 300n,
        limitPx: 4_500n,
        maxFeeMicros: 60_000n,
        expiresAt: 1_800_000_090,
      });
      journal.markSubmitting(ORDER);
      journal.recordVenueResult(ORDER, {
        kind: "filled",
        venueOrderId: "730000000000000001",
        fills: [
          { tradeId: "5000000000000001", units: 100n, px: 4_400n, feeMicros: 20_000n, feeSource: "reported" },
          { tradeId: "5000000000000002", units: 200n, px: 4_500n, feeMicros: 40_000n, feeSource: "reported" },
        ],
        filledUnits: 300n,
        costMicros: 1_340_000n,
        feeMicros: 60_000n,
      });
      journal.markChain(ORDER, "chain_filled", { signature: "sig-1" });

      const handlers = createApiHandlers({
        daemon: { health: () => HEALTH, status: () => STATUS },
        manager: {
          eventViews: () => [event(TICKER)],
          eventView: (ticker) => (ticker === TICKER ? eventDetail(ticker) : undefined),
          views: () => [market(SYMBOL, true)],
          view: (symbol) => (symbol === SYMBOL ? market(symbol) : undefined),
          ensureOnchain: async (symbol) => market(symbol, true),
        },
        marketData: { depth: async () => DEPTH, trades: async () => TRADES, history: async () => undefined },
        journal,
      });
      const expected = {
        address: ORDER,
        user: USER,
        symbol: SYMBOL,
        kind: "buy",
        side: "YES",
        units: "300",
        limitPx: "4500",
        maxFeeMicros: "60000",
        expiresAt: 1_800_000_090,
        state: "chain_filled",
        venueOrderId: "730000000000000001",
        filledUnits: "300",
        amountMicros: "1340000",
        feeMicros: "60000",
        fills: [
          { tradeId: "5000000000000001", units: "100", px: "4400", feeMicros: "20000" },
          { tradeId: "5000000000000002", units: "200", px: "4500", feeMicros: "40000" },
        ],
        chainSignature: "sig-1",
        detail: null,
      };
      expect(handlers.order(ORDER)).toMatchObject(expected);
      expect(handlers.order(ORDER)).toEqual(toApiOrder(journal.get(ORDER)!, journal.fills(ORDER)));
      expect(handlers.orders(USER, 100)).toMatchObject([expected]);
      expect(handlers.orders("V".repeat(44), 100)).toEqual([]);
      expect(handlers.order("x".repeat(40))).toBeUndefined();
      expect(handlers.health()).toBe(HEALTH);
      expect(handlers.status()).toBe(STATUS);
      expect(handlers.events()).toEqual([event(TICKER)]);
      expect(handlers.event(TICKER)).toEqual(eventDetail(TICKER));
      expect(handlers.event("NOPE")).toBeUndefined();
      expect(handlers.markets()).toEqual([market(SYMBOL, true)]);
      expect(handlers.market(SYMBOL)).toEqual(market(SYMBOL));
      expect(await handlers.ensureMarket(SYMBOL)).toEqual(market(SYMBOL, true));
      expect(await handlers.depth(SYMBOL)).toBe(DEPTH);
      expect(await handlers.trades(SYMBOL)).toBe(TRADES);
      expect(await handlers.history(SYMBOL)).toBeUndefined();
    } finally {
      journal.close();
    }
  });
});
