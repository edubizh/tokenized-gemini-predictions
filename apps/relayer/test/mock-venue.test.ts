import { describe, expect, it } from "vitest";
import { takerFee } from "../src/money.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { VenueOrderRequest } from "../src/venue/types.ts";
import type { ContractInfo } from "../src/venue/venue.ts";

const SYMBOL = "GEMI-BTC-TEST";

function contract(overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    symbol: SYMBOL,
    eventTicker: "BTC-TEST",
    status: "active",
    marketState: "open",
    effectiveAt: new Date("2026-11-14T00:00:00Z"),
    expiresAt: new Date("2026-11-14T00:15:00Z"),
    tickPx: 100n,
    unitIncrement: 100n,
    minUnits: 100n,
    resolutionSide: null,
    ...overrides,
  };
}

function venueWith(cash = 10_000_000n, options?: ConstructorParameters<typeof MockVenue>[0]): MockVenue {
  const venue = new MockVenue(options);
  venue.addContract(contract());
  venue.setCash(cash);
  return venue;
}

/** The account's signed position in a contract; zero when it holds none. */
async function position(venue: MockVenue, symbol: string): Promise<bigint> {
  return (await venue.positions()).get(symbol) ?? 0n;
}

let nextId = 0;
function request(overrides: Partial<VenueOrderRequest> = {}): VenueOrderRequest {
  nextId += 1;
  return {
    clientOrderId: `client-${nextId}`,
    symbol: SYMBOL,
    outcome: "YES",
    units: 300n,
    limitPx: 1_700n,
    timeInForce: "FOK",
    ...overrides,
  };
}

