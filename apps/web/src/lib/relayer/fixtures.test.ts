import { describe, expect, it } from "vitest";
import type { ApiEventDetail, ApiMarket } from "@outcome/relayer/api-types";
import {
  fixtureChainMarket,
  fixtureDepth,
  fixtureEvent,
  fixtureEvents,
  fixtureHealth,
  fixtureHistory,
  fixtureHoldings,
  fixtureMarket,
  fixtureOnchainMarkets,
  fixtureOrders,
  fixtureStatus,
  fixtureTrades,
} from "./fixtures";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A Saturday. The short series expire at 22:09 (XRP), 22:10, 22:11, 22:12 and 22:13 (the hourly ladder).
const NOW = Date.UTC(2026, 10, 14, 22, 8, 30);

const events = fixtureEvents(NOW);
const byTicker = (ticker: string) => events.find((event) => event.ticker === ticker) as ApiEventDetail;
const hourly = byTicker("BTC2611142213");
const daily = byTicker("ETH2611152200");
const gold = byTicker("XAU2611152200");
const weekly = byTicker("SOL2611202200");
const nextWeekly = byTicker("SOL2611272200");
const quoted = (market: ApiMarket) => market.book !== null && (market.book.bidPx !== null || market.book.askPx !== null);

describe("the fixture events", () => {
  it("are the same for the same time", () => {
    expect(fixtureEvents(NOW)).toEqual(events);
    expect(fixtureEvents(NOW + SECOND)).not.toEqual(events);
  });

  it("show the venue's variety: both shapes, every cadence it quotes, two categories", () => {
    expect(events.map((event) => `${event.ticker} ${event.shape} ${event.cadence} ${event.category}`)).toEqual([
      "XRP15M2611142209 binary 15m Crypto",
      "BTC05M2611142210 binary 5m Crypto",
      "SOL05M2611142210 binary 5m Crypto",
      "BTC15M2611142211 binary 15m Crypto",
      "ETH15M2611142212 binary 15m Crypto",
      "BTC2611142213 ladder hourly Crypto",
      "BTC05M2611142215 binary 5m Crypto",
      "ETH2611152200 ladder daily Crypto",
      "XAU2611152200 ladder daily Commodities",
      "SOL2611202200 ladder weekly Crypto",
      "SOL2611272200 ladder weekly Crypto",
    ]);
    expect(gold.subcategory).toEqual(["Precious Metals", "Gold"]);
    expect(new Set(events.map((event) => event.underlying))).toEqual(new Set(["BTC", "ETH", "SOL", "XRP", "XAU"]));
  });

  it("are listed, not expired, and come soonest expiry first", () => {
    for (const event of events) {
      expect(event.listedAt, event.ticker).toBeLessThanOrEqual(NOW);
      expect(event.expiresAt, event.ticker).toBeGreaterThan(NOW);
    }
    expect(events.map((event) => event.expiresAt)).toEqual([...events.map((event) => event.expiresAt)].sort((a, b) => a - b));
  });

  it("group their contracts: one Up contract for an up-or-down event, a ladder of strikes otherwise", () => {
    for (const event of events) {
      expect(event.markets.map((market) => market.eventTicker)).toEqual(event.markets.map(() => event.ticker));
      expect(event.markets.map((market) => market.title)).toEqual(event.markets.map(() => event.title));
      expect(event.markets.map((market) => market.sortOrder)).toEqual(event.markets.map((_, index) => index));
      expect(Object.keys(event.rules)).toEqual(event.markets.map((market) => market.symbol));
      if (event.shape === "binary") expect(event.markets.map((market) => [market.symbol, market.label])).toEqual([[`GEMI-${event.ticker}-UP`, "Up"]]);
      else expect(event.markets.length).toBeGreaterThanOrEqual(5);
    }
    expect(hourly.markets.map((market) => market.label)).toEqual([
      "$103,900 or above", "$104,000 or above", "$104,100 or above", "$104,200 or above", "$104,300 or above", "$104,400 or above", "$104,500 or above", "$104,600 or above",
    ]);
    expect(hourly.markets[2]).toMatchObject({ symbol: "GEMI-BTC2611142213-HI104100", strike: "104100" });
  });

  it("word their titles and rules as the venue does, in US Eastern time", () => {
    expect(hourly.title).toBe("BTC price today at 5:13pm EST");
    expect(byTicker("BTC05M2611142210").title).toBe("BTC price today at 5:10pm EST");
    expect(daily.title).toBe("ETH price on November 15");
    expect(gold.title).toBe("Gold price on November 15?");
    expect(hourly.description).toBe("Interval BTC price prediction event expiring on November 14, 2026 at 5:13pm ET");
    expect(hourly.rules["GEMI-BTC2611142213-HI104100"]).toBe(
      "If the price of Bitcoin (BTC) is $104,100 or above on November 14, 2026 at 5:13pm ET, this market will resolve to Yes. Otherwise, it will resolve to No. Outcome verified against the RR-BTCUSD-60S index.",
    );
    expect(hourly.source).toEqual({ agency: "reference-rates", index: "RR-BTCUSD-60S" });
    expect(hourly.termsUrl).toBe("https://example.com/terms/btc.pdf");
    // The venue names no source and no terms for some events.
    expect(weekly).toMatchObject({ source: null, termsUrl: null });
  });
});

