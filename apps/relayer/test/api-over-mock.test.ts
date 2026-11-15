import { afterEach, describe, expect, it } from "vitest";
import { createMarketData } from "../src/api/market-data.ts";
import { createApiHandlers, createApiServer } from "../src/api/server.ts";
import type { ApiDepth, ApiEvent, ApiEventDetail, ApiHealth, ApiHistory, ApiMarket, ApiStatus, ApiTrade } from "../src/api/types.ts";
import { openJournal } from "../src/journal.ts";
import { createMarketManager } from "../src/markets.ts";
import { openRegistry } from "../src/registry.ts";
import { RollingMockVenue } from "../src/venue/mock-feed.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// The whole read side over HTTP: the simulated venue's rolling contracts through the registry,
// the manager's views and the market data, as a client of the API sees them.
const NOW = Date.parse("2026-11-14T02:50:00Z");
const END = Date.parse("2026-11-14T03:00:00Z");
const BTC = "TEST-BTC15M2611140300-UP";
const TICKER = "BTC15M2611140300";

// The keys of each shape in `api/types.ts`.
const MARKET_KEYS = [
  "book",
  "eventTicker",
  "expiresAt",
  "label",
  "lastOrderAt",
  "lastPx",
  "marketState",
  "minUnits",
  "notTradableReason",
  "onchain",
  "resolution",
  "settleState",
  "settlementValue",
  "sortOrder",
  "startsAt",
  "strike",
  "symbol",
  "tickPx",
  "title",
  "tradable",
  "unitIncrement",
  "venueStatus",
];
const EVENT_KEYS = ["cadence", "category", "expiresAt", "listedAt", "markets", "shape", "subcategory", "ticker", "title", "underlying", "venueStatus", "volumeUnits"];
const DETAIL_KEYS = [...EVENT_KEYS, "description", "rules", "source", "termsUrl"].sort();
const keys = (value: object) => Object.keys(value).sort();

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

async function relayer() {
  const clock = { ms: NOW };
  const now = () => clock.ms;
  const venue = new RollingMockVenue({ windowSecs: 900, resolve: "yes", now, random: () => 0.5 });
  const chain = new FakeMarketChain();
  const registry = openRegistry(":memory:");
  const journal = openJournal(":memory:");
  const manager = createMarketManager({ venue, chain, registry, now });
  const handlers = createApiHandlers({
    daemon: { health: () => ({ ok: true }) as ApiHealth, status: () => ({ markets: [] }) as unknown as ApiStatus },
    manager,
    marketData: createMarketData({ venue, registry, now }),
    journal,
  });
  const server = createApiServer({ port: 0, handlers, now });
  closers.push(() => server.close(), () => registry.close(), () => journal.close());
  const port = await server.listen();
  const call = async <T>(method: "GET" | "POST", path: string): Promise<{ status: number; body: T }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    return { status: response.status, body: (await response.json()) as T };
  };
  await manager.refresh();
  return { clock, venue, manager, get: <T>(path: string) => call<T>("GET", path), post: <T>(path: string) => call<T>("POST", path) };
}

