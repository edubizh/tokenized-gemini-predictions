import { describe, expect, it } from "vitest";
import { fixtureSwitches, matchRoute } from "./proxy";

const WALLET = "8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn";
const SYMBOL = "GEMI-BTC2611142300-HI64500";
const TICKER = "BTC2611142300";

describe("matchRoute", () => {
  it("allows the read routes of the relayer API", () => {
    expect(matchRoute("GET", ["health"], "")).toEqual({ kind: "health", upstream: "/health" });
    expect(matchRoute("GET", ["status"], "")).toEqual({ kind: "status", upstream: "/status" });
    expect(matchRoute("GET", ["events"], "")).toEqual({ kind: "events", upstream: "/events" });
    expect(matchRoute("GET", ["events", TICKER], "")).toEqual({ kind: "event", ticker: TICKER, upstream: `/events/${TICKER}` });
    expect(matchRoute("GET", ["markets"], "")).toEqual({ kind: "markets", upstream: "/markets" });
    expect(matchRoute("GET", ["markets", SYMBOL], "")).toEqual({ kind: "market", symbol: SYMBOL, upstream: `/markets/${SYMBOL}` });
    expect(matchRoute("GET", ["orders"], `?user=${WALLET}`)).toEqual({ kind: "orders", user: WALLET, upstream: `/orders?user=${WALLET}` });
    expect(matchRoute("GET", ["orders", WALLET], "")).toEqual({ kind: "order", address: WALLET, upstream: `/orders/${WALLET}` });
  });

  it("allows the book, the tape and the price history of one contract", () => {
    expect(matchRoute("GET", ["markets", SYMBOL, "depth"], "")).toEqual({ kind: "depth", symbol: SYMBOL, upstream: `/markets/${SYMBOL}/depth` });
    expect(matchRoute("GET", ["markets", SYMBOL, "trades"], "")).toEqual({ kind: "trades", symbol: SYMBOL, upstream: `/markets/${SYMBOL}/trades` });
    expect(matchRoute("GET", ["markets", SYMBOL, "history"], "")).toEqual({ kind: "history", symbol: SYMBOL, upstream: `/markets/${SYMBOL}/history` });
  });

  it("allows creating a market on-chain, by POST only", () => {
    expect(matchRoute("POST", ["markets", SYMBOL, "ensure"], "")).toEqual({ kind: "ensure", symbol: SYMBOL, upstream: `/markets/${SYMBOL}/ensure` });
    expect(matchRoute("GET", ["markets", SYMBOL, "ensure"], "")).toBeNull();
    expect(matchRoute("POST", ["markets", SYMBOL, "depth"], "")).toBeNull();
  });

  it("rebuilds the upstream path, so a query it does not know never travels", () => {
    expect(matchRoute("GET", ["markets"], "?scope=all")).toEqual({ kind: "markets", upstream: "/markets" });
    expect(matchRoute("GET", ["events"], "?status=settled&limit=5000")).toEqual({ kind: "events", upstream: "/events" });
  });

  it("refuses everything else", () => {
    expect(matchRoute("GET", ["admin"], "")).toBeNull();
    expect(matchRoute("POST", ["health"], "")).toBeNull();
    expect(matchRoute("POST", ["events"], "")).toBeNull();
    expect(matchRoute("DELETE", ["orders", WALLET], "")).toBeNull();
    expect(matchRoute("GET", ["markets", "..", "status"], "")).toBeNull();
    expect(matchRoute("GET", ["markets", "btc%2F.."], "")).toBeNull();
    expect(matchRoute("GET", ["markets", SYMBOL, "orders"], "")).toBeNull();
    expect(matchRoute("GET", ["markets", SYMBOL, "depth", "5"], "")).toBeNull();
    expect(matchRoute("GET", ["events", "btc2611142300"], "")).toBeNull();
    expect(matchRoute("GET", ["events", "BTC-2611142300"], "")).toBeNull();
    expect(matchRoute("GET", ["events", "A".repeat(33)], "")).toBeNull();
    expect(matchRoute("GET", ["events", TICKER, "depth"], "")).toBeNull();
    expect(matchRoute("GET", ["orders"], "")).toBeNull();
    expect(matchRoute("GET", ["orders"], "?user=not-an-address")).toBeNull();
    expect(matchRoute("GET", ["orders", "0OIl"], "")).toBeNull();
    expect(matchRoute("GET", [], "")).toBeNull();
  });
});

describe("fixtureSwitches", () => {
  const off = { relayerOffline: false, chainFailing: false, newWallet: false };

  it("is all off without cookies", () => {
    expect(fixtureSwitches(null)).toEqual(off);
    expect(fixtureSwitches("")).toEqual(off);
    expect(fixtureSwitches("theme=paper; other=1")).toEqual(off);
  });

  it("reads the relayer, chain and wallet switches from their cookies", () => {
    expect(fixtureSwitches("fixtures-relayer=offline")).toEqual({ ...off, relayerOffline: true });
    expect(fixtureSwitches("a=b; fixtures-chain=failing; fixtures-relayer=offline")).toEqual({ ...off, relayerOffline: true, chainFailing: true });
    expect(fixtureSwitches("fixtures-wallet=new")).toEqual({ ...off, newWallet: true });
  });

  it("ignores any other value", () => {
    expect(fixtureSwitches("fixtures-relayer=online; fixtures-chain=ok; fixtures-wallet=registered")).toEqual(off);
    expect(fixtureSwitches("xfixtures-relayer=offline")).toEqual(off);
  });
});