describe("the fixture quotes", () => {
  it("quote every strike of the hourly ladder on both sides, with the chance falling as the strike rises", () => {
    expect(hourly.markets.every((market) => market.tradable && market.book?.bidPx != null && market.book.askPx != null)).toBe(true);
    const asks = hourly.markets.map((market) => Number(market.book?.askPx));
    expect(asks).toEqual([...asks].sort((a, b) => b - a));
    expect(hourly.markets[3]?.book).toMatchObject({ bidPx: "5200", bidUnits: "2500", askPx: "5600", askUnits: "1800" });
    expect(BigInt(hourly.volumeUnits)).toBeGreaterThan(0n);
  });

  it("quote some strikes of the daily ladder, and keep the last trade of one nobody quotes now", () => {
    expect(daily.markets.map(quoted)).toEqual([false, true, true, true, false, false]);
    expect(daily.markets.map((market) => market.tradable)).toEqual([false, true, true, true, false, false]);
    expect(daily.markets[0]).toMatchObject({ lastPx: "9200", notTradableReason: "no_offers", book: { bidPx: null, askPx: null } });
    expect(daily.markets[4]).toMatchObject({ lastPx: null, notTradableReason: "no_offers" });
  });

  it("have no offer at all on the commodity ladder, which never traded", () => {
    expect(gold.markets).toHaveLength(5);
    for (const market of gold.markets) expect(market).toMatchObject({ tradable: false, notTradableReason: "no_offers", venueStatus: "active", marketState: "open", lastPx: null, book: { bidPx: null, bidUnits: "0", askPx: null, askUnits: "0" } });
    expect(gold.volumeUnits).toBe("0");
  });

  it("have a bid and no ask on one strike of the weekly ladder", () => {
    expect(weekly.markets.map(quoted)).toEqual([false, false, false, true, false]);
    expect(weekly.markets[3]).toMatchObject({ tradable: true, lastPx: null, book: { bidPx: "200", askPx: null, askUnits: "0" } });
  });

  it("list the next weekly ladder before it trades", () => {
    expect(nextWeekly.venueStatus).toBe("approved");
    expect(nextWeekly.markets[0]?.startsAt).toBeGreaterThan(NOW);
    for (const market of nextWeekly.markets) expect(market).toMatchObject({ venueStatus: "approved", marketState: "post_only", tradable: false, notTradableReason: "not_active", book: null, lastPx: null });
    expect(nextWeekly.volumeUnits).toBe("0");
  });

  it("list the next five-minute event before its window opens, without a price to beat", () => {
    const [running] = byTicker("BTC05M2611142210").markets;
    const [next] = byTicker("BTC05M2611142215").markets;
    expect(running).toMatchObject({ strike: "104188.4", tradable: true, book: { bidPx: "4600", askPx: "4900" } });
    expect(next).toMatchObject({ strike: null, venueStatus: "active", marketState: "open", tradable: false, notTradableReason: "not_started", startsAt: Date.UTC(2026, 10, 14, 22, 10), book: { bidPx: null, askPx: null } });
  });

  it("never quote one of the five-minute contracts, and stop taking orders a minute before expiry", () => {
    expect(byTicker("SOL05M2611142210").markets[0]).toMatchObject({ strike: "187.9104166667", tradable: false, notTradableReason: "no_offers" });
    const [closing] = byTicker("XRP15M2611142209").markets;
    expect(closing).toMatchObject({ tradable: false, notTradableReason: "too_close_to_expiry", lastOrderAt: Date.UTC(2026, 10, 14, 22, 8), book: { bidPx: "6100", askPx: "6400" } });
  });

  it("always leave something to trade: the short series close a minute apart", () => {
    for (let second = 0; second < 300; second += 7) {
      const at = NOW + second * SECOND;
      const tradable = fixtureEvents(at).filter((event) => event.markets.some((market) => market.tradable));
      expect(tradable.filter((event) => event.shape === "binary").length, `binary at +${second}s`).toBeGreaterThanOrEqual(1);
      expect(tradable.some((event) => event.shape === "ladder" && event.markets.some((market) => market.tradable && market.book?.askPx != null)), `ladder at +${second}s`).toBe(true);
    }
  });
});

