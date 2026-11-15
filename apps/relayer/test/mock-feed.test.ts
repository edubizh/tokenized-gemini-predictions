import { describe, expect, it } from "vitest";
import { RollingMockVenue, quoteAt, referenceAt, resolutionOf, scheduleAt } from "../src/venue/mock-feed.ts";
import type { RollingMockVenueOptions, ScheduledEvent } from "../src/venue/mock-feed.ts";
import type { ContractInfo } from "../src/venue/venue.ts";

// 02:50 UTC: five minutes into the 02:45 to 03:00 window.
const NOW = Date.parse("2026-11-14T02:50:00Z");
const MINUTE = 60_000;

const byTicker = (events: ScheduledEvent[], ticker: string): ScheduledEvent => {
  const found = events.find((event) => event.ticker === ticker);
  if (found === undefined) throw new Error(`${ticker} is not listed`);
  return found;
};
const count = <T>(items: T[], test: (item: T) => boolean): number => items.filter(test).length;

describe("scheduleAt", () => {
  const listed = scheduleAt(NOW, 900);

  it("lists both shapes, every cadence and two categories at any moment", () => {
    expect(new Set(listed.map((event) => event.series.shape))).toEqual(new Set(["binary", "ladder"]));
    expect(new Set(listed.map((event) => event.series.cadence))).toEqual(new Set(["5m", "15m", "hourly", "daily", "weekly", "monthly"]));
    expect(new Set(listed.map((event) => event.category))).toEqual(new Set(["Crypto", "Commodities"]));
    // Several assets go up or down on both short cadences.
    for (const cadence of ["5m", "15m"]) {
      expect(count(listed, (event) => event.series.cadence === cadence && event.series.shape === "binary")).toBeGreaterThanOrEqual(3);
    }
    expect(count(listed, (event) => event.category === "Commodities" && event.series.shape === "ladder")).toBeGreaterThanOrEqual(1);
    expect(new Set(listed.map((event) => event.ticker)).size).toBe(listed.length);
  });

  it("names an event after its underlying and its expiry, with the interval marker of an up-or-down event", () => {
    const btc = byTicker(listed, "BTC15M2611140300");
    expect(btc).toMatchObject({
      category: "Crypto",
      subcategory: ["Bitcoin"],
      underlying: "BTC",
      listedAt: Date.parse("2026-11-14T02:41:00Z"),
      startsAt: Date.parse("2026-11-14T02:45:00Z"),
      expiresAt: Date.parse("2026-11-14T03:00:00Z"),
    });
    expect(btc.strikes).toHaveLength(1);
    expect(byTicker(listed, "BTC05M2611140255").startsAt).toBe(NOW);
    expect(byTicker(listed, "XAU2611150000")).toMatchObject({ category: "Commodities", subcategory: ["Precious Metals", "Gold"], underlying: "XAU" });
  });

  it("gives a ladder five to eight ascending strikes around its opening price", () => {
    const ladders = listed.filter((event) => event.series.shape === "ladder");
    expect(ladders.length).toBeGreaterThanOrEqual(5);
    for (const ladder of ladders) {
      const { strikes } = ladder;
      expect(strikes.length).toBeGreaterThanOrEqual(5);
      expect(strikes.length).toBeLessThanOrEqual(8);
      for (let i = 1; i < strikes.length; i++) expect(strikes[i]! - strikes[i - 1]!).toBe(ladder.series.step);
      expect(strikes[0]!).toBeLessThan(ladder.openPrice);
      expect(strikes.at(-1)!).toBeGreaterThan(ladder.openPrice - ladder.series.step);
    }
  });

  it("lists an event before it trades and drops it at expiry", () => {
    const next = "BTC15M2611140315";
    expect(scheduleAt(Date.parse("2026-11-14T02:55:59Z"), 900).map((event) => event.ticker)).not.toContain(next);
    const early = byTicker(scheduleAt(Date.parse("2026-11-14T02:56:00Z"), 900), next);
    expect(early.startsAt).toBe(Date.parse("2026-11-14T03:00:00Z"));
    expect(scheduleAt(early.expiresAt - 1, 900).map((event) => event.ticker)).toContain(next);
    expect(scheduleAt(early.expiresAt, 900).map((event) => event.ticker)).not.toContain(next);
    // An hourly ladder is listed a whole hour before it trades: one is waiting while one trades.
    const hourly = listed.filter((event) => event.underlying === "ETH" && event.series.cadence === "hourly");
    expect(hourly.map((event) => [event.ticker, event.startsAt <= NOW])).toEqual([
      ["ETH2611140300", true],
      ["ETH2611140400", false],
    ]);
  });

  it("scales every cadence with the length of the 15-minute window and keeps the cadence labels", () => {
    const fast = scheduleAt(NOW, 180);
    const life = (cadence: string): number => {
      const event = fast.find((candidate) => candidate.series.cadence === cadence)!;
      return (event.expiresAt - event.startsAt) / 1_000;
    };
    expect(["5m", "15m", "hourly", "daily", "weekly", "monthly"].map(life)).toEqual([60, 180, 720, 17_280, 120_960, 518_400]);
    expect(byTicker(fast, "BTC15M2611140251").expiresAt).toBe(Date.parse("2026-11-14T02:51:00Z"));
    // A length that is not a multiple of three: the five-minute events take the nearest whole second.
    const odd = scheduleAt(NOW, 200).find((event) => event.series.cadence === "5m")!;
    expect(odd.expiresAt - odd.startsAt).toBe(67_000);
  });

  it("is the same list for the same clock, whenever it is asked", () => {
    expect(scheduleAt(NOW, 900)).toEqual(listed);
    scheduleAt(NOW + 3_600_000, 900);
    expect(scheduleAt(NOW, 180)).toEqual(scheduleAt(NOW, 180));
  });

  it("keeps the longer ladder where two of one underlying expire together", () => {
    // BTC has an hourly and a daily ladder; the daily one ends at midnight.
    const before = scheduleAt(Date.parse("2026-11-14T23:30:00Z"), 900).filter((event) => event.ticker === "BTC2611150000");
    expect(before.map((event) => event.series.cadence)).toEqual(["daily"]);
  });
});

