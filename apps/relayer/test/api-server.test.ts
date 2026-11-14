import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandlers, createApiServer, toApiOrder } from "../src/api/server.ts";
import type { ApiHandlers, ApiServer } from "../src/api/server.ts";
import type { ApiHealth, ApiMarket, ApiOrder, ApiStatus } from "../src/api/types.ts";
import { openJournal } from "../src/journal.ts";
import { MarketError } from "../src/markets.ts";

const SYMBOL = "TEST-BTC15M2611140300-UP";
// Synthetic addresses: valid base58 text, not real accounts.
const USER = "U".repeat(44);
const ORDER = "o".repeat(32);

const HEALTH = { ok: true, cluster: "localnet", venue: "mock", chainTime: 1_800_000_000 } as ApiHealth;
const STATUS = { markets: [], relayerLamports: "5", alerts: [] } as unknown as ApiStatus;

function market(symbol: string, onchain = false): ApiMarket {
  return { symbol, tradable: true, onchain: onchain ? { market: "M".repeat(44) } : null } as ApiMarket;
}

function order(address: string): ApiOrder {
  return { address, user: USER, symbol: SYMBOL, units: "300" } as ApiOrder;
}

function stubs(overrides: Partial<ApiHandlers> = {}): ApiHandlers {
  return {
    health: () => HEALTH,
    markets: (scope) => [market(scope === "live" ? SYMBOL : "TEST-OLD")],
    market: (symbol) => (symbol === SYMBOL ? market(symbol) : undefined),
    ensureMarket: async (symbol) => market(symbol, true),
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
  const call = async (method: string, path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
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

  it("GET /markets lists the live markets by default, or all of them", async () => {
    const { get } = await serve();
    expect((await get("/markets")).body).toEqual({ markets: [market(SYMBOL)] });
    expect((await get("/markets?scope=live")).body).toEqual({ markets: [market(SYMBOL)] });
    expect((await get("/markets?scope=all")).body).toEqual({ markets: [market("TEST-OLD")] });
    expect(await get("/markets?scope=everything")).toMatchObject({ status: 400, body: { error: "scope must be live or all" } });
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
    for (const path of ["/", "/nope", "/health/more", `/markets/${SYMBOL}/halt`, `/markets/${SYMBOL}/ensure/again`, `/orders/${ORDER}/fills`]) {
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
      "TEST-DOGE": new MarketError("not_allowed", "series DOGE15M is not offered"),
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
    expect(await post("/markets/TEST-DOGE/ensure")).toMatchObject({ status: 409, body: { error: "series DOGE15M is not offered" } });
    expect(await post("/markets/TEST-LATE/ensure")).toMatchObject({ status: 409, body: { error: "market TEST-LATE has expired" } });
    expect(await post("/markets/TEST-BOOM/ensure")).toMatchObject({ status: 500, body: { error: "internal error" } });
  });

  it("shares one call between concurrent requests for a symbol", async () => {
    let release: (value: ApiMarket) => void = () => {};
    const ensureMarket = vi.fn(() => new Promise<ApiMarket>((resolve) => (release = resolve)));
    const { post } = await serve({ ensureMarket });
    const first = post(`/markets/${SYMBOL}/ensure`);
    await vi.waitFor(() => expect(ensureMarket).toHaveBeenCalledTimes(1));
    const second = post(`/markets/${SYMBOL}/ensure`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    release(market(SYMBOL, true));
    expect((await first).status).toBe(200);
    expect(await second).toMatchObject({ status: 200, body: market(SYMBOL, true) });
    expect(ensureMarket).toHaveBeenCalledTimes(1);
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
  it("builds an order with its fills from the journal, numbers as strings", () => {
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
        manager: { views: () => [], view: () => undefined, ensureOnchain: async (symbol) => market(symbol, true) },
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
    } finally {
      journal.close();
    }
  });
});