describe("the life of a fixture event", () => {
  const EXPIRY = Date.UTC(2026, 10, 14, 22, 13);
  const at = (nowMs: number) => fixtureEvent("BTC2611142213", nowMs) as ApiEventDetail;

  it("is still answered by its ticker after it has left the list", () => {
    expect(fixtureEvents(EXPIRY).map((event) => event.ticker)).not.toContain("BTC2611142213");
    expect(at(EXPIRY).markets.map((market) => [market.venueStatus, market.marketState, market.tradable, market.notTradableReason, market.book])).toEqual(
      hourly.markets.map(() => ["under_review", "closed", false, "market_not_open", null]),
    );
    expect(at(EXPIRY + 3 * DAY).venueStatus).toBe("settled");
  });

  it("awaits its result, then settles every contract by itself: several strikes of a ladder resolve Yes", () => {
    const waiting = at(EXPIRY + 7 * SECOND);
    expect(waiting.venueStatus).toBe("under_review");
    expect(waiting.markets.every((market) => market.resolution === null && market.settlementValue === null)).toBe(true);

    const settled = at(EXPIRY + 8 * SECOND);
    expect(settled.venueStatus).toBe("settled");
    expect(settled.markets.map((market) => market.resolution)).toEqual(["yes", "yes", "yes", "yes", "no", "no", "no", "no"]);
    expect(new Set(settled.markets.map((market) => market.settlementValue))).toEqual(new Set(["104212.5"]));
    for (const market of settled.markets) expect(Number(market.settlementValue) >= Number(market.strike)).toBe(market.resolution === "yes");
  });

  it("is settled on Solana a moment after the result, and opens redemption a while later", () => {
    const market = (nowMs: number) => at(nowMs).markets[2] as ApiMarket;
    expect(market(NOW)).toMatchObject({ settleState: "open", onchain: { status: "open", yesPayout: null, noPayout: null, redeemAfter: null, closeTs: EXPIRY / SECOND, yesSupply: "1250", noSupply: "400" } });
    expect(market(EXPIRY + 9 * SECOND)).toMatchObject({ resolution: "yes", settleState: "awaiting_result", onchain: { status: "open", redeemAfter: null } });
    expect(market(EXPIRY + 12 * SECOND)).toMatchObject({ settleState: "settled", onchain: { status: "settled", yesPayout: "10000", noPayout: "0", redeemAfter: EXPIRY / SECOND + 12 + 90 } });
    expect(at(EXPIRY + 12 * SECOND).markets[5]?.onchain).toMatchObject({ status: "settled", yesPayout: "0", noPayout: "10000" });
    // A contract that was never created on-chain has nothing to settle there.
    expect(at(EXPIRY + 12 * SECOND).markets[0]).toMatchObject({ onchain: null, settleState: "unused", resolution: "yes" });
  });

  it("resolves successive up-or-down events differently, each from its own closing value", () => {
    const outcome = (ticker: string) => (fixtureEvent(ticker, NOW + HOUR) as ApiEventDetail).markets[0] as ApiMarket;
    const [first, second] = [outcome("BTC15M2611142211"), outcome("BTC15M2611142216")];
    expect([first.resolution, second.resolution].sort()).toEqual(["no", "yes"]);
    for (const market of [first, second]) expect(Number(market.settlementValue) >= Number(market.strike)).toBe(market.resolution === "yes");
  });

  it("keeps one event awaiting its result at any time: the venue is slow with one series", () => {
    for (let second = 0; second < 300; second += 11) {
      const nowMs = NOW + second * SECOND;
      const awaiting = fixtureOnchainMarkets(nowMs).filter((market) => market.settleState === "awaiting_result" && market.resolution === null);
      expect(awaiting.map((market) => market.symbol.slice(5, 11)), `at +${second}s`).toContain("XRP15M");
    }
    expect(fixtureMarket("GEMI-XRP15M2611142204-UP", NOW)).toMatchObject({ venueStatus: "under_review", resolution: null, settleState: "awaiting_result", onchain: { status: "open" } });
  });

  it("knows only the tickers its series list", () => {
    expect(fixtureEvent("DOGE2611142213", NOW)).toBeNull();
    expect(fixtureEvent("BTC2611142214", NOW)).toBeNull();
    expect(fixtureEvent("BTC2613142213", NOW)).toBeNull();
    expect(fixtureEvent("BTC", NOW)).toBeNull();
    // Not listed yet: the hourly ladder is listed two hours before it expires.
    expect(fixtureEvent("BTC2611150013", NOW)).toBeNull();
    expect(fixtureEvent("BTC2611150008", NOW)?.venueStatus).toBe("approved");
  });
});