describe("referenceAt and resolutionOf", () => {
  const listed = scheduleAt(NOW, 900);
  const btc = byTicker(listed, "BTC15M2611140300");

  it("starts at the opening price, moves in steps over the life of the event and stops at expiry", () => {
    expect(referenceAt(btc, btc.startsAt - 1, "random")).toBe(btc.openPrice);
    expect(referenceAt(btc, btc.startsAt, "random")).toBe(btc.openPrice);
    const path = Array.from({ length: 16 }, (_, minute) => referenceAt(btc, btc.startsAt + minute * MINUTE, "random"));
    expect(new Set(path).size).toBeGreaterThan(4);
    expect(path).toEqual(Array.from({ length: 16 }, (_, minute) => referenceAt(btc, btc.startsAt + minute * MINUTE, "random")));
    expect(referenceAt(btc, btc.expiresAt + 3_600_000, "random")).toBe(path[15]);
    // Two steps a minute, each at most half the event's strike step.
    for (let i = 1; i < path.length; i++) expect(Math.abs(path[i]! - path[i - 1]!)).toBeLessThanOrEqual(btc.series.step);
  });

  it("resolves a ladder contract YES exactly when the final value is at or above its strike, so several can win", () => {
    const shapes = new Set<string>();
    for (let hour = 0; hour < 48; hour++) {
      const ladder = scheduleAt(NOW + hour * 3_600_000, 900).find((event) => event.underlying === "BTC" && event.series.cadence === "hourly" && event.startsAt <= NOW + hour * 3_600_000);
      if (ladder === undefined) continue; // the hour in which the daily ladder stands in for the hourly one
      const { value, sides } = resolutionOf(ladder, "yes");
      expect(value).toBe(referenceAt(ladder, ladder.expiresAt, "random"));
      expect(sides).toEqual(ladder.strikes.map((strike) => (value >= strike ? "yes" : "no")));
      // The winners are the lowest strikes.
      expect(sides.join(",")).toMatch(/^(yes,?)*(no,?)*$/);
      shapes.add(`${count(sides, (side) => side === "yes") >= 2 ? "several" : "few"} yes`);
      if (sides.includes("yes") && sides.includes("no")) shapes.add("mixed");
    }
    expect(shapes).toContain("several yes");
    expect(shapes).toContain("mixed");
  });

  it("resolves an up-or-down contract against its opening price, both ways over time", () => {
    const sides = new Set<string>();
    for (let window = 0; window < 40; window++) {
      const event = scheduleAt(NOW + window * 900_000, 900).find((candidate) => candidate.series.cadence === "15m" && candidate.underlying === "BTC")!;
      const { value, sides: [side] } = resolutionOf(event, "random");
      expect(event.strikes).toEqual([event.openPrice]);
      expect(side).toBe(value >= event.openPrice ? "yes" : "no");
      sides.add(side!);
    }
    expect(sides).toEqual(new Set(["yes", "no"]));
  });

  it("can be told how up-or-down contracts resolve; the reference price then ends on that side", () => {
    for (let window = 0; window < 40; window++) {
      const event = scheduleAt(NOW + window * 900_000, 900).find((candidate) => candidate.series.cadence === "5m")!;
      const yes = resolutionOf(event, "yes");
      const no = resolutionOf(event, "no");
      expect(yes.sides).toEqual(["yes"]);
      expect(yes.value).toBeGreaterThanOrEqual(event.openPrice);
      expect(no.sides).toEqual(["no"]);
      expect(no.value).toBeLessThan(event.openPrice);
      expect(referenceAt(event, event.expiresAt, "no")).toBe(no.value);
    }
  });
});

