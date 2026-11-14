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
    expect(await venue.netPosition(SYMBOL)).toBe(300n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 500_000n);
    // The book was consumed: 300 left at 1_700.
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: null, bidUnits: 0n, askPx: 1_700n, askUnits: 300n });
  });

  it("refuses a FOK when depth within the limit is short and changes nothing", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 100n], [1_800n, 500n]] });
    const result = await venue.placeOrder(request());
    expect(result.kind).toBe("not_filled");
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(200n);

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
    expect(await venue.netPosition(SYMBOL)).toBe(-200n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(300n);
    const cashBefore = await venue.cashMicros();

    const result = await venue.placeOrder(request({ outcome: "NO", units: 100n, limitPx: 9_700n }));
    expect(result.kind).toBe("filled");
    expect(await venue.netPosition(SYMBOL)).toBe(200n);
    expect(await venue.cashMicros()).toBe(cashBefore - 100n * 9_700n + 100n * 10_000n);
  });

  it("releases only the offsetting part when an order flips the position", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[300n, 300n]], asks: [[1_700n, 100n]] });
    await venue.placeOrder(request({ units: 100n }));
    const cashBefore = await venue.cashMicros();
    await venue.placeOrder(request({ outcome: "NO", units: 300n, limitPx: 9_700n }));
    expect(await venue.netPosition(SYMBOL)).toBe(-200n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(300n);
  });
});

describe("MockVenue fault injection", () => {
  it("unknown_after_fill executes the order but reports unknown", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    venue.failNext("unknown_after_fill");
    const order = request();
    expect((await venue.placeOrder(order)).kind).toBe("unknown");
    expect(await venue.netPosition(SYMBOL)).toBe(300n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n);
    expect(await venue.findOrder(order.clientOrderId, SYMBOL, 0)).toEqual({ found: false });
  });

  it("throw does not execute and rejects the promise", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 300n]] });
    venue.failNext("throw");
    const order = request();
    await expect(venue.placeOrder(order)).rejects.toThrow(/injected/);
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
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
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
    expect(await venue.cashMicros()).toBe(10_000_000n - 510_000n);
    expect((await venue.contract(SYMBOL))?.resolutionSide).toBe("no");
  });

  it("pays a winning NO position", async () => {
    const venue = venueWith();
    venue.setBook(SYMBOL, { bids: [[300n, 200n]], asks: [] });
    await venue.placeOrder(request({ outcome: "NO", units: 200n, limitPx: 9_700n }));
    venue.resolve(SYMBOL, "no");
    expect(await venue.netPosition(SYMBOL)).toBe(0n);
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

describe("MockVenue.listContracts", () => {
  it("lists the active contracts with their display fields", async () => {
    const venue = venueWith();
    venue.addContract(contract({ symbol: "GEMI-ETH-TEST", eventTicker: "ETH-TEST", title: "ETH test", label: "Up", series: "ETH15M", strike: "3000.10" }));
    venue.addContract(contract({ symbol: "GEMI-OLD-TEST", eventTicker: "OLD-TEST" }));
    venue.resolve("GEMI-OLD-TEST", "no");
    const listed = await venue.listContracts();
    expect(listed.map((info) => info.symbol)).toEqual([SYMBOL, "GEMI-ETH-TEST"]);
    expect(listed[1]).toMatchObject({ title: "ETH test", label: "Up", series: "ETH15M", strike: "3000.10" });
  });
});

describe("MockVenue market data", () => {
  it("returns null for an unknown contract and an empty top of book", async () => {
    const venue = venueWith();
    expect(await venue.contract("GEMI-NOPE")).toBeNull();
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n });
    venue.setBook(SYMBOL, { bids: [[300n, 200n]], asks: [[1_700n, 300n]] });
    expect(await venue.topOfBook(SYMBOL)).toEqual({ bidPx: 300n, bidUnits: 200n, askPx: 1_700n, askUnits: 300n });
  });
});
