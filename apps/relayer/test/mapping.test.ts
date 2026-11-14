import { describe, it, expect } from "vitest";
import { buyCost, sellProceeds, toVenueOrder } from "../src/venue/mapping.ts";
import type { UserAction } from "../src/venue/mapping.ts";
import type { VenueFill } from "../src/venue/types.ts";

function fill(units: bigint, px: bigint, tradeId = "5000000000000001"): VenueFill {
  return { tradeId, units, px, feeMicros: 0n, feeSource: "reported" };
}

describe("toVenueOrder", () => {
  it("buys YES at the user's maximum price", () => {
    expect(toVenueOrder({ kind: "buy", side: "YES", units: 100n, limitPx: 1_700n })).toEqual({
      outcome: "YES",
      units: 100n,
      limitPx: 1_700n,
    });
  });

  it("buys NO at the user's maximum price", () => {
    expect(toVenueOrder({ kind: "buy", side: "NO", units: 250n, limitPx: 9_700n })).toEqual({
      outcome: "NO",
      units: 250n,
      limitPx: 9_700n,
    });
  });

  it("sells YES by buying NO at the complement of the user's minimum price", () => {
    expect(toVenueOrder({ kind: "sell", side: "YES", units: 100n, limitPx: 300n })).toEqual({
      outcome: "NO",
      units: 100n,
      limitPx: 9_700n,
    });
  });

  it("sells NO by buying YES at the complement of the user's minimum price", () => {
    expect(toVenueOrder({ kind: "sell", side: "NO", units: 1_600n, limitPx: 9_100n })).toEqual({
      outcome: "YES",
      units: 1_600n,
      limitPx: 900n,
    });
  });

  it.each([0n, 10_000n, -1n, 20_000n])("rejects the out-of-range limit %s for buys and sells", (limitPx) => {
    expect(() => toVenueOrder({ kind: "buy", side: "YES", units: 100n, limitPx })).toThrow(RangeError);
    expect(() => toVenueOrder({ kind: "sell", side: "YES", units: 100n, limitPx })).toThrow(RangeError);
  });

  it("rejects an action or side it does not know instead of guessing", () => {
    const hold = { kind: "hold", side: "YES", units: 100n, limitPx: 5_000n } as unknown as UserAction;
    const maybe = { kind: "sell", side: "MAYBE", units: 100n, limitPx: 5_000n } as unknown as UserAction;
    const lower = { kind: "buy", side: "yes", units: 100n, limitPx: 5_000n } as unknown as UserAction;
    expect(() => toVenueOrder(hold)).toThrow(RangeError);
    expect(() => toVenueOrder(maybe)).toThrow(RangeError);
    expect(() => toVenueOrder(lower)).toThrow(RangeError);
  });
});

describe("buyCost", () => {
  it("is the sum of units x px over the fills", () => {
    expect(buyCost([fill(200n, 1_100n, "A"), fill(100n, 1_200n, "B")])).toBe(220_000n + 120_000n);
    expect(buyCost([fill(1_100n, 900n)])).toBe(990_000n);
  });

  it("is zero without fills", () => {
    expect(buyCost([])).toBe(0n);
  });
});

describe("sellProceeds", () => {
  it("pays the complement of each fill price, because the fills are buys of the opposite outcome", () => {
    // Selling YES with a minimum of 300 px buys NO up to 9_700 px: $0.97 paid, $1 released, $0.03 kept.
    const order = toVenueOrder({ kind: "sell", side: "YES", units: 100n, limitPx: 300n });
    expect(order.limitPx).toBe(9_700n);
    expect(sellProceeds([fill(100n, 9_700n)])).toBe(30_000n);
  });

  it("adds up several fills", () => {
    expect(sellProceeds([fill(200n, 9_700n, "A"), fill(100n, 9_500n, "B")])).toBe(60_000n + 50_000n);
  });

  it("is zero without fills", () => {
    expect(sellProceeds([])).toBe(0n);
  });

  it("plus the cost of the same fills is the full payout of the units", () => {
    const fills = [fill(200n, 9_700n, "A"), fill(100n, 4_321n, "B"), fill(7n, 1n, "C")];
    expect(buyCost(fills) + sellProceeds(fills)).toBe(307n * 10_000n);
  });

  it("never pays less per unit than the user's minimum, for any fill within the venue limit", () => {
    for (let minPx = 1n; minPx <= 9_999n; minPx += 1n) {
      const { limitPx } = toVenueOrder({ kind: "sell", side: "NO", units: 100n, limitPx: minPx });
      // The worst fill is at the venue limit; a few better ones are checked alongside it.
      for (const venuePx of new Set([limitPx, 1n, (limitPx + 1n) / 2n, limitPx > 1n ? limitPx - 1n : 1n])) {
        expect(sellProceeds([fill(1n, venuePx)]) >= minPx).toBe(true);
        expect(sellProceeds([fill(37n, venuePx)]) >= 37n * minPx).toBe(true);
      }
    }
  });
});