describe("MockVenue.placeOrder", () => {
  it("fills a FOK BUY YES across two ask levels", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 500n], [1_800n, 500n]] });
    const result = await venue.placeOrder(request());
    if (result.kind !== "filled") throw new Error(`expected filled, got ${result.kind}`);
    expect(result.fills.map((f) => [f.units, f.px, f.feeMicros])).toEqual([
      [100n, 1_600n, 0n],
      [200n, 1_700n, 0n],
    ]);
    expect(new Set(result.fills.map((f) => f.tradeId)).size).toBe(2);
    expect(result.venueOrderId).toMatch(/^\d{17,18}$/);
    expect(result.filledUnits).toBe(300n);
    expect(result.costMicros).toBe(500_000n);
    expect(result.feeMicros).toBe(0n);
    expect(await position(venue, SYMBOL)).toBe(300n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 500_000n);
    // The book was consumed: 300 left at 1_700.
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: null, bidUnits: 0n, askPx: 1_700n, askUnits: 300n });
  });

  it("refuses a FOK when depth within the limit is short and changes nothing", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 100n], [1_800n, 500n]] });
    const result = await venue.placeOrder(request());
    expect(result.kind).toBe("not_filled");
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n);
    expect(await venue.topOfBook(SYMBOL)).toMatchObject({ askPx: 1_600n, askUnits: 100n });
  });

  it("partially fills an IOC with what is available", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 100n], [1_800n, 500n]] });
    const result = await venue.placeOrder(request({ timeInForce: "IOC" }));
    if (result.kind !== "filled") throw new Error(`expected filled, got ${result.kind}`);
    expect(result.filledUnits).toBe(200n);
    expect(result.costMicros).toBe(100n * 1_600n + 100n * 1_700n);
    expect(await position(venue, SYMBOL)).toBe(200n);

    const none = await venue.placeOrder(request({ timeInForce: "IOC", limitPx: 1_000n }));
    expect(none.kind).toBe("not_filled");
  });

  it("prices BUY NO against the bids and reports fills in NO space", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[400n, 100n], [300n, 100n], [200n, 500n]], asks: [] });
    // NO limit 9_700 reaches YES bids at 300 or better.
    const result = await venue.placeOrder(request({ outcome: "NO", units: 200n, limitPx: 9_700n }));
    if (result.kind !== "filled") throw new Error(`expected filled, got ${result.kind}`);
    expect(result.fills.map((f) => [f.units, f.px])).toEqual([
      [100n, 9_600n],
      [100n, 9_700n],
    ]);
    expect(result.costMicros).toBe(100n * 9_600n + 100n * 9_700n);
    expect(await position(venue, SYMBOL)).toBe(-200n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 1_930_000n);
    expect(await venue.topOfBook(SYMBOL)).toMatchObject({ bidPx: 200n, bidUnits: 500n });

    // The remaining bid at 200 is outside a 9_700 NO limit.
    const short = await venue.placeOrder(request({ outcome: "NO", units: 100n, limitPx: 9_700n }));
    expect(short.kind).toBe("not_filled");
  });

  it("nets an opposite position and releases the payout of every closed pair", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[300n, 300n]], asks: [[1_700n, 300n]] });
    expect((await venue.placeOrder(request())).kind).toBe("filled");
    expect(await position(venue, SYMBOL)).toBe(300n);
    const cashBefore = await venue.cashMicros();

    const result = await venue.placeOrder(request({ outcome: "NO", units: 100n, limitPx: 9_700n }));
    expect(result.kind).toBe("filled");
    expect(await position(venue, SYMBOL)).toBe(200n);
    expect(await venue.cashMicros()).toBe(cashBefore - 100n * 9_700n + 100n * 10_000n);
  });

  it("releases only the offsetting part when an order flips the position", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[300n, 300n]], asks: [[1_700n, 100n]] });
    await venue.placeOrder(request({ units: 100n }));
    const cashBefore = await venue.cashMicros();
    await venue.placeOrder(request({ outcome: "NO", units: 300n, limitPx: 9_700n }));
    expect(await position(venue, SYMBOL)).toBe(-200n);
    expect(await venue.cashMicros()).toBe(cashBefore - 300n * 9_700n + 100n * 10_000n);
  });

  it("charges the injected fee per fill", async () => {
    const venue = venueWith(10_000_000n, { feeFor: takerFee });
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 500n]] });
    const result = await venue.placeOrder(request());
    if (result.kind !== "filled") throw new Error(`expected filled, got ${result.kind}`);
    const fees = [takerFee(100n, 1_600n), takerFee(200n, 1_700n)];
    expect(result.fills.map((f) => f.feeMicros)).toEqual(fees);
    expect(result.feeMicros).toBe(fees[0]! + fees[1]!);
    expect(await venue.cashMicros()).toBe(10_000_000n - 500_000n - result.feeMicros);
  });

  it("rejects unknown, untradable, off-grid and unaffordable orders without executing", async () => {
    const venue = venueWith(400_000n);
    venue.addContract(contract({ symbol: "GEMI-REVIEW", status: "under_review" }));
    venue.addContract(contract({ symbol: "GEMI-POSTONLY", marketState: "post_only" }));
    for (const symbol of [SYMBOL, "GEMI-REVIEW", "GEMI-POSTONLY"]) {
      venue.setBook(symbol, { bids: [], asks: [[1_700n, 1_000n]] });
    }
    const cases: Array<[Partial<VenueOrderRequest>, RegExp]> = [
      [{ symbol: "GEMI-NOPE" }, /unknown contract/],
      [{ symbol: "GEMI-REVIEW" }, /not tradable/],
      [{ symbol: "GEMI-POSTONLY" }, /not tradable/],
      [{ limitPx: 1_750n }, /price/],
      [{ limitPx: 10_000n }, /price/],
      [{ units: 150n }, /quantity/],
      [{ units: 0n }, /quantity/],
      [{ units: 300n }, /insufficient/],
    ];
    for (const [overrides, message] of cases) {
      const result = await venue.placeOrder(request(overrides));
      if (result.kind !== "rejected") throw new Error(`expected rejected, got ${result.kind}`);
      expect(result.message).toMatch(message);
    }
    expect(await venue.cashMicros()).toBe(400_000n);
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.topOfBook(SYMBOL)).toMatchObject({ askPx: 1_700n, askUnits: 1_000n });
    expect(venue.requests).toHaveLength(cases.length);
  });

  it("rejects a second order with a client order id the venue already accepted", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 1_000n]] });
    const first = request();
    expect((await venue.placeOrder(first)).kind).toBe("filled");
    const second = await venue.placeOrder(first);
    if (second.kind !== "rejected") throw new Error(`expected rejected, got ${second.kind}`);
    expect(second.message).toMatch(/duplicate/);
    expect(await position(venue, SYMBOL)).toBe(300n);
  });
});