describe("quoteAt", () => {
  const listed = scheduleAt(NOW, 900);
  const trading = (event: ScheduledEvent, share: number): number => event.startsAt + Math.floor((event.expiresAt - event.startsAt) * share);

  it("quotes two or three levels a side on the one-cent grid, the bid below the ask", () => {
    const btc = byTicker(listed, "BTC15M2611140300");
    const book = quoteAt(btc, 0, btc.startsAt, "random");
    // At the start the reference price is the strike: an even chance.
    expect(book.bids[0]![0]).toBe(4_800n);
    expect(book.asks[0]![0]).toBe(5_200n);
    for (const event of listed) {
      for (let index = 0; index < event.strikes.length; index++) {
        const { bids, asks } = quoteAt(event, index, trading(event, 0.9), "random");
        if (event.series.quotedFrom === null) continue;
        for (const side of [bids, asks]) {
          expect(side.length).toBeGreaterThanOrEqual(2);
          expect(side.length).toBeLessThanOrEqual(3);
          for (const [px, units] of side) {
            expect(px % 100n).toBe(0n);
            expect(px).toBeGreaterThanOrEqual(100n);
            expect(px).toBeLessThanOrEqual(9_900n);
            expect(units).toBeGreaterThan(0n);
          }
        }
        expect(bids.map(([px]) => px)).toEqual(bids.map(([px]) => px).sort((a, b) => Number(b - a)));
        expect(asks.map(([px]) => px)).toEqual(asks.map(([px]) => px).sort((a, b) => Number(a - b)));
        expect(bids[0]![0]).toBeLessThan(asks[0]![0]);
      }
    }
  });

  it("quotes some contracts from the start of trading, some only late and some never", () => {
    const quotedAt = (event: ScheduledEvent, share: number): boolean => quoteAt(event, 0, trading(event, share), "random").asks.length > 0;
    const profile = (ticker: string): boolean[] => [0, 0.5, 0.95].map((share) => quotedAt(byTicker(listed, ticker), share));
    expect(profile("BTC15M2611140300")).toEqual([true, true, true]);
    expect(profile("XAU2611150000")).toEqual([true, true, true]); // the commodity ladder can be traded
    expect(profile("BTC2611140300")).toEqual([false, true, true]); // an hourly ladder is quoted late
    expect(profile("BTC05M2611140255")).toEqual([false, true, true]);
    for (const event of listed.filter((candidate) => candidate.series.cadence === "weekly" || candidate.series.cadence === "monthly")) {
      expect([0, 0.25, 0.5, 0.75, 0.99].map((share) => quotedAt(event, share))).toEqual([false, false, false, false, false]);
    }
  });

  it("quotes nothing before trading starts or from expiry on", () => {
    const xau = byTicker(listed, "XAU2611150000");
    expect(quoteAt(xau, 0, xau.startsAt - 1, "random")).toEqual({ bids: [], asks: [] });
    expect(quoteAt(xau, 0, xau.expiresAt, "random")).toEqual({ bids: [], asks: [] });
    expect(quoteAt(xau, 0, xau.expiresAt - 1, "random").bids.length).toBeGreaterThan(0);
  });

  it("prices a contract by how far the reference price is from its strike: high in the money, low out of it", () => {
    const xau = byTicker(listed, "XAU2611150000");
    const at = xau.expiresAt - 1;
    const bids = xau.strikes.map((_, index) => quoteAt(xau, index, at, "random").bids[0]![0]);
    for (let i = 1; i < bids.length; i++) expect(bids[i]!).toBeLessThanOrEqual(bids[i - 1]!);
    const reference = referenceAt(xau, at, "random");
    xau.strikes.forEach((strike, index) => {
      const { bids: [bid], asks: [ask] } = quoteAt(xau, index, at, "random");
      if (reference - strike >= 2 * xau.series.step) expect(bid![0]).toBeGreaterThanOrEqual(9_000n);
      if (strike - reference >= 2 * xau.series.step) expect(ask![0]).toBeLessThanOrEqual(1_000n);
    });
  });
});