describe("the fixture markets", () => {
  it("are found by symbol", () => {
    expect(fixtureMarket("GEMI-BTC2611142213-HI104100", NOW)).toEqual(hourly.markets[2]);
    expect(fixtureMarket("GEMI-BTC2611142213-HI999", NOW)).toBeNull();
    expect(fixtureMarket("GEMI-BTC2611142213-UP", NOW)).toBeNull();
    expect(fixtureMarket("GEMI-NOPE", NOW)).toBeNull();
  });

  it("exist on-chain for a few contracts from the start, in the listed events and in the one that expired last", () => {
    const onchain = fixtureOnchainMarkets(NOW);
    expect(onchain.map((market) => market.symbol)).toEqual([
      "GEMI-BTC2611142213-HI104100",
      "GEMI-BTC2611142213-HI104400",
      "GEMI-BTC15M2611142211-UP",
      "GEMI-XRP15M2611142209-UP",
      "GEMI-BTC2611142208-HI104100",
      "GEMI-BTC2611142208-HI104400",
      "GEMI-BTC15M2611142206-UP",
      "GEMI-XRP15M2611142204-UP",
    ]);
    expect(onchain.every((market) => market.onchain !== null)).toBe(true);
    expect(events.flatMap((event) => event.markets).filter((market) => market.onchain !== null).map((market) => market.symbol).sort()).toEqual(onchain.slice(0, 4).map((market) => market.symbol).sort());
  });

  it("exist on-chain once created, wherever they are listed", () => {
    const symbol = "GEMI-ETH15M2611142212-UP";
    expect(fixtureMarket(symbol, NOW)?.onchain).toBeNull();
    const created = new Set([symbol, "GEMI-NOPE"]);
    expect(fixtureMarket(symbol, NOW, created)?.onchain).toMatchObject({ status: "open", yesSupply: "0", noSupply: "0" });
    expect(fixtureEvents(NOW, created).find((event) => event.ticker === "ETH15M2611142212")?.markets[0]?.onchain).not.toBeNull();
    expect(fixtureOnchainMarkets(NOW, created).map((market) => market.symbol)).toContain(symbol);
    expect(fixtureOnchainMarkets(NOW, created)).toHaveLength(9);
    // It stays among them long after the fixtures have forgotten its event.
    expect(fixtureOnchainMarkets(NOW + DAY, created).find((market) => market.symbol === symbol)).toMatchObject({ settleState: "settled", onchain: { status: "settled" } });
  });

  it("carry the name the relayer gives their token", () => {
    expect(fixtureChainMarket(hourly.markets[2] as ApiMarket)).toMatchObject({ symbol: "GEMI-BTC2611142213-HI104100", status: "open", tokenName: "BTC >=104100 14Nov26 22:13 YES", yesPayout: "0", noPayout: "0", redeemAfter: 0, tickPx: 100 });
    expect(fixtureChainMarket(fixtureMarket("GEMI-BTC15M2611142211-UP", NOW) as ApiMarket)?.tokenName).toBe("BTC Up 15m 14Nov26 22:11 YES");
    expect(fixtureChainMarket(hourly.markets[0] as ApiMarket)).toBeNull();
  });

  it("hold the tokens every wallet starts with", () => {
    const mints = new Map(fixtureOnchainMarkets(NOW).flatMap((market) => [[market.onchain!.yesMint, `${market.symbol} YES`], [market.onchain!.noMint, `${market.symbol} NO`]]));
    expect(fixtureHoldings(NOW).map((holding) => `${mints.get(holding.mint)} ${holding.units}`).sort()).toEqual(
      [
        "GEMI-BTC15M2611142206-UP YES 300",
        "GEMI-BTC15M2611142211-UP YES 300",
        "GEMI-XRP15M2611142204-UP YES 500",
        "GEMI-XRP15M2611142209-UP YES 500",
        "GEMI-BTC2611142208-HI104100 YES 200",
        "GEMI-BTC2611142213-HI104100 YES 200",
        "GEMI-BTC2611142208-HI104400 YES 250",
        "GEMI-BTC2611142213-HI104400 YES 250",
      ].sort(),
    );
  });
});

