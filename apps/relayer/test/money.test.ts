import { describe, it, expect } from "vitest";
import {
  PAYOUT_PER_UNIT,
  PX_MAX,
  PX_MIN,
  UNITS_PER_CONTRACT,
  complementPx,
  cost,
  feeCap,
  formatPx,
  formatUnits,
  parseDecimal,
  parseMicros,
  parsePx,
  parseUnits,
  takerFee,
} from "../src/money.ts";

describe("frozen units", () => {
  it("exposes the unit constants", () => {
    expect(UNITS_PER_CONTRACT).toBe(100n);
    expect(PAYOUT_PER_UNIT).toBe(10_000n);
    expect(PX_MIN).toBe(1n);
    expect(PX_MAX).toBe(9_999n);
  });

  it("pays one dollar for a winning contract", () => {
    expect(UNITS_PER_CONTRACT * PAYOUT_PER_UNIT).toBe(1_000_000n);
  });
});

describe("parseDecimal", () => {
  it("scales a decimal string to an integer with the given number of decimals", () => {
    expect(parseDecimal("1.00", 2)).toBe(100n);
    expect(parseDecimal("0.5", 2)).toBe(50n);
    expect(parseDecimal("16", 2)).toBe(1_600n);
    expect(parseDecimal("0.17", 4)).toBe(1_700n);
    expect(parseDecimal("12.345678", 6)).toBe(12_345_678n);
    expect(parseDecimal("0", 2)).toBe(0n);
    expect(parseDecimal("7", 0)).toBe(7n);
  });

  it("accepts fractional digits beyond the scale only when they are all zeros", () => {
    expect(parseDecimal("0.1700", 2)).toBe(17n);
    expect(parseDecimal("1.000000", 2)).toBe(100n);
    expect(parseDecimal("5.0", 0)).toBe(5n);
    expect(() => parseDecimal("0.001", 2)).toThrow(RangeError);
    expect(() => parseDecimal("0.0001", 2)).toThrow(RangeError);
    expect(() => parseDecimal("1.2345", 2)).toThrow(RangeError);
    expect(() => parseDecimal("5.5", 0)).toThrow(RangeError);
  });

  it("keeps full precision for values beyond the safe integer range", () => {
    expect(parseDecimal("90071992547409931234.56", 2)).toBe(9_007_199_254_740_993_123_456n);
  });

  it.each([
    ["empty", ""],
    ["negative", "-1"],
    ["explicit plus sign", "+1"],
    ["exponent", "1e3"],
    ["upper-case exponent", "1E3"],
    ["leading whitespace", " 1"],
    ["trailing whitespace", "1 "],
    ["trailing newline", "1.0\n"],
    ["missing integer part", ".5"],
    ["missing fractional part", "5."],
    ["two decimal points", "1.2.3"],
    ["comma separator", "1,5"],
    ["thousands separator", "1,000.00"],
    ["hexadecimal", "0x10"],
    ["letters", "abc"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["non-ASCII digits", "١٢"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseDecimal(text, 2)).toThrow(RangeError);
  });

  it.each([
    ["a number", 1],
    ["a bigint", 1n],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["an array", ["1"]],
    ["a String object", new String("1")],
    ["a symbol", Symbol("1")],
  ])("rejects %s instead of coercing it", (_label, value) => {
    expect(() => parseDecimal(value as unknown as string, 2)).toThrow(RangeError);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects a scale of %s", (decimals) => {
    expect(() => parseDecimal("1", decimals)).toThrow(RangeError);
  });
});

describe("parseUnits", () => {
  it("reads a venue quantity in contracts as base units with 2 decimals", () => {
    expect(parseUnits("1.00")).toBe(100n);
    expect(parseUnits("0.5")).toBe(50n);
    expect(parseUnits("16")).toBe(1_600n);
    expect(parseUnits("0.00")).toBe(0n);
    expect(parseUnits("5000.00")).toBe(500_000n);
    expect(parseUnits("1.0000")).toBe(100n);
  });

  it("rejects quantities finer than one unit", () => {
    expect(() => parseUnits("0.001")).toThrow(RangeError);
    expect(() => parseUnits("1.005")).toThrow(RangeError);
  });
});

describe("parsePx", () => {
  it("reads a venue price in dollars per contract as micro-dollars per unit", () => {
    expect(parsePx("0.17")).toBe(1_700n);
    expect(parsePx("0.1700")).toBe(1_700n);
    expect(parsePx("0.01")).toBe(100n);
    expect(parsePx("0.99")).toBe(9_900n);
    expect(parsePx("0.1234")).toBe(1_234n);
  });

  it("accepts the bounds 1 and 9_999", () => {
    expect(parsePx("0.0001")).toBe(1n);
    expect(parsePx("0.9999")).toBe(9_999n);
  });

  it.each(["0", "0.00", "0.0000", "1", "1.00", "1.0000", "2.5", "17"])("rejects the out-of-range price %s", (price) => {
    expect(() => parsePx(price)).toThrow(RangeError);
  });

  it("rejects prices finer than one px", () => {
    expect(() => parsePx("0.00001")).toThrow(RangeError);
    expect(() => parsePx("0.17005")).toThrow(RangeError);
  });
});

describe("parseMicros", () => {
  it("reads a dollar amount as micro-dollars", () => {
    expect(parseMicros("1")).toBe(1_000_000n);
    expect(parseMicros("0.0000")).toBe(0n);
    expect(parseMicros("0.0200")).toBe(20_000n);
    expect(parseMicros("0.000001")).toBe(1n);
    expect(parseMicros("99999.99")).toBe(99_999_990_000n);
  });

  it("rejects amounts finer than one micro-dollar", () => {
    expect(() => parseMicros("0.0000001")).toThrow(RangeError);
  });
});

describe("formatUnits", () => {
  it("always prints 2 decimals", () => {
    expect(formatUnits(100n)).toBe("1.00");
    expect(formatUnits(50n)).toBe("0.50");
    expect(formatUnits(1n)).toBe("0.01");
    expect(formatUnits(0n)).toBe("0.00");
    expect(formatUnits(1_600n)).toBe("16.00");
    expect(formatUnits(500_000n)).toBe("5000.00");
    expect(formatUnits(123_456_789_012_345_678_901n)).toBe("1234567890123456789.01");
  });

  it("rejects a negative quantity", () => {
    expect(() => formatUnits(-1n)).toThrow(RangeError);
  });

  it("round-trips with parseUnits", () => {
    for (let units = 0n; units <= 2_500n; units += 1n) {
      expect(parseUnits(formatUnits(units))).toBe(units);
    }
    expect(parseUnits(formatUnits(9_007_199_254_740_993n))).toBe(9_007_199_254_740_993n);
    expect(formatUnits(parseUnits("11.00"))).toBe("11.00");
  });
});

describe("formatPx", () => {
  it("prints 2 decimals for whole-cent prices", () => {
    expect(formatPx(1_700n)).toBe("0.17");
    expect(formatPx(100n)).toBe("0.01");
    expect(formatPx(5_000n)).toBe("0.50");
    expect(formatPx(9_900n)).toBe("0.99");
  });

  it("prints 4 decimals for prices between cents", () => {
    expect(formatPx(1_234n)).toBe("0.1234");
    expect(formatPx(1n)).toBe("0.0001");
    expect(formatPx(10n)).toBe("0.0010");
    expect(formatPx(9_999n)).toBe("0.9999");
  });

  it.each([0n, 10_000n, -1n, 12_345n])("rejects the out-of-range px %s", (px) => {
    expect(() => formatPx(px)).toThrow(RangeError);
  });

  it("round-trips with parsePx over the whole px range", () => {
    for (let px = PX_MIN; px <= PX_MAX; px += 1n) {
      expect(parsePx(formatPx(px))).toBe(px);
    }
  });
});

describe("cost", () => {
  it("multiplies units by px", () => {
    expect(cost(100n, 1_700n)).toBe(170_000n);
    expect(cost(1_100n, 900n)).toBe(990_000n);
    expect(cost(0n, 5_000n)).toBe(0n);
    expect(cost(1n, 1n)).toBe(1n);
  });

  it("stays exact beyond the safe integer range", () => {
    expect(cost(9_007_199_254_740_993n, 9_999n)).toBe(90_062_985_348_155_189_007n);
  });

  it("rejects a negative quantity", () => {
    expect(() => cost(-1n, 5_000n)).toThrow(RangeError);
  });

  it.each([0n, 10_000n, -1n])("rejects the out-of-range px %s", (px) => {
    expect(() => cost(100n, px)).toThrow(RangeError);
  });
});

describe("complementPx", () => {
  it("returns the price of the opposite outcome", () => {
    expect(complementPx(300n)).toBe(9_700n);
    expect(complementPx(5_000n)).toBe(5_000n);
    expect(complementPx(1n)).toBe(9_999n);
    expect(complementPx(9_999n)).toBe(1n);
  });

  it("is its own inverse and the two sides always sum to the payout", () => {
    for (let px = PX_MIN; px <= PX_MAX; px += 1n) {
      const other = complementPx(px);
      expect(px + other).toBe(PAYOUT_PER_UNIT);
      expect(complementPx(other)).toBe(px);
    }
  });

  it.each([0n, 10_000n, -5n, 20_000n])("rejects the out-of-range px %s", (px) => {
    expect(() => complementPx(px)).toThrow(RangeError);
  });
});

describe("takerFee", () => {
  it("matches the reference values", () => {
    expect(takerFee(10_000n, 4_000n)).toBe(1_680_000n);
    expect(takerFee(50n, 300n)).toBe(10_000n);
    expect(takerFee(1_000n, 5_200n)).toBe(180_000n);
    expect(takerFee(1_000n, 6_000n)).toBe(170_000n);
  });

  it("is zero for a zero quantity at any price", () => {
    for (let px = PX_MIN; px <= PX_MAX; px += 1n) {
      expect(takerFee(0n, px)).toBe(0n);
    }
  });

  it("rounds any positive fee up to the next cent", () => {
    expect(takerFee(1n, 1n)).toBe(10_000n);
    expect(takerFee(100n, 5_000n)).toBe(20_000n); // 0.07 x 1 x 0.5 x 0.5 = $0.0175
    expect(takerFee(100n, 100n)).toBe(10_000n); // $0.000693
  });

  it("is the smallest whole number of cents covering 7% of contracts x P x (1 - P)", () => {
    const scale = 10n ** 10n;
    for (const units of [1n, 7n, 50n, 99n, 100n, 101n, 1_100n, 12_345n, 9_007_199_254_740_993n]) {
      for (let px = PX_MIN; px <= PX_MAX; px += 13n) {
        const fee = takerFee(units, px);
        const exact = 7n * units * px * (10_000n - px); // in cents x 10^10
        expect(fee % 10_000n).toBe(0n);
        const cents = fee / 10_000n;
        expect(cents * scale >= exact).toBe(true);
        expect((cents - 1n) * scale < exact).toBe(true);
      }
    }
  });

  it("is symmetric between a price and its complement", () => {
    for (let px = PX_MIN; px <= 5_000n; px += 7n) {
      expect(takerFee(1_234n, px)).toBe(takerFee(1_234n, 10_000n - px));
    }
  });

  it("never decreases as the price moves toward 50 cents", () => {
    for (const units of [1n, 100n, 1_100n, 500_000n]) {
      let previous = 0n;
      for (let px = PX_MIN; px <= 5_000n; px += 1n) {
        const fee = takerFee(units, px);
        expect(fee >= previous).toBe(true);
        previous = fee;
      }
    }
  });

  it("rejects a negative quantity", () => {
    expect(() => takerFee(-1n, 5_000n)).toThrow(RangeError);
  });

  it.each([0n, 10_000n, -1n, 20_000n])("rejects the out-of-range px %s", (px) => {
    expect(() => takerFee(100n, px)).toThrow(RangeError);
  });
});

describe("feeCap", () => {
  it("is the fee at the limit price plus 3 cents of slack below 50 cents", () => {
    expect(feeCap(1_000n, 1_700n)).toBe(130_000n); // fee at $0.17 is $0.0988 -> 10 cents
    expect(feeCap(0n, 4_000n)).toBe(30_000n);
  });

  it("uses the fee at 50 cents for limits at or above 50 cents", () => {
    expect(feeCap(1_000n, 5_000n)).toBe(210_000n); // fee at $0.50 is $0.175 -> 18 cents
    expect(feeCap(1_000n, 6_000n)).toBe(210_000n); // not the 17 cents charged at $0.60
    expect(feeCap(1_000n, 9_999n)).toBe(210_000n);
  });

  it("takes a custom slack", () => {
    expect(feeCap(1_000n, 1_700n, 0n)).toBe(100_000n);
    expect(feeCap(1_000n, 1_700n, 50_000n)).toBe(150_000n);
  });

  it("covers the fee of the whole quantity filled at any price up to the limit", () => {
    for (const units of [1n, 100n, 1_100n, 54_321n]) {
      for (let limitPx = PX_MIN; limitPx <= PX_MAX; limitPx += 97n) {
        const cap = feeCap(units, limitPx, 0n);
        for (let px = PX_MIN; px <= limitPx; px += 89n) {
          expect(takerFee(units, px) <= cap).toBe(true);
        }
        expect(takerFee(units, limitPx) <= cap).toBe(true);
      }
    }
  });

  it("covers the summed per-fill fees of up to four fills at or below the limit", () => {
    const random = lcg(20261113);
    for (let round = 0; round < 2_000; round += 1) {
      const limitPx = 1n + BigInt(Math.floor(random() * 9_999));
      const cap = feeCap(40_000n, limitPx);
      const fillCount = 1 + Math.floor(random() * 4);
      let remaining = 40_000n;
      let fees = 0n;
      for (let fill = 0; fill < fillCount; fill += 1) {
        const units = fill === fillCount - 1 ? remaining : BigInt(Math.floor(random() * Number(remaining + 1n)));
        const px = 1n + BigInt(Math.floor(random() * Number(limitPx)));
        fees += takerFee(units, px);
        remaining -= units;
      }
      expect(fees <= cap).toBe(true);
    }
  });

  it("rejects a negative quantity", () => {
    expect(() => feeCap(-1n, 5_000n)).toThrow(RangeError);
  });

  it.each([0n, 10_000n, -1n, 20_000n])("rejects the out-of-range limit %s", (limitPx) => {
    expect(() => feeCap(100n, limitPx)).toThrow(RangeError);
  });

  it("rejects a negative slack", () => {
    expect(() => feeCap(100n, 5_000n, -1n)).toThrow(RangeError);
  });
});

/** Small deterministic generator for the randomized checks in this file. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
