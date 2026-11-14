import { describe, expect, it } from "vitest";
import {
  countdownParts,
  formatCents,
  formatContracts,
  formatDollars,
  formatLocalTime,
  formatPrice,
  formatSignedDollars,
  formatSol,
  shortAddress,
} from "./format";

describe("formatDollars", () => {
  it("writes micro-dollars as dollars with two decimals and thousands separators", () => {
    expect(formatDollars(1_234_560_000n)).toBe("$1,234.56");
    expect(formatDollars(0n)).toBe("$0.00");
    expect(formatDollars(10_000n)).toBe("$0.01");
    expect(formatDollars(1_000_000_000n)).toBe("$1,000.00");
    expect(formatDollars(999_999_990_000n)).toBe("$999,999.99");
  });

  it("is exact beyond the range of a double", () => {
    expect(formatDollars(9_007_199_254_740_993_010_000n)).toBe("$9,007,199,254,740,993.01");
  });

  it("keeps sub-cent amounts exact instead of rounding them", () => {
    expect(formatDollars(5_700n)).toBe("$0.0057");
    expect(formatDollars(1_234_567n)).toBe("$1.234567");
    expect(formatDollars(5_830_500n)).toBe("$5.8305");
  });

  it("puts the minus sign before the dollar sign", () => {
    expect(formatDollars(-2_500_000n)).toBe("−$2.50");
  });
});

describe("formatSignedDollars", () => {
  it("always shows the direction, except for zero", () => {
    expect(formatSignedDollars(5_830_000n)).toBe("+$5.83");
    expect(formatSignedDollars(-5_830_000n)).toBe("−$5.83");
    expect(formatSignedDollars(0n)).toBe("$0.00");
  });
});

describe("prices", () => {
  it("writes px as dollars per contract", () => {
    expect(formatPrice(5_700n)).toBe("$0.57");
    expect(formatPrice(100n)).toBe("$0.01");
    expect(formatPrice(9_900n)).toBe("$0.99");
    expect(formatPrice(5_750n)).toBe("$0.5750");
  });

  it("writes the cents shorthand for price buttons", () => {
    expect(formatCents(5_700n)).toBe("57¢");
    expect(formatCents(100n)).toBe("1¢");
    expect(formatCents(5_750n)).toBe("57.5¢");
  });

  it("rejects a px outside 1..=9999", () => {
    expect(() => formatPrice(0n)).toThrow(/px out of range/);
    expect(() => formatCents(10_000n)).toThrow(/px out of range/);
  });
});

describe("formatContracts", () => {
  it("writes units as contracts with two decimals", () => {
    expect(formatContracts(150n)).toBe("1.50");
    expect(formatContracts(1n)).toBe("0.01");
    expect(formatContracts(0n)).toBe("0.00");
    expect(formatContracts(123_456_00n)).toBe("123,456.00");
  });
});

describe("formatSol", () => {
  it("writes lamports as SOL with four decimals, never rounding up", () => {
    expect(formatSol(50_000_000n)).toBe("0.0500");
    expect(formatSol(1_000_000_000n)).toBe("1.0000");
    expect(formatSol(98_471_160n)).toBe("0.0984");
    expect(formatSol(2_965_193_200n)).toBe("2.9651");
    expect(formatSol(1_234_999_999_999n)).toBe("1,234.9999");
    expect(formatSol(0n)).toBe("0.0000");
  });
});

describe("shortAddress", () => {
  it("keeps the first and last four characters", () => {
    expect(shortAddress("8rj8Xv3mQk1TnYpZc2WbHs7uLd9fGa4eRt6yNoPiDK8p")).toBe("8rj8…DK8p");
  });

  it("leaves short strings alone", () => {
    expect(shortAddress("8rj8DK8p")).toBe("8rj8DK8p");
  });
});

describe("countdownParts", () => {
  it("writes m:ss below an hour", () => {
    expect(countdownParts(581_000).text).toBe("9:41");
    expect(countdownParts(60_000).text).toBe("1:00");
    expect(countdownParts(5_000).text).toBe("0:05");
  });

  it("writes h:mm:ss from an hour up", () => {
    expect(countdownParts(3_600_000).text).toBe("1:00:00");
    expect(countdownParts(3_723_000)).toEqual({ hours: 1, minutes: 2, seconds: 3, totalSeconds: 3_723, text: "1:02:03" });
  });

  it("rounds a partial second up so zero is shown only at the deadline", () => {
    expect(countdownParts(1).text).toBe("0:01");
    expect(countdownParts(59_001).text).toBe("1:00");
  });

  it("stops at zero", () => {
    expect(countdownParts(0)).toEqual({ hours: 0, minutes: 0, seconds: 0, totalSeconds: 0, text: "0:00" });
    expect(countdownParts(-4_000).text).toBe("0:00");
  });
});

describe("formatLocalTime", () => {
  const at = Date.UTC(2026, 10, 14, 14, 5, 9);

  it("names the zone", () => {
    expect(formatLocalTime(at, { timeZone: "UTC" })).toBe("14:05 UTC");
    expect(formatLocalTime(at, { timeZone: "America/New_York" })).toBe("09:05 EST");
  });

  it("can include seconds", () => {
    expect(formatLocalTime(at, { timeZone: "UTC", seconds: true })).toBe("14:05:09 UTC");
  });
});
