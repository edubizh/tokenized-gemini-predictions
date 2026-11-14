import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@outcome/relayer/api-types";
type OrderState = ApiOrder["state"];
import { buildFixtures, FIXTURE_USER, fixtureResponse } from "./fixtures";
import { fixtureSwitches, matchRoute } from "./proxy";

const NOW = Date.UTC(2026, 10, 14, 15, 7, 30);
const WALLET = "8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn";

describe("matchRoute", () => {
  it("allows the read routes of the relayer API", () => {
    expect(matchRoute("GET", ["health"], "")).toEqual({ kind: "health", upstream: "/health" });
    expect(matchRoute("GET", ["status"], "")).toEqual({ kind: "status", upstream: "/status" });
    expect(matchRoute("GET", ["markets"], "")).toEqual({ kind: "markets", scope: "live", upstream: "/markets?scope=live" });
    expect(matchRoute("GET", ["markets"], "?scope=all")).toEqual({ kind: "markets", scope: "all", upstream: "/markets?scope=all" });
    expect(matchRoute("GET", ["markets", "GEMI-BTC15M2611141500-UP"], "")).toEqual({
      kind: "market",
      symbol: "GEMI-BTC15M2611141500-UP",
      upstream: "/markets/GEMI-BTC15M2611141500-UP",
    });
    expect(matchRoute("GET", ["orders"], `?user=${WALLET}`)).toEqual({ kind: "orders", user: WALLET, upstream: `/orders?user=${WALLET}` });
    expect(matchRoute("GET", ["orders", WALLET], "")).toEqual({ kind: "order", address: WALLET, upstream: `/orders/${WALLET}` });
  });

  it("allows creating a market on-chain, by POST only", () => {
    expect(matchRoute("POST", ["markets", "GEMI-BTC15M2611141500-UP", "ensure"], "")).toEqual({
      kind: "ensure",
      symbol: "GEMI-BTC15M2611141500-UP",
      upstream: "/markets/GEMI-BTC15M2611141500-UP/ensure",
    });
    expect(matchRoute("GET", ["markets", "GEMI-BTC15M2611141500-UP", "ensure"], "")).toBeNull();
  });

  it("refuses everything else", () => {
    expect(matchRoute("GET", ["admin"], "")).toBeNull();
    expect(matchRoute("POST", ["health"], "")).toBeNull();
    expect(matchRoute("DELETE", ["orders", WALLET], "")).toBeNull();
    expect(matchRoute("GET", ["markets", "..", "status"], "")).toBeNull();
    expect(matchRoute("GET", ["markets", "btc%2F.."], "")).toBeNull();
    expect(matchRoute("GET", ["markets"], "?scope=everything")).toBeNull();
    expect(matchRoute("GET", ["orders"], "")).toBeNull();
    expect(matchRoute("GET", ["orders"], "?user=not-an-address")).toBeNull();
    expect(matchRoute("GET", ["orders", "0OIl"], "")).toBeNull();
    expect(matchRoute("GET", [], "")).toBeNull();
  });
});

