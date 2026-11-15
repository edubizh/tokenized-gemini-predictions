import { describe, expect, it } from "vitest";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { fixtureMarket } from "@/lib/relayer/fixtures";
import { formatClock, formatStrike, marketTitle, notTradableWords, payoutStatement, priceToBeat, strikeLabel, VENUE_NOT_KNOWN } from "./wording";

const NY = { timeZone: "America/New_York" };
// 2026-11-14 22:00:00 EST
const CLOSE = Date.UTC(2026, 10, 15, 3, 0, 0);
const base = fixtureMarket("GEMI-BTC15M2611150301-UP", CLOSE) as ApiMarket;
const market = (patch: Partial<ApiMarket>): ApiMarket => ({ ...base, title: "BTC price today at 10pm EST", label: "Up", startsAt: CLOSE - 15 * 60_000, expiresAt: CLOSE, strike: "67410.73", ...patch });

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

describe("strikeLabel", () => {
  it("words the strike of a ladder contract as the venue does, digit for digit", () => {
    expect(strikeLabel("68000")).toBe("$68,000 or above");
    expect(strikeLabel("1250000")).toBe("$1,250,000 or above");
    expect(strikeLabel("3.575")).toBe("$3.575 or above");
    expect(strikeLabel("0.84")).toBe("$0.84 or above");
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
  it("titles a contract with the title of its event and its own label, never the venue symbol", () => {
    expect(marketTitle(market({}))).toBe("BTC price today at 10pm EST · Up");
    expect(marketTitle(market({ title: "BTC price on November 15", label: "$68,000 or above" }))).toBe("BTC price on November 15 · $68,000 or above");
    expect(marketTitle(market({}))).not.toContain(base.symbol);
  });
  it("states what YES pays for from the strike: the price to beat, or the strike of a ladder contract", () => {
    expect(payoutStatement(market({}), NY)).toBe("YES pays $1.00 if the price is at or above $67,410.73 at 10:00 PM EST. NO pays $1.00 otherwise.");
    expect(payoutStatement(market({ label: "$68,000 or above", strike: "68000" }), NY)).toBe("YES pays $1.00 if the price is at or above $68,000.00 at 10:00 PM EST. NO pays $1.00 otherwise.");
  });
  it("says when the reference price is set before the strike is known", () => {
    expect(payoutStatement(market({ strike: null }), NY)).toBe("The reference price is set when the window opens at 9:45 PM.");
  });
  it("falls back to the label for a contract that has no strike and is not an Up contract", () => {
    expect(payoutStatement(market({ label: "Rain in Lisbon", strike: null }), NY)).toBe("YES pays $1.00 if: Rain in Lisbon.");
  });
  it("names the price to beat of an Up contract, or when the venue sets it", () => {
    expect(priceToBeat(market({}), NY)).toBe("$67,410.73");
    // The venue publishes it a minute or two after the window opens.
    expect(priceToBeat(market({ strike: null }), NY)).toBe("Set shortly after 9:45 PM");
    expect(priceToBeat(market({ strike: null, venueStatus: VENUE_NOT_KNOWN }), NY)).toBe("Not known while the relayer is not answering");
    expect(priceToBeat(market({ label: "$68,000 or above", strike: "68000" }), NY)).toBeNull();
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