describe("MockVenue fault injection", () => {
  it("unknown_after_fill executes the order but reports unknown", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    venue.failNext("unknown_after_fill");
    const order = request();
    expect((await venue.placeOrder(order)).kind).toBe("unknown");
    expect(await position(venue, SYMBOL)).toBe(300n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 510_000n);
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toMatchObject({
      found: true,
      closed: true,
      filledUnits: 300n,
      avgPx: 1_700n,
    });
  });

  it("unknown_no_fill does not execute and reports unknown", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    venue.failNext("unknown_no_fill");
    const order = request();
    expect((await venue.placeOrder(order)).kind).toBe("unknown");
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n);
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toEqual({ found: false });
  });

  it("throw does not execute and rejects the promise", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    venue.failNext("throw");
    const order = request();
    await expect(venue.placeOrder(order)).rejects.toThrow(/injected/);
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toEqual({ found: false });
    expect(venue.requests).toEqual([order]);
  });

  it("a fault applies to one order only", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 600n]] });
    venue.failNext("unknown_no_fill");
    expect((await venue.placeOrder(request())).kind).toBe("unknown");
    expect((await venue.placeOrder(request())).kind).toBe("filled");
  });
});

describe("MockVenue.findOrder", () => {
  it("answers from the recorded orders", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 100n]] });
    const filledOrder = request({ units: 200n });
    const placed = await venue.placeOrder(filledOrder);
    if (placed.kind !== "filled") throw new Error(`expected filled, got ${placed.kind}`);
    expect(await venue.findOrder(filledOrder.clientOrderId, SYMBOL, 0)).toEqual({
      found: true,
      venueOrderId: placed.venueOrderId,
      closed: true,
      filledUnits: 200n,
      avgPx: 1_650n,
    });

    const killed = request();
    expect((await venue.placeOrder(killed)).kind).toBe("not_filled");
    expect(await venue.findOrder(killed.clientOrderId, SYMBOL, 0)).toMatchObject({
      found: true,
      closed: true,
      filledUnits: 0n,
      avgPx: null,
    });

    expect(await venue.findOrder("never-sent", SYMBOL, 0)).toEqual({ found: false });
    expect(await venue.findOrder(filledOrder.clientOrderId, "GEMI-OTHER", 0)).toEqual({ found: false });
  });

  it("reports a null average when it is not a whole px", async () => {
    const venue = venueWith();
    venue.addContract(contract({ unitIncrement: 1n, minUnits: 1n }));
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 1n], [1_700n, 2n]] });
    const order = request({ units: 3n });
    expect((await venue.placeOrder(order)).kind).toBe("filled");
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toMatchObject({ filledUnits: 3n, avgPx: null });
  });

  it("reports an order held open as found but not closed until it is released", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    const order = request();
    venue.holdOpen(order.clientOrderId);
    // Holding an id the venue has not accepted does not make it findable.
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toEqual({ found: false });
    expect((await venue.placeOrder(order)).kind).toBe("filled");
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toMatchObject({
      found: true,
      closed: false,
      filledUnits: 300n,
    });
    venue.holdOpen(order.clientOrderId, false);
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toMatchObject({
      found: true,
      closed: true,
      filledUnits: 300n,
      avgPx: 1_700n,
    });
  });

  it("does not find a rejected order", async () => {
    const venue = venueWith();
    const order = request({ symbol: "GEMI-NOPE" });
    expect((await venue.placeOrder(order)).kind).toBe("rejected");
    expect(await venue.findOrder(order.clientOrderId, "GEMI-NOPE", 0)).toEqual({ found: false });
  });
});

describe("MockVenue.resolve", () => {
  it("pays a winning long YES position and settles the contract", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    await venue.placeOrder(request());
    venue.resolve(SYMBOL, "yes");
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 510_000n + 3_000_000n);
    expect(await venue.contract(SYMBOL)).toMatchObject({ status: "settled", resolutionSide: "yes" });

    const after = await venue.placeOrder(request());
    if (after.kind !== "rejected") throw new Error(`expected rejected, got ${after.kind}`);
    expect(after.message).toMatch(/not tradable/);
  });

  it("pays nothing to a losing position", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    await venue.placeOrder(request());
    venue.resolve(SYMBOL, "no");
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 510_000n);
    expect((await venue.contract(SYMBOL))?.resolutionSide).toBe("no");
  });

  it("pays a winning NO position", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[300n, 200n]], asks: [] });
    await venue.placeOrder(request({ outcome: "NO", units: 200n, limitPx: 9_700n }));
    venue.resolve(SYMBOL, "no");
    expect(await position(venue, SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 200n * 9_700n + 200n * 10_000n);
  });

  it("throws for an unknown contract", () => {
    expect(() => new MockVenue().resolve("GEMI-NOPE", "yes")).toThrow(/unknown contract/);
  });
});