describe("the fixture book, tape and history", () => {
  const QUOTED = "GEMI-BTC2611142213-HI104200";
  const EDGE = "GEMI-BTC2611142213-HI104600";
  const SILENT = "GEMI-XAU2611152200-HI3800";

  it("give three levels a side, a cent apart, best price first, starting at the quote", () => {
    expect(fixtureDepth(QUOTED, NOW)).toEqual({
      bids: [{ px: "5200", units: "2500" }, { px: "5100", units: "3750" }, { px: "5000", units: "5000" }],
      asks: [{ px: "5600", units: "1800" }, { px: "5700", units: "2700" }, { px: "5800", units: "3600" }],
      at: NOW - SECOND,
    });
    // Prices stay between 1 and 99 cents.
    expect(fixtureDepth(EDGE, NOW)?.bids.map((level) => level.px)).toEqual(["300", "200", "100"]);
    expect(fixtureDepth("GEMI-BTC2611142213-HI103900", NOW)?.asks.map((level) => level.px)).toEqual(["9500", "9600", "9700"]);
    expect(fixtureDepth("GEMI-SOL2611202200-HI200", NOW)).toMatchObject({ bids: [{ px: "200" }, { px: "100" }], asks: [] });
  });

  it("give trades newest first, at most fifty, on whole cents", () => {
    const trades = fixtureTrades(QUOTED, NOW) ?? [];
    // Quoted for 46 minutes, of which 41.5 have passed: one trade a minute.
    expect(trades).toHaveLength(42);
    expect(trades.map((trade) => trade.at)).toEqual([...trades.map((trade) => trade.at)].sort((a, b) => b - a));
    expect(new Set(trades.map((trade) => trade.id)).size).toBe(trades.length);
    for (const trade of trades) {
      expect(trade.id).toMatch(/^\d{15,18}$/);
      expect(Number(trade.px) % 100).toBe(0);
      expect(Number(trade.px)).toBeGreaterThanOrEqual(5_000);
      expect(Number(trade.px)).toBeLessThanOrEqual(5_800);
      expect(BigInt(trade.units)).toBeGreaterThan(0n);
      expect(trade.taker).toBe(Number(trade.px) >= 5_400 ? "buy" : "sell");
    }
    expect(new Set(trades.map((trade) => trade.taker))).toEqual(new Set(["buy", "sell"]));
    expect(fixtureTrades("GEMI-ETH2611152200-HI3400", NOW + 20 * HOUR)).toHaveLength(50);
    expect(fixtureMarket(QUOTED, NOW)?.lastPx).toBe(trades[0]?.px);
  });

  it("give the price history oldest first, in steps that follow how long the contract runs", () => {
    const history = fixtureHistory(QUOTED, NOW);
    expect(history?.stepSecs).toBe(60);
    expect(history?.points).toHaveLength(42);
    expect(history?.points.map((point) => point.at)).toEqual([...(history?.points ?? []).map((point) => point.at)].sort((a, b) => a - b));
    expect(history?.points.at(-1)).toEqual({ at: Date.UTC(2026, 10, 14, 22, 8), px: fixtureMarket(QUOTED, NOW)?.lastPx });
    expect(fixtureHistory("GEMI-BTC15M2611142211-UP", NOW)?.stepSecs).toBe(60);
    expect(fixtureHistory("GEMI-ETH2611152200-HI3400", NOW)).toMatchObject({ stepSecs: 900, points: [{ at: Date.UTC(2026, 10, 14, 22, 0) }] });
    expect(fixtureHistory("GEMI-SOL2611202200-HI200", NOW)).toEqual({ stepSecs: 3_600, points: [] });
  });

  it("are empty for a contract nobody quotes, and unknown for a symbol no event has", () => {
    expect(fixtureDepth(SILENT, NOW)).toEqual({ bids: [], asks: [], at: NOW - SECOND });
    expect(fixtureTrades(SILENT, NOW)).toEqual([]);
    expect(fixtureHistory(SILENT, NOW)).toEqual({ stepSecs: 900, points: [] });
    expect(fixtureDepth("GEMI-SOL2611272200-HI200", NOW)).toEqual({ bids: [], asks: [], at: NOW - SECOND });
    expect(fixtureDepth("GEMI-NOPE", NOW)).toBeNull();
    expect(fixtureTrades("GEMI-NOPE", NOW)).toBeNull();
    expect(fixtureHistory("GEMI-NOPE", NOW)).toBeNull();
  });

  it("stop with the contract: the book empties at expiry and the tape keeps what was traded", () => {
    const later = Date.UTC(2026, 10, 14, 22, 13) + MINUTE;
    expect(fixtureDepth(QUOTED, later)).toMatchObject({ bids: [], asks: [] });
    expect(fixtureTrades(QUOTED, later)).toHaveLength(46);
    expect(fixtureHistory(QUOTED, later)?.points.at(-1)?.at).toBe(Date.UTC(2026, 10, 14, 22, 12));
  });
});

