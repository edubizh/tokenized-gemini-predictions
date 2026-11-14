import { describe, expect, it } from "vitest";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { buildFixtures } from "@/lib/relayer/fixtures";
import { closesLine, formatClock, formatStrike, listedMarkets, marketTitle, notTradableWords, payoutStatement } from "./wording";

const NY = { timeZone: "America/New_York" };
// 2026-11-14 22:00:00 EST
const CLOSE = Date.UTC(2026, 10, 15, 3, 0, 0);
const base = buildFixtures(CLOSE).markets[0] as ApiMarket;
const market = (patch: Partial<ApiMarket>): ApiMarket => ({ ...base, underlying: "BTC", label: "Up", startsAt: CLOSE - 15 * 60_000, expiresAt: CLOSE, strike: "67410.73", ...patch });

describe("formatStrike", () => {
  it("uses two decimals at 100 and above, with grouping", () => {
    expect(formatStrike("67328.95")).toBe("$67,328.95");
    expect(formatStrike("104212.5")).toBe("$104,212.50");
    expect(formatStrike("100")).toBe("$100.00");
  });
  it("uses three decimals below 100 and five below 1", () => {
    expect(formatStrike("75.44495833333333")).toBe("$75.445");
    expect(formatStrike("0.9908752722666667")).toBe("$0.99088");
  });
  it("rounds half up from the decimal string, without floats", () => {
    expect(formatStrike("67410.725")).toBe("$67,410.73");
    expect(formatStrike("67410.7249999999999999999")).toBe("$67,410.72");
    expect(formatStrike("1.0005")).toBe("$1.001");
    expect(formatStrike("0.000005")).toBe("$0.00001");
  });
  it("keeps the rule of the band a value rounds into", () => {
    expect(formatStrike("99.9996")).toBe("$100.00");
    expect(formatStrike("0.999996")).toBe("$1.000");
  });
  it("accepts a grouped string and leaves anything else alone", () => {
    expect(formatStrike("3,412.08")).toBe("$3,412.08");
    expect(formatStrike("n/a")).toBe("n/a");
  });
});

describe("formatClock", () => {
  it("writes a twelve-hour time with plain spaces, and the zone when asked", () => {
    expect(formatClock(CLOSE, NY)).toBe("10:00 PM");
    expect(formatClock(CLOSE, { ...NY, zone: true })).toBe("10:00 PM EST");
    expect(formatClock(CLOSE - 15 * 60_000, NY)).toBe("9:45 PM");
    expect(formatClock(CLOSE + 7_000, { ...NY, seconds: true })).toBe("10:00:07 PM");
  });
});

describe("market wording", () => {
  it("titles a row with the underlying and the label, never the venue symbol", () => {
    expect(marketTitle(market({}))).toBe("BTC Up");
    expect(marketTitle(market({}))).not.toContain(base.symbol);
  });
  it("gives the closing time", () => {
    expect(closesLine(market({}), NY)).toBe("closes 10:00 PM");
  });
  it("states what YES pays for when the strike is known", () => {
    expect(payoutStatement(market({}), NY)).toBe("YES pays $1.00 if BTC is at or above $67,410.73 at 10:00 PM EST. NO pays $1.00 otherwise.");
  });
  it("says when the reference price is set before the strike is known", () => {
    expect(payoutStatement(market({ strike: null }), NY)).toBe("The reference price is set when the window opens at 9:45 PM.");
  });
  it("falls back to the label for a contract that is not an Up contract", () => {
    expect(payoutStatement(market({ label: "Above 70,000" }), NY)).toBe("YES pays $1.00 if: Above 70,000.");
  });
  it("gives the reason a contract cannot be traded in words", () => {
    expect(notTradableWords(market({ tradable: true, notTradableReason: null }), NY)).toBeNull();
    expect(notTradableWords(market({ tradable: false, notTradableReason: "not_started" }), NY)).toBe("Opens at 9:45 PM");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "too_close_to_expiry" }), NY)).toBe("Orders closed");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "market_not_open" }), NY)).toBe("Orders closed");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "no_offers" }), NY)).toBe("No offers right now");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "paused" }), NY)).toBe("Trading is paused");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "venue_offline" }), NY)).toBe("The venue is offline");
    expect(notTradableWords(market({ tradable: false, notTradableReason: "not_active" }), NY)).toBe("Not open for orders");
  });
});

describe("listedMarkets", () => {
  const now = CLOSE - 60_000;
  it("keeps an expired market until its result is in, then drops it", () => {
    const open = market({ symbol: "A" });
    const awaiting = market({ symbol: "B", expiresAt: now - 1_000, settleState: "awaiting_result", resolution: null });
    const resolved = market({ symbol: "C", expiresAt: now - 1_000, settleState: "awaiting_result", resolution: "yes" });
    const settled = market({ symbol: "D", expiresAt: now - 1_000, settleState: "settled", resolution: "no" });
    expect(listedMarkets([open, awaiting, resolved, settled], now).map((m) => m.symbol)).toEqual(["B", "A"]);
  });
  it("orders by closing time, then underlying", () => {
    const later = market({ symbol: "L", expiresAt: CLOSE + 1 });
    const eth = market({ symbol: "E", underlying: "ETH" });
    const btc = market({ symbol: "B", underlying: "BTC" });
    expect(listedMarkets([later, eth, btc], now).map((m) => m.symbol)).toEqual(["B", "E", "L"]);
  });
});
