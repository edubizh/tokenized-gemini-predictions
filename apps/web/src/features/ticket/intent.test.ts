import { describe, expect, it } from "vitest";
import { marketHref, ticketIntent } from "./intent";

describe("the ticket a link asks for", () => {
  it("links to a market, optionally with a side and the sell tab", () => {
    expect(marketHref("GEMI-BTC15M-UP")).toBe("/markets/GEMI-BTC15M-UP");
    expect(marketHref("GEMI-BTC15M-UP", "NO")).toBe("/markets/GEMI-BTC15M-UP?side=no");
    expect(marketHref("GEMI-BTC15M-UP", "YES", "sell")).toBe("/markets/GEMI-BTC15M-UP?side=yes&action=sell");
  });
  it("reads the side and the action back from the query", () => {
    expect(ticketIntent({ side: "no", action: "sell" })).toEqual({ side: "NO", action: "sell" });
    expect(ticketIntent({ side: "yes" })).toEqual({ side: "YES", action: "buy" });
  });
  it("falls back to buying YES for anything else", () => {
    expect(ticketIntent({})).toEqual({ side: "YES", action: "buy" });
    expect(ticketIntent({ side: ["no", "yes"], action: "short" })).toEqual({ side: "YES", action: "buy" });
  });
});
