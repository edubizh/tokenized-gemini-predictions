import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureMarket, getDepth, getEvent, getEvents, getHealth, getHistory, getMarket, getMarkets, getOrder, getOrders, getStatus, getTrades, RelayerError } from "./client";
import { matchRoute } from "./proxy";

const SYMBOL = "GEMI-BTC2611142300-HI64500";
const TICKER = "BTC2611142300";
const WALLET = "8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn";

/** Stands in for the app server: records each request and answers with what the test queued. */
function server(...answers: Array<{ status?: number; body: unknown } | Error>) {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? "GET", authorization: new Headers(init.headers).get("authorization") });
    const answer = answers.shift() ?? { body: {} };
    if (answer instanceof Error) throw answer;
    return Response.json(answer.body, { status: answer.status ?? 200 });
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("the relayer client", () => {
  it("has one function per route, each asking the proxy for a path the proxy allows", async () => {
    const requests = server(
      { body: { ok: true } },
      { body: { events: [{ ticker: TICKER }] } },
      { body: { ticker: TICKER } },
      { body: { markets: [{ symbol: SYMBOL }] } },
      { body: { symbol: SYMBOL } },
      { body: { symbol: SYMBOL } },
      { body: { bids: [], asks: [], at: 1 } },
      { body: { trades: [{ id: "1" }] } },
      { body: { stepSecs: 60, points: [] } },
      { body: { orders: [{ address: WALLET }] } },
      { body: { address: WALLET } },
      { body: { markets: [] } },
    );
    expect(await getHealth()).toEqual({ ok: true });
    expect(await getEvents()).toEqual([{ ticker: TICKER }]);
    expect(await getEvent(TICKER)).toEqual({ ticker: TICKER });
    expect(await getMarkets()).toEqual([{ symbol: SYMBOL }]);
    expect(await getMarket(SYMBOL)).toEqual({ symbol: SYMBOL });
    expect(await ensureMarket(SYMBOL, "token")).toEqual({ symbol: SYMBOL });
    expect(await getDepth(SYMBOL)).toEqual({ bids: [], asks: [], at: 1 });
    expect(await getTrades(SYMBOL)).toEqual([{ id: "1" }]);
    expect(await getHistory(SYMBOL)).toEqual({ stepSecs: 60, points: [] });
    expect(await getOrders(WALLET)).toEqual([{ address: WALLET }]);
    expect(await getOrder(WALLET)).toEqual({ address: WALLET });
    expect(await getStatus()).toEqual({ markets: [] });

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/relayer/health",
      "GET /api/relayer/events",
      `GET /api/relayer/events/${TICKER}`,
      "GET /api/relayer/markets",
      `GET /api/relayer/markets/${SYMBOL}`,
      `POST /api/relayer/markets/${SYMBOL}/ensure`,
      `GET /api/relayer/markets/${SYMBOL}/depth`,
      `GET /api/relayer/markets/${SYMBOL}/trades`,
      `GET /api/relayer/markets/${SYMBOL}/history`,
      `GET /api/relayer/orders?user=${WALLET}`,
      `GET /api/relayer/orders/${WALLET}`,
      "GET /api/relayer/status",
    ]);
    for (const request of requests) {
      const [path = "", search = ""] = request.url.slice("/api/relayer/".length).split("?");
      expect(matchRoute(request.method, path.split("/"), search), request.url).not.toBeNull();
    }
  });

  it("sends the login token only when it asks for a market to be created on-chain", async () => {
    const requests = server({ body: {} }, { body: { events: [] } });
    await ensureMarket(SYMBOL, "login-token");
    await getEvents();
    expect(requests.map((request) => request.authorization)).toEqual(["Bearer login-token", null]);
  });

  it("gives null for what the relayer does not know", async () => {
    const unknown = { status: 404, body: { error: "unknown" } };
    server(unknown, unknown, unknown, unknown, unknown, unknown);
    expect(await getEvent(TICKER)).toBeNull();
    expect(await getMarket(SYMBOL)).toBeNull();
    expect(await getDepth(SYMBOL)).toBeNull();
    expect(await getTrades(SYMBOL)).toBeNull();
    expect(await getHistory(SYMBOL)).toBeNull();
    expect(await getOrder(WALLET)).toBeNull();
  });

  it("throws the relayer's own words, and knows when the relayer could not be reached", async () => {
    server({ status: 401, body: { error: "unauthorized" } }, { status: 502, body: { error: "relayer_unreachable" } }, new TypeError("network down"), { status: 500, body: "not json" });
    await expect(ensureMarket(SYMBOL, "")).rejects.toMatchObject({ name: "RelayerError", status: 401, message: "unauthorized", offline: false });
    await expect(getEvents()).rejects.toMatchObject({ status: 502, offline: true });
    await expect(getEvents()).rejects.toMatchObject({ status: 0, offline: true, message: "The app server did not answer." });
    const failure = await getStatus().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayerError);
    expect((failure as RelayerError).message).toBe("HTTP 500");
  });
});
