import { describe, expect, it } from "vitest";
import { eventHref, eventIntent, marketHref } from "./routes";

const market = { eventTicker: "BTC2611142300", symbol: "GEMI-BTC2611142300-HI64500" };

describe("links to an event page", () => {
  it("links to an event by its ticker", () => {
    expect(eventHref("BTC2611142300")).toBe("/markets/BTC2611142300");
  });

  it("links to one contract of an event, optionally with a side and the sell tab", () => {
    expect(marketHref(market)).toBe("/markets/BTC2611142300?c=GEMI-BTC2611142300-HI64500");
    expect(marketHref(market, "NO")).toBe("/markets/BTC2611142300?c=GEMI-BTC2611142300-HI64500&side=no");
    expect(marketHref(market, "YES", "sell")).toBe("/markets/BTC2611142300?c=GEMI-BTC2611142300-HI64500&side=yes&action=sell");
    expect(marketHref(market, undefined, "buy")).toBe("/markets/BTC2611142300?c=GEMI-BTC2611142300-HI64500");
  });

  it("reads the contract, the side and the action back from the query", () => {
    expect(eventIntent({ c: "GEMI-BTC2611142300-HI64500", side: "no", action: "sell" })).toEqual({ contract: "GEMI-BTC2611142300-HI64500", side: "NO", action: "sell" });
    expect(eventIntent({ side: "yes" })).toEqual({ contract: null, side: "YES", action: "buy" });
  });

  it("falls back to buying Yes of the contract the page picks for anything else", () => {
    expect(eventIntent({})).toEqual({ contract: null, side: "YES", action: "buy" });
    expect(eventIntent({ c: ["A", "B"], side: ["no", "yes"], action: "short" })).toEqual({ contract: null, side: "YES", action: "buy" });
  });
});