describe("MockVenue.settledPayoutMicros", () => {
  it("reports what the resolution paid: the payout of a winner, zero for a loser", async () => {
    const winner = venueWith();
    winner.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    await winner.placeOrder(request());
    expect(await winner.settledPayoutMicros(SYMBOL)).toBeNull(); // not resolved yet
    winner.resolve(SYMBOL, "yes");
    expect(await winner.settledPayoutMicros(SYMBOL)).toBe(3_000_000n);

    const loser = venueWith();
    loser.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    await loser.placeOrder(request());
    loser.resolve(SYMBOL, "no");
    expect(await loser.settledPayoutMicros(SYMBOL)).toBe(0n);
  });

  it("reports null when the position was flat at resolution", async () => {
    const venue = venueWith();
    venue.resolve(SYMBOL, "yes");
    expect(await venue.settledPayoutMicros(SYMBOL)).toBeNull();
    expect(await venue.settledPayoutMicros("GEMI-NOPE")).toBeNull();
  });
});

describe("MockVenue.positions", () => {
  it("reports the signed position of every contract held and leaves out the ones the account is flat in", async () => {
    const venue = venueWith();
    venue.addContract(contract({ symbol: "GEMI-ETH-TEST", eventTicker: "ETH-TEST" }));
    expect(await venue.positions()).toEqual(new Map());

    venue.setBook(SYMBOL, { bids: [[300n, 300n]], asks: [[1_700n, 300n]] });
    venue.setBook("GEMI-ETH-TEST", { bids: [[300n, 300n]], asks: [] });
    await venue.placeOrder(request());
    await venue.placeOrder(request({ symbol: "GEMI-ETH-TEST", outcome: "NO", units: 200n, limitPx: 9_700n }));
    expect(await venue.positions()).toEqual(new Map([[SYMBOL, 300n], ["GEMI-ETH-TEST", -200n]]));

    // Buying the other side back to flat removes the row; so does a resolution.
    await venue.placeOrder(request({ outcome: "NO", units: 300n, limitPx: 9_700n }));
    expect(await venue.positions()).toEqual(new Map([["GEMI-ETH-TEST", -200n]]));
    venue.resolve("GEMI-ETH-TEST", "no");
    expect(await venue.positions()).toEqual(new Map());
    venue.setPosition(SYMBOL, 0n);
    expect((await venue.positions()).has(SYMBOL)).toBe(false);
  });
});