describe("fixtures", () => {
  const fixtures = buildFixtures(NOW);

  it("has three live markets: tradable with a two-sided book, closing soon, not started", () => {
    const live = fixtures.markets.filter((m) => m.settleState === "open" && m.expiresAt > NOW);
    expect(live).toHaveLength(3);
    const [tradable, closing, upcoming] = live;
    expect(tradable?.tradable).toBe(true);
    expect(tradable?.book?.bidPx).not.toBeNull();
    expect(tradable?.book?.askPx).not.toBeNull();
    expect(closing!.expiresAt - NOW).toBeLessThanOrEqual(120_000);
    expect(closing!.expiresAt - NOW).toBeGreaterThan(0);
    expect(upcoming?.startsAt).toBeGreaterThan(NOW);
    expect(upcoming?.tradable).toBe(false);
    expect(upcoming?.notTradableReason).toBe("not_started");
    expect(upcoming?.strike).toBeNull();
  });

  it("has a market awaiting its result and one settled each way", () => {
    const awaiting = fixtures.markets.filter((m) => m.settleState === "awaiting_result");
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]?.expiresAt).toBeLessThan(NOW);
    expect(awaiting[0]?.resolution).toBeNull();
    const settled = fixtures.markets.filter((m) => m.settleState === "settled");
    expect(settled.map((m) => m.resolution).sort()).toEqual(["no", "yes"]);
    for (const market of settled) {
      expect(market.onchain?.status).toBe("settled");
      expect(BigInt(market.onchain!.yesPayout!) + BigInt(market.onchain!.noPayout!)).toBe(10_000n);
      expect(market.onchain?.yesPayout).toBe(market.resolution === "yes" ? "10000" : "0");
    }
  });

  it("has an order in every journal state for one user", () => {
    const states: OrderState[] = [
      "seen", "submitting", "venue_filled", "venue_not_filled", "venue_unknown",
      "chain_filled", "chain_cancelled", "orphaned", "failed",
    ];
    expect(fixtures.orders.map((o) => o.state).sort()).toEqual([...states].sort());
    expect(new Set(fixtures.orders.map((o) => o.user))).toEqual(new Set([FIXTURE_USER]));
    expect(new Set(fixtures.orders.map((o) => o.address)).size).toBe(states.length);
    const filled = fixtures.orders.find((o) => o.state === "chain_filled");
    expect(filled?.chainSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(BigInt(filled!.filledUnits)).toBeGreaterThan(0n);
  });

  it("is deterministic for a given time", () => {
    expect(buildFixtures(NOW)).toEqual(fixtures);
  });

  it("answers every allowed route", () => {
    const symbol = fixtures.markets[0]!.symbol;
    const health = fixtureResponse(matchRoute("GET", ["health"], "")!, NOW);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, cluster: "devnet", venue: "mock", chainTime: Math.floor(NOW / 1000) });

    const liveOnly = fixtureResponse(matchRoute("GET", ["markets"], "")!, NOW).body as { markets: unknown[] };
    expect(liveOnly.markets).toHaveLength(3);
    const all = fixtureResponse(matchRoute("GET", ["markets"], "?scope=all")!, NOW).body as { markets: unknown[] };
    expect(all.markets).toHaveLength(6);

    expect(fixtureResponse(matchRoute("GET", ["markets", symbol], "")!, NOW).body).toMatchObject({ symbol });
    expect(fixtureResponse(matchRoute("POST", ["markets", symbol, "ensure"], "")!, NOW).body).toMatchObject({ symbol });
    expect(fixtureResponse(matchRoute("GET", ["markets", "GEMI-NOPE"], "")!, NOW)).toEqual({ status: 404, body: { error: "unknown market" } });

    const mine = fixtureResponse(matchRoute("GET", ["orders"], `?user=${WALLET}`)!, NOW).body as { orders: Array<{ user: string }> };
    expect(mine.orders).toHaveLength(9);
    expect(mine.orders.every((o) => o.user === WALLET)).toBe(true);

    const order = fixtures.orders[0]!;
    expect(fixtureResponse(matchRoute("GET", ["orders", order.address], "")!, NOW).body).toMatchObject({ address: order.address });
    expect(fixtureResponse(matchRoute("GET", ["orders", WALLET], "")!, NOW)).toEqual({ status: 404, body: { error: "unknown order" } });

    const status = fixtureResponse(matchRoute("GET", ["status"], "")!, NOW).body as { solvency: { ok: boolean } };
    expect(status.solvency.ok).toBe(true);
  });
});

describe("fixtureSwitches", () => {
  it("is all off without cookies", () => {
    expect(fixtureSwitches(null)).toEqual({ relayerOffline: false, chainFailing: false });
    expect(fixtureSwitches("")).toEqual({ relayerOffline: false, chainFailing: false });
    expect(fixtureSwitches("theme=paper; other=1")).toEqual({ relayerOffline: false, chainFailing: false });
  });

  it("reads the relayer and chain switches from their cookies", () => {
    expect(fixtureSwitches("fixtures-relayer=offline")).toEqual({ relayerOffline: true, chainFailing: false });
    expect(fixtureSwitches("a=b; fixtures-chain=failing; fixtures-relayer=offline")).toEqual({ relayerOffline: true, chainFailing: true });
  });

  it("ignores any other value", () => {
    expect(fixtureSwitches("fixtures-relayer=online; fixtures-chain=ok")).toEqual({ relayerOffline: false, chainFailing: false });
    expect(fixtureSwitches("xfixtures-relayer=offline")).toEqual({ relayerOffline: false, chainFailing: false });
  });
});