describe("the API over the simulated venue", () => {
  it("lists the events with their contracts, and one event in full", async () => {
    const { get } = await relayer();
    const { status, body } = await get<{ events: ApiEvent[] }>("/events");
    expect(status).toBe(200);
    expect(body.events.map((event) => event.ticker)).toEqual([TICKER, "ETH15M2611140300", "SOL15M2611140300"]);
    const [event] = body.events;
    expect(keys(event!)).toEqual(EVENT_KEYS);
    expect(event).toMatchObject({
      title: "BTC price up at 03:00 UTC? (test)",
      category: "Crypto",
      subcategory: ["Bitcoin"],
      underlying: "BTC",
      shape: "binary",
      cadence: "15m",
      listedAt: END - 900_000,
      expiresAt: END,
      venueStatus: "active",
      volumeUnits: "0",
    });
    expect(event!.markets).toHaveLength(1);
    const market = event!.markets[0]!;
    expect(keys(market)).toEqual(MARKET_KEYS);
    expect(market).toMatchObject({
      symbol: BTC,
      eventTicker: TICKER,
      title: "BTC price up at 03:00 UTC? (test)",
      label: "Up",
      sortOrder: 0,
      startsAt: END - 900_000,
      expiresAt: END,
      lastOrderAt: END - 150_000,
      venueStatus: "active",
      marketState: "open",
      tradable: true,
      notTradableReason: null,
      tickPx: "100",
      minUnits: "1",
      unitIncrement: "1",
      book: { bidPx: "4800", bidUnits: "20000", askPx: "5200", askUnits: "20000", at: NOW },
      lastPx: null,
      onchain: null,
      resolution: null,
      settlementValue: null,
      settleState: "open",
    });
    expect(market.strike).toMatch(/^\d+\.\d{2}$/);

    const detail = await get<ApiEventDetail>(`/events/${TICKER}`);
    expect(detail.status).toBe(200);
    expect(keys(detail.body)).toEqual(DETAIL_KEYS);
    expect(detail.body).toMatchObject({ ...event, description: "Simulated Bitcoin up-or-down event expiring at 03:00 UTC", source: null, termsUrl: null });
    expect(detail.body.rules).toEqual({ [BTC]: `If the simulated price of Bitcoin (BTC) at 03:00 UTC is above $${market.strike}, this market resolves to Yes.` });
    expect(await get("/events/BTC15M2611140315")).toMatchObject({ status: 404, body: { error: "unknown event" } });
  });

  it("creates a market on request, then lists it with its on-chain state and serves its market data", async () => {
    const { get, post, venue, manager, clock } = await relayer();
    expect((await get<{ markets: ApiMarket[] }>("/markets")).body).toEqual({ markets: [] });
    expect(await get(`/markets/${BTC}/depth`)).toMatchObject({ status: 200, body: { bids: [{ px: "4800", units: "20000" }], asks: [{ px: "5200", units: "20000" }], at: NOW } });

    const created = await post<ApiMarket>(`/markets/${BTC}/ensure`);
    expect(created.status).toBe(200);
    expect(keys(created.body)).toEqual(MARKET_KEYS);
    expect(created.body.onchain).toEqual({
      market: `market:${BTC}`,
      yesMint: `yes:${BTC}`,
      noMint: `no:${BTC}`,
      status: "open",
      closeTs: END / 1000,
      placeCutoffSecs: 150,
      yesSupply: "0",
      noSupply: "0",
      yesPayout: null,
      noPayout: null,
      redeemAfter: null,
    });
    expect((await get<{ markets: ApiMarket[] }>("/markets")).body.markets).toEqual([created.body]);
    expect((await get<ApiMarket>(`/markets/${BTC}`)).body).toEqual(created.body);

    // A buy at the venue shows up in the tape, the history, the last price and the volume.
    clock.ms += 20_000;
    const bought = await venue.placeOrder({ clientOrderId: "a", symbol: BTC, outcome: "YES", units: 300n, limitPx: 5_200n, timeInForce: "FOK" });
    if (bought.kind !== "filled") throw new Error(`expected a fill, got ${bought.kind}`);
    await manager.refresh();
    expect((await get<ApiDepth>(`/markets/${BTC}/depth`)).body).toEqual({ bids: [{ px: "4800", units: "20000" }], asks: [{ px: "5200", units: "20000" }], at: NOW + 20_000 });
    expect((await get<{ trades: ApiTrade[] }>(`/markets/${BTC}/trades`)).body).toEqual({
      trades: [{ id: bought.fills[0]!.tradeId, at: NOW + 20_000, px: "5200", units: "300", taker: "buy" }],
    });
    expect((await get<ApiHistory>(`/markets/${BTC}/history`)).body).toEqual({ stepSecs: 60, points: [{ at: NOW, px: "5200" }] });
    expect((await get<ApiMarket>(`/markets/${BTC}`)).body).toMatchObject({ lastPx: "5200", book: { askPx: "5200", askUnits: "20000", at: NOW + 20_000 } });
    expect((await get<ApiEventDetail>(`/events/${TICKER}`)).body.volumeUnits).toBe("300");

    for (const data of ["depth", "trades", "history"]) {
      expect(await get(`/markets/TEST-BTC15M2611140315-UP/${data}`)).toMatchObject({ status: 404, body: { error: "unknown market" } });
    }
  });

  it("drops an event from the list when it expires and keeps it readable by its ticker", async () => {
    const { get, clock, manager } = await relayer();
    clock.ms = END + 10_000;
    await manager.refresh();
    const { events } = (await get<{ events: ApiEvent[] }>("/events")).body;
    expect(events.map((event) => event.ticker)).toEqual(["BTC15M2611140315", "ETH15M2611140315", "SOL15M2611140315"]);
    const expired = (await get<ApiEventDetail>(`/events/${TICKER}`)).body;
    expect(expired.markets[0]).toMatchObject({ symbol: BTC, tradable: false, notTradableReason: "too_close_to_expiry", onchain: null });
    expect(await get(`/markets/${BTC}/depth`)).toMatchObject({ status: 200, body: { bids: [], asks: [] } });
  });
});
