import { describe, it, expect } from "vitest";
import { FillAggregator } from "../src/venue/fills.ts";
import { parseFrame } from "../src/venue/frames.ts";
import type { VenueFrame } from "../src/venue/frames.ts";

type OrderUpdate = Extract<VenueFrame, { kind: "orderUpdate" }>;

// Synthetic fixtures. They follow the shape of frames recorded from the venue (ids as bare JSON
// integers, decimals as strings), with invented ids and an invented symbol.
const CLIENT_ID = "o-0123456789abcdef0123456789abcdef";
const ORDER_ID = "700000000000000001";
const TRADE_1 = "5000000000000001";
const TRADE_2 = "5000000000000002";

interface Ids {
  order?: string;
  client?: string | null;
  /** Written as a bare integer when it is all digits, otherwise as a JSON string. */
  trade?: string;
}

function rawUpdate(status: string, fields: Record<string, string | boolean> = {}, ids: Ids = {}): string {
  const parts = [
    '"e":"orderUpdate"',
    '"E":1794624000000000000',
    '"s":"DEMO-BTC15M-UP"',
    `"i":${ids.order ?? ORDER_ID}`,
    '"h":"hA5h0000001a"',
    ...(ids.client === null ? [] : [`"c":${JSON.stringify(ids.client ?? CLIENT_ID)}`]),
    '"S":"BUY"',
    '"o":"LIMIT"',
    `"X":${JSON.stringify(status)}`,
    ...Object.entries(fields).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`),
    ...(ids.trade === undefined ? [] : [`"t":${/^\d+$/.test(ids.trade) ? ids.trade : JSON.stringify(ids.trade)}`]),
    '"T":1794624000000000001',
    '"O":"YES"',
  ];
  return `{${parts.join(",")}}`;
}

/** A parsed order update, built from raw frame text so the real parser is part of every test. */
function update(status: string, fields: Record<string, string | boolean> = {}, ids: Ids = {}): OrderUpdate {
  const raw = rawUpdate(status, fields, ids);
  const frame = parseFrame(raw);
  if (frame.kind !== "orderUpdate") throw new Error(`fixture is not an order update: ${raw}`);
  return frame;
}

function aggregatorFor(requestedUnits: bigint, limitPx: bigint): FillAggregator {
  return new FillAggregator({ clientOrderId: CLIENT_ID, requestedUnits, limitPx });
}

describe("FillAggregator: observed sequences", () => {
  it("is pending before any event", () => {
    expect(aggregatorFor(100n, 1_700n).state()).toEqual({ status: "pending" });
  });

  it("immediate-or-cancel, full fill: counts the fill once although CANCELED repeats the quantity", () => {
    const aggregator = aggregatorFor(100n, 1_700n);

    aggregator.accept(update("NEW", { p: "0.1700", q: "1.00", z: "0.00" }));
    expect(aggregator.state()).toEqual({ status: "pending" });

    aggregator.accept(
      update(
        "FILLED",
        { p: "0.1700", q: "1.00", z: "0.00", Z: "1.00", L: "0.1700", a: "0.1700", n: "0.0000", m: false },
        { trade: TRADE_1 },
      ),
    );
    const filled = {
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_1, units: 100n, px: 1_700n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 100n,
      costMicros: 170_000n,
      feeMicros: 0n,
    };
    expect(aggregator.state()).toEqual(filled);

    // CANCELED carries the cumulative quantity: adding it to the fill would give 200 units.
    aggregator.accept(
      update("CANCELED", { p: "0.1700", q: "1.00", z: "0.00", Z: "1.00", a: "0.1700", r: "ImmediateOrCancelWouldPost" }),
    );
    expect(aggregator.state()).toEqual(filled);
  });

  it("immediate-or-cancel, partial fill: is a fill of the executed part once CANCELED confirms it", () => {
    const aggregator = aggregatorFor(1_600n, 900n);

    aggregator.accept(update("NEW", { p: "0.0900", q: "16.00", z: "0.00" }));
    aggregator.accept(
      update(
        "PARTIALLY_FILLED",
        { p: "0.0900", q: "16.00", z: "5.00", Z: "11.00", L: "0.0900", a: "0.0900", n: "0.0000", m: false },
        { trade: TRADE_1 },
      ),
    );
    expect(aggregator.state()).toEqual({ status: "pending" });

    aggregator.accept(
      update("CANCELED", { p: "0.0900", q: "16.00", z: "5.00", Z: "11.00", a: "0.0900", r: "ImmediateOrCancelWouldPost" }),
    );
    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_1, units: 1_100n, px: 900n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 1_100n,
      costMicros: 990_000n,
      feeMicros: 0n,
    });
  });

  it("immediate-or-cancel, no fill: is not filled", () => {
    const aggregator = aggregatorFor(100n, 1_700n);

    aggregator.accept(update("NEW", { p: "0.1700", q: "1.00", z: "0.00" }));
    aggregator.accept(
      update("CANCELED", { p: "0.1700", q: "1.00", z: "1.00", Z: "0.00", a: "0.0000", r: "ImmediateOrCancelWouldPost" }),
    );
    expect(aggregator.state()).toEqual({
      status: "not_filled",
      venueOrderId: ORDER_ID,
      reason: "ImmediateOrCancelWouldPost",
    });
  });

  it("fill-or-kill that cannot fill: is not filled, with the venue's reason", () => {
    const aggregator = aggregatorFor(500_000n, 1_100n);

    aggregator.accept(update("NEW", { p: "0.1100", q: "5000.00", z: "0.00" }));
    expect(aggregator.state()).toEqual({ status: "pending" });
    aggregator.accept(
      update("CANCELED", { p: "0.1100", q: "5000.00", z: "5000.00", Z: "0.00", a: "0.0000", r: "FillOrKillWouldNotFill" }),
    );
    expect(aggregator.state()).toEqual({
      status: "not_filled",
      venueOrderId: ORDER_ID,
      reason: "FillOrKillWouldNotFill",
    });
  });

  it("fill-or-kill, fill: is filled by FILLED alone, no CANCELED follows", () => {
    const aggregator = aggregatorFor(100n, 1_100n);

    aggregator.accept(update("NEW", { p: "0.1100", q: "1.00", z: "0.00" }));
    aggregator.accept(
      update(
        "FILLED",
        { p: "0.1100", q: "1.00", z: "0.00", Z: "1.00", L: "0.1100", a: "0.1100", n: "0.0000", m: false },
        { trade: TRADE_1 },
      ),
    );
    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_1, units: 100n, px: 1_100n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 100n,
      costMicros: 110_000n,
      feeMicros: 0n,
    });
  });

  it("fill-or-kill sweep across two price levels: adds the two executions", () => {
    const aggregator = aggregatorFor(300n, 1_200n);

    aggregator.accept(update("NEW", { p: "0.1200", q: "3.00", z: "0.00" }));
    aggregator.accept(
      update(
        "PARTIALLY_FILLED",
        { p: "0.1200", q: "3.00", z: "1.00", Z: "2.00", L: "0.1100", a: "0.1100", n: "0.0000", m: false },
        { trade: "A" },
      ),
    );
    expect(aggregator.state()).toEqual({ status: "pending" });

    aggregator.accept(
      update(
        "FILLED",
        { p: "0.1200", q: "3.00", z: "0.00", Z: "1.00", L: "0.1200", a: "0.1133", n: "0.0000", m: false },
        { trade: "B" },
      ),
    );
    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [
        { tradeId: "A", units: 200n, px: 1_100n, feeMicros: 0n, feeSource: "reported" },
        { tradeId: "B", units: 100n, px: 1_200n, feeMicros: 0n, feeSource: "reported" },
      ],
      filledUnits: 300n,
      costMicros: 220_000n + 120_000n,
      feeMicros: 0n,
    });
  });

  it("stays pending on a FILLED event that leaves the order short because an earlier fill is missing", () => {
    const aggregator = aggregatorFor(300n, 1_200n);

    aggregator.accept(update("NEW", { p: "0.1200", q: "3.00", z: "0.00" }));
    // The PARTIALLY_FILLED event for the first 2.00 never arrived.
    aggregator.accept(
      update("FILLED", { p: "0.1200", q: "3.00", z: "0.00", Z: "1.00", L: "0.1200", n: "0.0000" }, { trade: "B" }),
    );
    expect(aggregator.state()).toEqual({ status: "pending" });
  });
});

describe("FillAggregator: fees", () => {
  const fillOf = (aggregator: FillAggregator) => {
    const state = aggregator.state();
    if (state.status !== "filled") throw new Error(`expected a fill, got ${state.status}`);
    return state;
  };

  it("takes a fee the venue reports, in micro-dollars", () => {
    const aggregator = aggregatorFor(100n, 1_100n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1100", n: "0.0200" }, { trade: TRADE_1 }));
    expect(fillOf(aggregator).fills).toEqual([
      { tradeId: TRADE_1, units: 100n, px: 1_100n, feeMicros: 20_000n, feeSource: "reported" },
    ]);
    expect(fillOf(aggregator).feeMicros).toBe(20_000n);
  });

  it("computes the taker fee when the venue reports none", () => {
    const aggregator = aggregatorFor(1_000n, 5_200n);
    aggregator.accept(update("FILLED", { Z: "10.00", L: "0.5200" }, { trade: TRADE_1 }));
    // 0.07 x 10 contracts x 0.52 x 0.48 = $0.17472, rounded up to $0.18.
    expect(fillOf(aggregator).fills).toEqual([
      { tradeId: TRADE_1, units: 1_000n, px: 5_200n, feeMicros: 180_000n, feeSource: "computed" },
    ]);
    expect(fillOf(aggregator).feeMicros).toBe(180_000n);
  });

  it("adds the fees of several fills, each from its own source", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0200" }, { trade: "A" }));
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1200" }, { trade: "B" }));
    const state = fillOf(aggregator);
    expect(state.fills).toEqual([
      { tradeId: "A", units: 200n, px: 1_100n, feeMicros: 20_000n, feeSource: "reported" },
      // 0.07 x 1 x 0.12 x 0.88 = $0.007392, rounded up to one cent.
      { tradeId: "B", units: 100n, px: 1_200n, feeMicros: 10_000n, feeSource: "computed" },
    ]);
    expect(state.feeMicros).toBe(30_000n);
  });

  it.each([
    ["negative", "-0.0100"],
    ["not a number", "free"],
    ["empty", ""],
    ["in exponent notation", "1e-2"],
    ["finer than a micro-dollar", "0.0000001"],
  ])("is inconsistent when the reported fee is %s", (_label, fee) => {
    const aggregator = aggregatorFor(100n, 1_100n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1100", n: fee }, { trade: TRADE_1 }));
    expect(aggregator.state().status).toBe("inconsistent");
  });
});

describe("FillAggregator: fill validation", () => {
  it("is inconsistent when a fill is priced above the limit", () => {
    const aggregator = aggregatorFor(100n, 1_100n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1101", n: "0.0000" }, { trade: TRADE_1 }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("accepts fills priced at the limit and below it", () => {
    const atLimit = aggregatorFor(100n, 1_100n);
    atLimit.accept(update("FILLED", { Z: "1.00", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 }));
    expect(atLimit.state()).toMatchObject({ status: "filled", filledUnits: 100n, costMicros: 110_000n });

    const improved = aggregatorFor(100n, 1_100n);
    improved.accept(update("FILLED", { Z: "1.00", L: "0.0300", n: "0.0000" }, { trade: TRADE_1 }));
    expect(improved.state()).toMatchObject({ status: "filled", filledUnits: 100n, costMicros: 30_000n });
  });

  it("is inconsistent when a single fill is larger than the order", () => {
    const aggregator = aggregatorFor(100n, 1_100n);
    aggregator.accept(update("FILLED", { Z: "1.01", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("is inconsistent when the fills add up to more than the order", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    expect(aggregator.state().status).toBe("pending");
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.01", L: "0.1100", n: "0.0000" }, { trade: "B" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("counts a fill event once however often it is delivered", () => {
    const partial = update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0000" }, { trade: "A" });
    const last = update("FILLED", { Z: "1.00", L: "0.1200", n: "0.0000" }, { trade: "B" });
    const aggregator = aggregatorFor(300n, 1_200n);
    for (const frame of [partial, partial, last, partial, last, last]) aggregator.accept(frame);
    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [
        { tradeId: "A", units: 200n, px: 1_100n, feeMicros: 0n, feeSource: "reported" },
        { tradeId: "B", units: 100n, px: 1_200n, feeMicros: 0n, feeSource: "reported" },
      ],
      filledUnits: 300n,
      costMicros: 340_000n,
      feeMicros: 0n,
    });
  });

  it("is inconsistent when a trade id comes back with a different quantity", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("is inconsistent when a trade id comes back with a different price", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.00", L: "0.1000", n: "0.0000" }, { trade: "A" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it.each([
    ["no trade id", update("FILLED", { Z: "1.00", L: "0.1100", n: "0.0000" })],
    ["an empty trade id", update("FILLED", { Z: "1.00", L: "0.1100", n: "0.0000" }, { trade: "" })],
    ["no quantity", update("FILLED", { L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["an empty quantity", update("FILLED", { Z: "", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["no price", update("FILLED", { Z: "1.00", n: "0.0000" }, { trade: TRADE_1 })],
    ["an empty price", update("FILLED", { Z: "1.00", L: "", n: "0.0000" }, { trade: TRADE_1 })],
    ["no trade id on a partial fill", update("PARTIALLY_FILLED", { Z: "0.50", L: "0.1100", n: "0.0000" })],
    ["a zero quantity", update("FILLED", { Z: "0.00", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["a quantity finer than one unit", update("FILLED", { Z: "0.005", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["a negative quantity", update("FILLED", { Z: "-1.00", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["a quantity that is not a number", update("FILLED", { Z: "one", L: "0.1100", n: "0.0000" }, { trade: TRADE_1 })],
    ["a zero price", update("FILLED", { Z: "1.00", L: "0.0000", n: "0.0000" }, { trade: TRADE_1 })],
    ["a price finer than one px", update("FILLED", { Z: "1.00", L: "0.11005", n: "0.0000" }, { trade: TRADE_1 })],
    ["a price that is not a number", update("FILLED", { Z: "1.00", L: "market", n: "0.0000" }, { trade: TRADE_1 })],
  ])("is inconsistent when a fill event has %s", (_label, frame) => {
    const aggregator = aggregatorFor(100n, 1_100n);
    aggregator.accept(frame);
    expect(aggregator.state().status).toBe("inconsistent");
  });
});

describe("FillAggregator: terminal events", () => {
  const partialFill = () => update("PARTIALLY_FILLED", { Z: "11.00", L: "0.0900", n: "0.0000" }, { trade: TRADE_1 });

  it("is inconsistent, never not-filled, when CANCELED reports a quantity whose fill events were not seen", () => {
    const aggregator = aggregatorFor(1_600n, 900n);
    aggregator.accept(update("NEW", { p: "0.0900", q: "16.00", z: "0.00" }));
    aggregator.accept(update("CANCELED", { z: "5.00", Z: "11.00", r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("is inconsistent when CANCELED reports less than the fills seen", () => {
    const aggregator = aggregatorFor(1_600n, 900n);
    aggregator.accept(partialFill());
    aggregator.accept(update("CANCELED", { z: "6.00", Z: "10.00", r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it.each(["0.00", "0.99", "2.00"])(
    "is inconsistent when CANCELED after a complete fill reports %s instead of the filled quantity",
    (cumulative) => {
      const aggregator = aggregatorFor(100n, 1_700n);
      aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { trade: TRADE_1 }));
      expect(aggregator.state().status).toBe("filled");
      aggregator.accept(update("CANCELED", { Z: cumulative, r: "ImmediateOrCancelWouldPost" }));
      expect(aggregator.state().status).toBe("inconsistent");
    },
  );

  it("is inconsistent when a new fill arrives after CANCELED confirmed the total", () => {
    const aggregator = aggregatorFor(1_600n, 900n);
    aggregator.accept(partialFill());
    aggregator.accept(update("CANCELED", { z: "5.00", Z: "11.00", r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state().status).toBe("filled");
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.00", L: "0.0900", n: "0.0000" }, { trade: TRADE_2 }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("is inconsistent when a fill arrives after CANCELED reported no fill", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("CANCELED", { z: "1.00", Z: "0.00", r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state().status).toBe("not_filled");
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { trade: TRADE_1 }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("treats a missing or empty cumulative quantity as zero", () => {
    const missing = aggregatorFor(100n, 1_700n);
    missing.accept(update("CANCELED", { r: "FillOrKillWouldNotFill" }));
    expect(missing.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "FillOrKillWouldNotFill" });

    const empty = aggregatorFor(100n, 1_700n);
    empty.accept(update("CANCELED", { Z: "", r: "FillOrKillWouldNotFill" }));
    expect(empty.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "FillOrKillWouldNotFill" });

    const afterFill = aggregatorFor(1_600n, 900n);
    afterFill.accept(partialFill());
    afterFill.accept(update("CANCELED", { r: "ImmediateOrCancelWouldPost" }));
    expect(afterFill.state().status).toBe("inconsistent");
  });

  it.each(["abc", "-1.00", "1.005", " "])("is inconsistent when the cumulative quantity reads %j", (cumulative) => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("CANCELED", { Z: cumulative, r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("uses the status as the reason when the venue gives none", () => {
    const missing = aggregatorFor(100n, 1_700n);
    missing.accept(update("CANCELED", { Z: "0.00" }));
    expect(missing.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "CANCELED" });

    const empty = aggregatorFor(100n, 1_700n);
    empty.accept(update("CANCELED", { Z: "0.00", r: "" }));
    expect(empty.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "CANCELED" });
  });

  it("treats REJECTED like CANCELED", () => {
    const withReason = aggregatorFor(100n, 1_700n);
    withReason.accept(update("REJECTED", { Z: "0.00", r: "InsufficientFunds" }));
    expect(withReason.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "InsufficientFunds" });

    const bare = aggregatorFor(100n, 1_700n);
    bare.accept(update("REJECTED"));
    expect(bare.state()).toEqual({ status: "not_filled", venueOrderId: ORDER_ID, reason: "REJECTED" });

    const afterPartial = aggregatorFor(1_600n, 900n);
    afterPartial.accept(partialFill());
    afterPartial.accept(update("REJECTED", { Z: "11.00" }));
    expect(afterPartial.state()).toMatchObject({ status: "filled", filledUnits: 1_100n, costMicros: 990_000n });

    const disagreeing = aggregatorFor(1_600n, 900n);
    disagreeing.accept(update("REJECTED", { Z: "11.00" }));
    expect(disagreeing.state().status).toBe("inconsistent");
  });

  it("keeps the outcome and the first reason when the terminal event is repeated", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("CANCELED", { Z: "0.00", r: "ImmediateOrCancelWouldPost" }));
    aggregator.accept(update("CANCELED", { Z: "0.00", r: "ImmediateOrCancelWouldPost" }));
    aggregator.accept(update("CANCELED", { Z: "0.00", r: "SomethingElse" }));
    expect(aggregator.state()).toEqual({
      status: "not_filled",
      venueOrderId: ORDER_ID,
      reason: "ImmediateOrCancelWouldPost",
    });
  });

  it("stays inconsistent whatever arrives afterwards", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1701", n: "0.0000" }, { trade: TRADE_1 }));
    const first = aggregator.state();
    expect(first.status).toBe("inconsistent");

    aggregator.accept(update("NEW", { p: "0.1700", q: "1.00", z: "0.00" }));
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { trade: TRADE_2 }));
    aggregator.accept(update("CANCELED", { Z: "1.00", r: "ImmediateOrCancelWouldPost" }));
    expect(aggregator.state()).toEqual(first);
  });

  it("describes the inconsistency", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("CANCELED", { Z: "1.00", r: "ImmediateOrCancelWouldPost" }));
    const state = aggregator.state();
    expect(state.status).toBe("inconsistent");
    if (state.status === "inconsistent") expect(state.detail).toMatch(/CANCELED.*100.*0/);
  });
});

describe("FillAggregator: which events count", () => {
  it("ignores events of other orders", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    const other = { client: "o-ffffffffffffffffffffffffffffffff", order: "700000000000000009" };
    aggregator.accept(update("NEW", { p: "0.1700", q: "1.00", z: "0.00" }, other));
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { ...other, trade: TRADE_2 }));
    aggregator.accept(update("CANCELED", { Z: "1.00", r: "ImmediateOrCancelWouldPost" }, other));
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.9900", n: "0.0000" }, { client: null, trade: TRADE_2 }));
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.9900", n: "0.0000" }, { client: "", trade: TRADE_2 }));
    expect(aggregator.state()).toEqual({ status: "pending" });

    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1500", n: "0.0000" }, { trade: TRADE_1 }));
    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_1, units: 100n, px: 1_500n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 100n,
      costMicros: 150_000n,
      feeMicros: 0n,
    });
  });

  it.each(["NEW", "OPEN", "MODIFIED", "PENDING_CANCEL", "filled", "Canceled", ""])(
    "stays pending on the status %j",
    (status) => {
      const aggregator = aggregatorFor(100n, 1_700n);
      aggregator.accept(update(status, { Z: "1.00", L: "0.1700", n: "0.0000" }, { trade: TRADE_1 }));
      expect(aggregator.state()).toEqual({ status: "pending" });
    },
  );

  it("is inconsistent when the venue order id changes between events", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("NEW", { p: "0.1700", q: "1.00", z: "0.00" }));
    aggregator.accept(
      update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { order: "700000000000000002", trade: TRADE_1 }),
    );
    expect(aggregator.state().status).toBe("inconsistent");
  });

  it("completes a sweep whose FILLED event overtakes an earlier fill, keeping arrival order", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1200", n: "0.0000" }, { trade: "B" }));
    expect(aggregator.state()).toEqual({ status: "pending" });
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    expect(aggregator.state()).toMatchObject({
      status: "filled",
      fills: [
        { tradeId: "B", units: 100n, px: 1_200n },
        { tradeId: "A", units: 200n, px: 1_100n },
      ],
      filledUnits: 300n,
      costMicros: 340_000n,
    });
  });

  it("stays pending when partial fills reach the requested quantity without a FILLED or CANCELED event", () => {
    const aggregator = aggregatorFor(300n, 1_200n);
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "2.00", L: "0.1100", n: "0.0000" }, { trade: "A" }));
    aggregator.accept(update("PARTIALLY_FILLED", { Z: "1.00", L: "0.1200", n: "0.0000" }, { trade: "B" }));
    expect(aggregator.state()).toEqual({ status: "pending" });
  });

  it("hands out a snapshot that does not alias its own records", () => {
    const aggregator = aggregatorFor(100n, 1_700n);
    aggregator.accept(update("FILLED", { Z: "1.00", L: "0.1700", n: "0.0000" }, { trade: TRADE_1 }));
    const first = aggregator.state();
    if (first.status !== "filled") throw new Error("expected a fill");
    const fill = first.fills[0];
    if (fill === undefined) throw new Error("expected one fill");
    fill.units = 999n;
    fill.px = 1n;
    first.fills.length = 0;

    expect(aggregator.state()).toEqual({
      status: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_1, units: 100n, px: 1_700n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 100n,
      costMicros: 170_000n,
      feeMicros: 0n,
    });
  });
});

describe("FillAggregator: construction", () => {
  it.each([0n, -1n])("rejects a requested quantity of %s", (requestedUnits) => {
    expect(() => new FillAggregator({ clientOrderId: CLIENT_ID, requestedUnits, limitPx: 1_700n })).toThrow(RangeError);
  });

  it.each([0n, 10_000n, -1n])("rejects the out-of-range limit %s", (limitPx) => {
    expect(() => new FillAggregator({ clientOrderId: CLIENT_ID, requestedUnits: 100n, limitPx })).toThrow(RangeError);
  });

  it("rejects an empty client order id", () => {
    expect(() => new FillAggregator({ clientOrderId: "", requestedUnits: 100n, limitPx: 1_700n })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Property: whatever happens to the event stream, a reported fill is the true fill.
// ---------------------------------------------------------------------------------------------

/** Small seeded generator (mulberry32) so every run sees the same histories. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface History {
  requestedUnits: bigint;
  limitPx: bigint;
  frames: OrderUpdate[];
  trueUnits: bigint;
  trueCost: bigint;
  trueFee: bigint;
}

const twoDecimals = (value: bigint) => `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
const fourDecimals = (value: bigint) => `0.${value.toString().padStart(4, "0")}`;

/** A true history: NEW, 1-4 fills at prices up to the limit, then FILLED-only, FILLED+CANCELED or CANCELED. */
function trueHistory(random: () => number, fillCount: number): History {
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const limitPx = BigInt(int(1, 9_999));
  const sizes = Array.from({ length: fillCount }, () => BigInt(int(1, 400)));
  const trueUnits = sizes.reduce((sum, size) => sum + size, 0n);
  const complete = random() < 0.6;
  const requestedUnits = complete ? trueUnits : trueUnits + BigInt(int(1, 300));
  const cancelFollows = !complete || random() < 0.5;

  const frames: OrderUpdate[] = [
    update("NEW", { p: fourDecimals(limitPx), q: twoDecimals(requestedUnits), z: "0.00" }),
  ];
  let trueCost = 0n;
  let trueFee = 0n;
  sizes.forEach((size, index) => {
    const px = BigInt(int(1, Number(limitPx)));
    const feeCents = BigInt(int(0, 5));
    trueCost += size * px;
    trueFee += feeCents * 10_000n;
    const last = index === sizes.length - 1;
    frames.push(
      update(
        complete && last ? "FILLED" : "PARTIALLY_FILLED",
        { Z: twoDecimals(size), L: fourDecimals(px), n: `0.${feeCents.toString().padStart(2, "0")}00`, m: false },
        { trade: String(5_000_000_000_000_000 + index) },
      ),
    );
  });
  if (cancelFollows) {
    frames.push(update("CANCELED", { Z: twoDecimals(trueUnits), r: "ImmediateOrCancelWouldPost" }));
  }
  return { requestedUnits, limitPx, frames, trueUnits, trueCost, trueFee };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = out[index] as T;
    out[index] = out[other] as T;
    out[other] = held;
  }
  return out;
}

function run(history: History, frames: readonly OrderUpdate[]) {
  const aggregator = aggregatorFor(history.requestedUnits, history.limitPx);
  for (const frame of frames) aggregator.accept(frame);
  return aggregator.state();
}

describe("FillAggregator: property", () => {
  it("never reports a fill other than the true one under reordering, duplication and a dropped frame", () => {
    const random = mulberry32(20261113);
    const seen = { filled: 0, pending: 0, inconsistent: 0, not_filled: 0 };

    for (let round = 0; round < 4_000; round += 1) {
      const history = trueHistory(random, 1 + Math.floor(random() * 4));

      let frames: OrderUpdate[] = [...history.frames];
      if (random() < 0.7) frames = shuffled(frames, random);
      const copies = Math.floor(random() * 4);
      for (let copy = 0; copy < copies; copy += 1) {
        const source = frames[Math.floor(random() * frames.length)] as OrderUpdate;
        frames.splice(Math.floor(random() * (frames.length + 1)), 0, source);
      }
      if (random() < 0.5) frames.splice(Math.floor(random() * frames.length), 1);

      const state = run(history, frames);
      seen[state.status] += 1;
      if (state.status === "filled") {
        expect(state.filledUnits).toBe(history.trueUnits);
        expect(state.costMicros).toBe(history.trueCost);
        expect(state.feeMicros).toBe(history.trueFee);
        expect(state.fills.reduce((sum, fill) => sum + fill.units, 0n)).toBe(history.trueUnits);
      }
      // Every history has at least one true fill, so "not filled" would be wrong too.
      expect(state.status).not.toBe("not_filled");
    }

    // The mutations must actually reach all three legitimate outcomes, or the property is vacuous.
    expect(seen.filled).toBeGreaterThan(200);
    expect(seen.pending).toBeGreaterThan(200);
    expect(seen.inconsistent).toBeGreaterThan(200);
  });

  it("reports exactly the true fill when frames arrive in order, however often they are repeated", () => {
    const random = mulberry32(7);
    for (let round = 0; round < 2_000; round += 1) {
      const history = trueHistory(random, 1 + Math.floor(random() * 4));
      const frames: OrderUpdate[] = [];
      for (const frame of history.frames) {
        const times = 1 + Math.floor(random() * 3);
        for (let time = 0; time < times; time += 1) frames.push(frame);
      }
      expect(run(history, frames)).toMatchObject({
        status: "filled",
        filledUnits: history.trueUnits,
        costMicros: history.trueCost,
        feeMicros: history.trueFee,
      });
    }
  });

  it("never reports a fill for an order the venue did not fill", () => {
    const random = mulberry32(99);
    for (let round = 0; round < 1_000; round += 1) {
      const requestedUnits = BigInt(1 + Math.floor(random() * 1_000));
      const history: History = {
        requestedUnits,
        limitPx: BigInt(1 + Math.floor(random() * 9_999)),
        frames: [
          update("NEW", { q: twoDecimals(requestedUnits), z: "0.00" }),
          update("CANCELED", { z: twoDecimals(requestedUnits), Z: "0.00", a: "0.0000", r: "FillOrKillWouldNotFill" }),
        ],
        trueUnits: 0n,
        trueCost: 0n,
        trueFee: 0n,
      };
      let frames = shuffled(history.frames, random);
      if (random() < 0.5) frames = [...frames, ...frames];
      if (random() < 0.3) frames.splice(Math.floor(random() * frames.length), 1);
      expect(["pending", "not_filled"]).toContain(run(history, frames).status);
    }
  });
});