describe("the fixture orders, health and books", () => {
  const orders = fixtureOrders(NOW);

  it("have one order the relayer never sends and one in each finished state, each in an event that was running", () => {
    expect(orders.map((order) => order.state)).toEqual(["seen", "chain_filled", "chain_cancelled", "orphaned", "failed"]);
    expect(new Set(orders.map((order) => order.address)).size).toBe(5);
    expect(orders.map((order) => order.createdAt)).toEqual([...orders.map((order) => order.createdAt)].sort((a, b) => b - a));
    for (const order of orders) {
      const market = fixtureMarket(order.symbol, NOW);
      expect(market?.onchain, order.symbol).not.toBeNull();
      expect(market!.startsAt, order.symbol).toBeLessThanOrEqual(order.createdAt);
      expect(market!.expiresAt, order.symbol).toBeGreaterThan(order.createdAt);
    }
    expect(orders[0]).toMatchObject({ symbol: "GEMI-XRP15M2611142209-UP", venueOrderId: null, chainSignature: null, createdAt: Date.UTC(2026, 10, 14, 22, 4, 58), expiresAt: Date.UTC(2026, 10, 14, 22, 5, 43) / SECOND });
    const filled = orders.find((order) => order.state === "chain_filled");
    expect(filled?.chainSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(filled).toMatchObject({ filledUnits: "500", amountMicros: "2800000", fills: [{ units: "500", px: "5600" }] });
  });

  it("report a healthy relayer on the simulated venue, on the clock asked about", () => {
    expect(fixtureHealth(NOW + 400)).toMatchObject({ ok: true, cluster: "devnet", venue: "mock", venueConnected: true, chainTime: NOW / SECOND, serverTime: NOW + 400, orderTtlSecs: 45, paused: { place: false, fill: false } });
  });

  it("balance every on-chain market that is not settled yet", () => {
    const status = fixtureStatus(NOW);
    expect(status.markets.map((row) => row.symbol)).toEqual(fixtureOnchainMarkets(NOW).filter((market) => market.onchain?.status !== "settled").map((market) => market.symbol));
    // Of the eight on-chain markets, the 22:06 contract and the two of the 22:08 ladder are settled already.
    expect(status.markets).toHaveLength(5);
    expect(status.markets[0]).toEqual({ symbol: "GEMI-BTC2611142213-HI104100", yesSupply: "1250", noSupply: "400", venueNet: "850", inFlight: "0", houseInventory: "0", balanced: true });
    expect(status.solvency.ok).toBe(true);
    expect(status.journal).toMatchObject({ seen: 1, chain_filled: 1, chain_cancelled: 1, orphaned: 1, failed: 1, submitting: 0 });
    expect(status.alerts).toEqual([{ at: orders[3]!.updatedAt, kind: "orphaned_fill", orderAddress: orders[3]!.address, detail: orders[3]!.detail }]);
  });
});