describe("RollingMockVenue", () => {
  const END = Date.parse("2026-11-14T03:00:00Z");
  const BTC = "MOCK-BTC15M2611140300-UP";
  const order = (overrides: object = {}) => ({ clientOrderId: "a", symbol: BTC, outcome: "YES" as const, units: 300n, limitPx: 9_900n, timeInForce: "FOK" as const, ...overrides });

  function rolling(options: Partial<RollingMockVenueOptions> = {}) {
    const clock = { ms: NOW };
    const venue = new RollingMockVenue({ windowSecs: 900, resolve: "random", now: () => clock.ms, ...options });
    return { venue, clock };
  }
  const listedEvent = async (venue: RollingMockVenue, ticker: string) => (await venue.listEvents()).find((event) => event.ticker === ticker);

  it("lists the schedule, with texts like the venue's own and symbols in its grammar", async () => {
    const { venue } = rolling();
    const listed = await venue.listEvents();
    expect(listed.map((event) => event.ticker).sort()).toEqual(scheduleAt(NOW, 900).map((event) => event.ticker).sort());
    const btc = listed.find((event) => event.ticker === "BTC15M2611140300")!;
    expect(btc).toMatchObject({
      title: "BTC price on November 14 at 03:00 UTC",
      category: "Crypto",
      subcategory: ["Bitcoin"],
      underlying: "BTC",
      shape: "binary",
      cadence: "15m",
      description: "Simulated BTC price prediction event expiring on November 14, 2026 at 03:00 UTC",
      source: { agency: "simulation", index: "SIM-BTCUSD" },
      termsUrl: null,
      listedAt: new Date(END - 19 * MINUTE),
      expiresAt: new Date(END),
      status: "active",
      volumeUnits: 0n,
    });
    expect(btc.contracts).toHaveLength(1);
    expect(btc.contracts[0]).toMatchObject({
      symbol: BTC,
      eventTicker: "BTC15M2611140300",
      status: "active",
      marketState: "open",
      effectiveAt: new Date(END - 15 * MINUTE),
      expiresAt: new Date(END),
      tickPx: 100n,
      unitIncrement: 1n,
      minUnits: 1n,
      resolutionSide: null,
      label: "Up",
      sortOrder: 0,
      rules:
        "If the price of Bitcoin (BTC) on November 14, 2026 at 03:00 UTC is greater than or equal to its price at 02:45 UTC, this market will resolve to Yes. " +
        "Otherwise, it will resolve to No. Outcome verified against the simulated SIM-BTCUSD index.",
      settlementValue: null,
      lastPx: null,
    });
    expect(btc.contracts[0]!.strike).toMatch(/^\d+\.\d{2}$/);

    const gold = listed.find((event) => event.ticker === "XAU2611150000")!;
    expect(gold).toMatchObject({ title: "Gold price on November 15 at 00:00 UTC", category: "Commodities", subcategory: ["Precious Metals", "Gold"], shape: "ladder", cadence: "daily" });
    expect(gold.contracts.map((info) => [info.symbol, info.label, info.strike, info.sortOrder]).slice(0, 2)).toEqual([
      ["MOCK-XAU2611150000-HI3700", "$3,700 or above", "3700", 0],
      ["MOCK-XAU2611150000-HI3725", "$3,725 or above", "3725", 1],
    ]);
    expect(gold.contracts[0]!.rules).toBe(
      "If the price of Gold (XAU) is $3,700 or above on November 15, 2026 at 00:00 UTC, this market will resolve to Yes. " +
        "Otherwise, it will resolve to No. Outcome verified against the simulated SIM-XAUUSD index.",
    );
    // A strike below a dollar is written with `D` for the decimal point.
    const xrp = listed.find((event) => event.ticker === "XRP2611140300")!;
    expect(xrp.contracts.map((info) => [info.symbol, info.label, info.strike])).toContainEqual(["MOCK-XRP2611140300-HI0D84", "$0.84 or above", "0.84"]);

    for (const event of listed) {
      expect(`${event.title} ${event.description}`).not.toMatch(/gemi/i);
      for (const info of event.contracts) {
        expect(info.symbol).toMatch(/^MOCK-[A-Z]+(05M|15M)?\d{10}-(UP|HI\d+(D\d+)?)$/);
        expect(`${info.label} ${info.rules}`).not.toMatch(/gemi/i);
      }
    }
  });

  it("lists a ladder approved and post-only before it trades, and an up-or-down contract without a strike before its window", async () => {
    const { venue, clock } = rolling();
    const ladder = (await listedEvent(venue, "BTC2611140400"))!;
    expect(ladder.status).toBe("approved");
    expect(new Set(ladder.contracts.map((info) => `${info.status}/${info.marketState}/${info.bestAskPx}`))).toEqual(new Set(["approved/post_only/null"]));
    const waiting = "MOCK-BTC05M2611140300-UP";
    expect(await venue.contract(waiting)).toMatchObject({ status: "active", marketState: "open", strike: null, effectiveAt: new Date(END - 5 * MINUTE) });
    expect((await venue.placeOrder(order({ symbol: ladder.contracts[0]!.symbol }))).kind).toBe("rejected");

    clock.ms = END - 5 * MINUTE;
    expect((await venue.contract(waiting))?.strike).toMatch(/^\d+\.\d{2}$/);
    clock.ms = END;
    expect(await listedEvent(venue, "BTC2611140400")).toMatchObject({ status: "active", contracts: ladder.contracts.map(() => ({ status: "active", marketState: "open" })) });
  });

  it("closes a contract at expiry, settles it a few seconds later and pays the position", async () => {
    const { venue, clock } = rolling({ resolve: "no" });
    const filled = await venue.placeOrder(order({ outcome: "NO" }));
    if (filled.kind !== "filled") throw new Error(`expected a fill, got ${filled.kind}`);
    expect(await venue.positions()).toEqual(new Map([[BTC, -300n]]));

    clock.ms = END;
    expect(await venue.contract(BTC)).toMatchObject({ status: "under_review", marketState: "closed", resolutionSide: null, settlementValue: null, bestBidPx: null, bestAskPx: null, lastPx: filled.fills[0]!.px === 0n ? null : 10_000n - filled.fills[0]!.px });
    expect((await venue.placeOrder(order({ clientOrderId: "b" }))).kind).toBe("rejected");
    const tickers = (await venue.listEvents()).map((event) => event.ticker);
    expect(tickers).not.toContain("BTC15M2611140300");
    expect(tickers).toContain("BTC15M2611140315");

    clock.ms = END + 4_999;
    expect((await venue.contract(BTC))?.status).toBe("under_review");
    expect(await venue.settledPayoutMicros(BTC)).toBeNull();
    clock.ms = END + 5_000;
    const settled = (await venue.contract(BTC))!;
    expect(settled).toMatchObject({ status: "settled", marketState: "closed", resolutionSide: "no" });
    expect(Number(settled.settlementValue)).toBeLessThan(Number(settled.strike));
    expect(await venue.settledPayoutMicros(BTC)).toBe(3_000_000n);
    expect(await venue.positions()).toEqual(new Map());
  });

  it("settles the contracts of a ladder from one final value: several are YES, the others NO", async () => {
    const { venue, clock } = rolling();
    const ladder = (await listedEvent(venue, "XRP2611140300"))!;
    clock.ms = END + 5_000;
    const settled: ContractInfo[] = [];
    for (const info of ladder.contracts) settled.push((await venue.contract(info.symbol))!);
    expect(new Set(settled.map((info) => info.status))).toEqual(new Set(["settled"]));
    expect(new Set(settled.map((info) => info.settlementValue)).size).toBe(1);
    const value = Number(settled[0]!.settlementValue);
    expect(settled.map((info) => info.resolutionSide)).toEqual(settled.map((info) => (value >= Number(info.strike) ? "yes" : "no")));
    expect(count(settled, (info) => info.resolutionSide === "yes")).toBeGreaterThanOrEqual(2);
    expect(count(settled, (info) => info.resolutionSide === "no")).toBeGreaterThanOrEqual(1);
  });

  it("can keep one contract under review while its siblings settle", async () => {
    const stuck = "MOCK-XRP2611140300-HI0D84";
    const { venue, clock } = rolling({ stuck: [stuck] });
    const ladder = (await listedEvent(venue, "XRP2611140300"))!;
    clock.ms = END + 3_600_000;
    for (const info of ladder.contracts) {
      const now = (await venue.contract(info.symbol))!;
      if (info.symbol === stuck) expect(now).toMatchObject({ status: "under_review", marketState: "closed", resolutionSide: null, settlementValue: null });
      else expect(now.status).toBe("settled");
    }
  });

  it("can leave a live event out of one list read", async () => {
    const { venue } = rolling({ missedOnce: ["BTC15M2611140300"] });
    const tickers = async () => (await venue.listEvents()).map((event) => event.ticker);
    const first = await tickers();
    expect(first).not.toContain("BTC15M2611140300");
    expect(first).toContain("ETH15M2611140300");
    expect(await tickers()).toContain("BTC15M2611140300");
    expect((await venue.contract(BTC))?.status).toBe("active");
  });

  it("shows the simulated book in every read; a fill takes from it until the quote moves, and leaves a trade", async () => {
    const { venue, clock } = rolling();
    const event = byTicker(scheduleAt(NOW, 900), "BTC15M2611140300");
    const quote = quoteAt(event, 0, NOW, "random");
    const [bid, ask] = [quote.bids[0]!, quote.asks[0]!];
    const levels = (side: typeof quote.bids) => side.map(([px, units]) => ({ px, units }));
    expect(await venue.depth(BTC, 10)).toEqual({ bids: levels(quote.bids), asks: levels(quote.asks) });
    expect(await venue.topOfBook(BTC)).toEqual({ bidPx: bid[0], bidUnits: bid[1], askPx: ask[0], askUnits: ask[1] });
    expect(venue.liveTop(BTC)).toEqual({ top: await venue.topOfBook(BTC), atMs: NOW });
    expect(await venue.contract(BTC)).toMatchObject({ bestBidPx: bid[0], bestAskPx: ask[0] });

    clock.ms = NOW + 1_000;
    const bought = await venue.placeOrder(order({ limitPx: ask[0] }));
    if (bought.kind !== "filled") throw new Error(`expected a fill, got ${bought.kind}`);
    expect(bought.fills.map((fill) => [fill.units, fill.px])).toEqual([[300n, ask[0]]]);
    expect(venue.liveTop(BTC)).toEqual({ top: { bidPx: bid[0], bidUnits: bid[1], askPx: ask[0], askUnits: ask[1] - 300n }, atMs: NOW + 1_000 });
    expect(await venue.trades(BTC, 10)).toEqual([{ id: bought.fills[0]!.tradeId, atMs: NOW + 1_000, px: ask[0], units: 300n, taker: "buy" }]);
    expect(await venue.history(BTC, 60)).toEqual([{ atMs: NOW, px: ask[0] }]);
    expect(await venue.contract(BTC)).toMatchObject({ lastPx: ask[0] });
    expect((await listedEvent(venue, "BTC15M2611140300"))?.volumeUnits).toBe(300n);
    expect(await venue.findOrder("a", BTC, 0)).toMatchObject({ found: true, closed: true, filledUnits: 300n, avgPx: ask[0] });

    // The next time the quote moves the orders are placed afresh.
    let at = NOW + 1_000;
    while (quoteAt(event, 0, at, "random").bids[0]![0] === bid[0]) at += 1_000;
    clock.ms = at;
    const moved = quoteAt(event, 0, at, "random");
    expect(venue.liveTop(BTC)).toEqual({ top: { bidPx: moved.bids[0]![0], bidUnits: moved.bids[0]![1], askPx: moved.asks[0]![0], askUnits: moved.asks[0]![1] }, atMs: at });
    expect(await venue.depth(BTC, 1)).toEqual({ bids: levels(moved.bids).slice(0, 1), asks: levels(moved.asks).slice(0, 1) });
    // A contract that is never quoted has an empty book and takes no order.
    const copper = (await listedEvent(venue, "COPPER2611190000"))!.contracts[0]!;
    expect(copper).toMatchObject({ status: "active", marketState: "open", bestBidPx: null, bestAskPx: null });
    expect(await venue.depth(copper.symbol, 10)).toEqual({ bids: [], asks: [] });
    expect((await venue.placeOrder(order({ clientOrderId: "c", symbol: copper.symbol }))).kind).toBe("not_filled");
  });

  it("presents the same events after a restart and takes a position back, ladders included", async () => {
    const first = rolling();
    const before = await first.venue.listEvents();
    const held = before.find((event) => event.ticker === "XAU2611150000")!.contracts[2]!;
    const expired = before.find((event) => event.ticker === "XRP2611140300")!.contracts[0]!;

    // The new process starts after the hourly ladder expired; the daily one still trades.
    const { venue, clock } = rolling();
    clock.ms = END + 60_000;
    venue.adopt(held, 250n);
    venue.adopt(expired, -100n);
    expect(await venue.positions()).toEqual(new Map([[held.symbol, 250n]]));
    const side = (await first.venue.contract(expired.symbol).then(() => resolutionOf(byTicker(scheduleAt(NOW, 900), "XRP2611140300"), "random"))).sides[0]!;
    expect(await venue.contract(expired.symbol)).toMatchObject({ status: "settled", resolutionSide: side, eventTicker: "XRP2611140300" });
    expect(await venue.settledPayoutMicros(expired.symbol)).toBe(side === "no" ? 1_000_000n : 0n);

    first.clock.ms = END + 60_000;
    const strip = (events: Awaited<ReturnType<RollingMockVenue["listEvents"]>>) => events.map((event) => ({ ...event, contracts: event.contracts.map((info) => ({ ...info })) })).sort((a, b) => a.ticker.localeCompare(b.ticker));
    expect(strip(await venue.listEvents())).toEqual(strip(await first.venue.listEvents()));
  });

  it("settles an adopted contract the way the relayer already saw, and one of another origin after its expiry", async () => {
    const { venue, clock } = rolling({ resolve: "yes" });
    const info: ContractInfo = {
      symbol: "TEST-BTC15M2611140245-UP",
      eventTicker: "BTC15M2611140245",
      status: "active",
      marketState: "open",
      effectiveAt: new Date(NOW - 16 * MINUTE),
      expiresAt: new Date(NOW - MINUTE),
      tickPx: 100n,
      unitIncrement: 1n,
      minUnits: 1n,
      resolutionSide: null,
    };
    venue.adopt(info, 250n);
    expect(await venue.contract(info.symbol)).toMatchObject({ status: "settled", resolutionSide: "yes" });
    expect(await venue.settledPayoutMicros(info.symbol)).toBe(2_500_000n);

    const later = { ...info, symbol: "TEST-ETH15M2611140300-UP", eventTicker: "ETH15M2611140300", expiresAt: new Date(END) };
    venue.adopt(later, 100n);
    expect((await venue.contract(later.symbol))?.status).toBe("active");
    clock.ms = END + 5_000;
    expect(await venue.contract(later.symbol)).toMatchObject({ status: "settled", resolutionSide: "yes" });

    const decided = { ...info, symbol: "MOCK-BTC15M2611140245-UP" };
    venue.adopt(decided, -100n, "no");
    expect(await venue.contract(decided.symbol)).toMatchObject({ status: "settled", resolutionSide: "no" });
    expect(await venue.settledPayoutMicros(decided.symbol)).toBe(1_000_000n);
  });

  it("never forgets a contract it took over, however long ago its event expired: the relayer may still have to settle it", async () => {
    const first = rolling();
    const held = (await first.venue.listEvents()).find((event) => event.ticker === "XRP2611140300")!.contracts[0]!;

    // The new process starts more than a day after the ladder expired.
    const { venue, clock } = rolling();
    clock.ms = END + 25 * 60 * MINUTE;
    venue.adopt(held, 300n);
    const read = await venue.contract(held.symbol);
    expect(read).toMatchObject({ status: "settled", eventTicker: "XRP2611140300" });
    expect(await venue.settledPayoutMicros(held.symbol)).toBe(read?.resolutionSide === "yes" ? 3_000_000n : 0n);

    clock.ms += 48 * 60 * MINUTE;
    expect((await venue.contract(held.symbol))?.status).toBe("settled");
  });

  it("forgets a settled contract a day after its expiry, but not what the account did in it", async () => {
    const { venue, clock } = rolling({ resolve: "yes" });
    const bought = await venue.placeOrder(order());
    if (bought.kind !== "filled") throw new Error(`expected a fill, got ${bought.kind}`);
    const other = "MOCK-ETH15M2611140300-UP";
    clock.ms = END + 24 * 60 * MINUTE;
    expect((await venue.contract(BTC))?.status).toBe("settled");
    expect((await venue.contract(other))?.status).toBe("settled");

    clock.ms += 1;
    expect(await venue.contract(BTC)).toBeNull();
    expect(await venue.contract(other)).toBeNull();
    expect(await venue.settledPayoutMicros(BTC)).toBe(3_000_000n);
    expect(await venue.trades(BTC, 10)).toHaveLength(1);
    expect(await venue.findOrder("a", BTC, 0)).toMatchObject({ found: true, filledUnits: 300n });
    expect((await venue.listEvents()).length).toBe(scheduleAt(clock.ms, 900).length);
  });

  it("refuses a window shorter than three minutes", () => {
    expect(() => rolling({ windowSecs: 179 })).toThrow(/at least 180/);
    expect(() => rolling({ windowSecs: 180.5 })).toThrow(/whole number/);
  });
});