describe("MockVenue.listEvents", () => {
  const ETH = "GEMI-ETH-TEST";

  it("lists a contract it was told nothing else about as a binary event of its own", async () => {
    const venue = venueWith();
    expect(await venue.listEvents()).toEqual([
      {
        ticker: "BTC-TEST",
        title: "BTC-TEST",
        category: "Other",
        subcategory: [],
        underlying: "BTC-TEST",
        shape: "binary",
        cadence: "other",
        description: "",
        source: null,
        termsUrl: null,
        listedAt: new Date("2026-11-14T00:00:00Z"),
        expiresAt: new Date("2026-11-14T00:15:00Z"),
        status: "active",
        volumeUnits: 0n,
        contracts: [{ ...contract(), bestBidPx: null, bestAskPx: null, lastPx: null }],
      },
    ]);
  });

  it("lists the contracts of an event it was told about together, ascending by sort order", async () => {
    const venue = venueWith();
    const meta = {
      ticker: "ETH-TEST",
      title: "ETH price today at 1am",
      category: "Crypto",
      subcategory: ["Ethereum"],
      underlying: "ETH",
      shape: "ladder",
      cadence: "hourly",
      description: "A test ladder",
      source: { agency: "test", index: "ETH-USD" },
      termsUrl: "https://example.test/terms.pdf",
      listedAt: new Date("2026-11-13T23:00:00Z"),
      expiresAt: new Date("2026-11-14T01:00:00Z"),
    } as const;
    venue.addEvent({ ...meta, subcategory: [...meta.subcategory] });
    venue.addContract(contract({ symbol: `${ETH}-HI3100`, eventTicker: "ETH-TEST", label: "$3,100 or above", sortOrder: 1, strike: "3100" }));
    venue.addContract(contract({ symbol: `${ETH}-HI3000`, eventTicker: "ETH-TEST", label: "$3,000 or above", sortOrder: 0, strike: "3000", rules: "Yes at $3,000 or above." }));

    const listed = await venue.listEvents();
    expect(listed.map((event) => event.ticker)).toEqual(["BTC-TEST", "ETH-TEST"]);
    expect(listed[1]).toMatchObject({ ...meta, status: "active", volumeUnits: 0n });
    expect(listed[1]!.contracts.map((info) => [info.symbol, info.sortOrder, info.strike, info.rules])).toEqual([
      [`${ETH}-HI3000`, 0, "3000", "Yes at $3,000 or above."],
      [`${ETH}-HI3100`, 1, "3100", undefined],
    ]);
  });

  it("lists approved and active events only: a status follows from the event's contracts", async () => {
    const venue = venueWith();
    venue.addContract(contract({ symbol: `${ETH}-A`, eventTicker: "ETH-TEST", status: "approved", marketState: "post_only" }));
    venue.addContract(contract({ symbol: `${ETH}-B`, eventTicker: "ETH-TEST", status: "approved", marketState: "post_only", sortOrder: 1 }));
    venue.addContract(contract({ symbol: "GEMI-OLD-TEST", eventTicker: "OLD-TEST" }));
    venue.resolve("GEMI-OLD-TEST", "no");
    const statuses = async () => (await venue.listEvents()).map((event) => [event.ticker, event.status, event.contracts.map((info) => info.status)]);
    expect(await statuses()).toEqual([
      ["BTC-TEST", "active", ["active"]],
      ["ETH-TEST", "approved", ["approved", "approved"]],
    ]);

    // One contract of the event starts trading, then settles: its sibling is still listed with it.
    venue.addContract(contract({ symbol: `${ETH}-A`, eventTicker: "ETH-TEST" }));
    expect((await statuses())[1]).toEqual(["ETH-TEST", "active", ["active", "approved"]]);
    venue.resolve(`${ETH}-A`, "yes");
    expect((await statuses())[1]).toEqual(["ETH-TEST", "approved", ["settled", "approved"]]);
    venue.addContract(contract({ symbol: `${ETH}-B`, eventTicker: "ETH-TEST", status: "under_review", marketState: "closed", sortOrder: 1 }));
    expect((await statuses()).map(([ticker]) => ticker)).toEqual(["BTC-TEST"]);
  });

  it("reports the best bid and ask of its book and the last trade price with every contract", async () => {
    const venue = venueWith();
    const listed = async () => (await venue.listEvents())[0]!.contracts[0];
    expect(await venue.contract(SYMBOL)).toMatchObject({ bestBidPx: null, bestAskPx: null, lastPx: null });
    venue.setBook(SYMBOL, { bids: [[300n, 200n], [200n, 900n]], asks: [[1_700n, 300n]] });
    expect(await venue.contract(SYMBOL)).toMatchObject({ bestBidPx: 300n, bestAskPx: 1_700n, lastPx: null });
    expect(await listed()).toMatchObject({ symbol: SYMBOL, bestBidPx: 300n, bestAskPx: 1_700n, lastPx: null });

    await venue.placeOrder(request());
    expect(await listed()).toMatchObject({ bestBidPx: 300n, bestAskPx: null, lastPx: 1_700n });
    expect(await venue.contract(SYMBOL)).toMatchObject({ lastPx: 1_700n });
    expect((await venue.listEvents())[0]!.volumeUnits).toBe(300n);
  });
});

describe("MockVenue market data", () => {
  // The clock starts on a whole minute.
  const T0 = Date.parse("2026-11-14T00:05:00Z");

  function timed() {
    const clock = { ms: T0 };
    const venue = venueWith(100_000_000n, { now: () => clock.ms });
    return { venue, clock };
  }

  it("returns null for an unknown contract and an empty top of book", async () => {
    const venue = venueWith();
    expect(await venue.contract("GEMI-NOPE")).toBeNull();
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n });
    venue.setBook(SYMBOL, { bids: [[300n, 200n]], asks: [[1_700n, 300n]] });
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: 300n, bidUnits: 200n, askPx: 1_700n, askUnits: 300n });
  });

  it("liveTop: the top of its book as of the last change, without any reading", async () => {
    const { venue, clock } = timed();
    expect(venue.liveTop(SYMBOL)).toBeUndefined(); // no book was ever set
    venue.setBook(SYMBOL, { bids: [[300n, 200n]], asks: [[1_700n, 300n], [1_800n, 500n]] });
    clock.ms += 5_000;
    expect(venue.liveTop(SYMBOL)).toEqual({ top: { bidPx: 300n, bidUnits: 200n, askPx: 1_700n, askUnits: 300n }, atMs: T0 });

    await venue.placeOrder(request()); // takes the whole best ask
    expect(venue.liveTop(SYMBOL)).toEqual({ top: { bidPx: 300n, bidUnits: 200n, askPx: 1_800n, askUnits: 500n }, atMs: T0 + 5_000 });
    clock.ms += 5_000;
    venue.setBook(SYMBOL, { bids: [], asks: [] });
    expect(venue.liveTop(SYMBOL)).toEqual({ top: { bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n }, atMs: T0 + 10_000 });
  });

  it("depth: up to the asked number of levels a side, best first", async () => {
    const venue = venueWith();
    expect(await venue.depth(SYMBOL, 10)).toEqual({ bids: [], asks: [] });
    venue.setBook(SYMBOL, { bids: [[400n, 100n], [300n, 200n], [200n, 500n]], asks: [[1_700n, 300n], [1_800n, 500n]] });
    expect(await venue.depth(SYMBOL, 10)).toEqual({
      bids: [{ px: 400n, units: 100n }, { px: 300n, units: 200n }, { px: 200n, units: 500n }],
      asks: [{ px: 1_700n, units: 300n }, { px: 1_800n, units: 500n }],
    });
    expect(await venue.depth(SYMBOL, 1)).toEqual({ bids: [{ px: 400n, units: 100n }], asks: [{ px: 1_700n, units: 300n }] });
  });

  it("trades: its own fills in YES price space, newest first, at most the asked number", async () => {
    const { venue, clock } = timed();
    expect(await venue.trades(SYMBOL, 50)).toEqual([]);
    venue.setBook(SYMBOL, { bids: [[300n, 500n]], asks: [[1_600n, 100n], [1_700n, 500n]] });
    const bought = await venue.placeOrder(request());
    clock.ms += 7_000;
    const sold = await venue.placeOrder(request({ outcome: "NO", units: 200n, limitPx: 9_700n }));
    if (bought.kind !== "filled" || sold.kind !== "filled") throw new Error("expected both orders to fill");

    expect(await venue.trades(SYMBOL, 50)).toEqual([
      // Buying NO at 9_700 hits the YES bid at 300: a sale in YES terms.
      { id: sold.fills[0]!.tradeId, atMs: T0 + 7_000, px: 300n, units: 200n, taker: "sell" },
      { id: bought.fills[1]!.tradeId, atMs: T0, px: 1_700n, units: 200n, taker: "buy" },
      { id: bought.fills[0]!.tradeId, atMs: T0, px: 1_600n, units: 100n, taker: "buy" },
    ]);
    expect((await venue.trades(SYMBOL, 2)).map((trade) => trade.px)).toEqual([300n, 1_700n]);
    expect(await venue.trades("GEMI-NOPE", 50)).toEqual([]);
  });

  it("history: the last trade price of each step from the first trade to now, carried through quiet steps", async () => {
    const { venue, clock } = timed();
    expect(await venue.history(SYMBOL, 60)).toEqual([]); // never traded
    const tradeAt = async (ms: number, px: bigint) => {
      clock.ms = ms;
      venue.setBook(SYMBOL, { bids: [], asks: [[px, 100n]] });
      expect((await venue.placeOrder(request({ units: 100n, limitPx: px }))).kind).toBe("filled");
    };
    await tradeAt(T0 + 10_000, 1_700n);
    await tradeAt(T0 + 50_000, 1_600n);
    await tradeAt(T0 + 130_000, 1_800n);
    clock.ms = T0 + 200_000;

    expect(await venue.history(SYMBOL, 60)).toEqual([
      { atMs: T0, px: 1_600n },
      { atMs: T0 + 60_000, px: 1_600n },
      { atMs: T0 + 120_000, px: 1_800n },
      { atMs: T0 + 180_000, px: 1_800n },
    ]);
    expect(await venue.history(SYMBOL, 300)).toEqual([{ atMs: T0, px: 1_800n }]);

    // The series ends with the contract: its last minute is the one before the expiry at 00:15.
    clock.ms = Date.parse("2026-11-14T03:00:00Z");
    const whole = await venue.history(SYMBOL, 60);
    expect(whole).toHaveLength(10);
    expect(whole.at(-1)).toEqual({ atMs: Date.parse("2026-11-14T00:14:00Z"), px: 1_800n });
  });
});
