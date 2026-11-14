import { describe, expect, it } from "vitest";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { fixtureAddress } from "@/lib/relayer/fixtures";
import { FixtureWorld } from "./world";

const NOW = Date.UTC(2026, 10, 14, 15, 1, 0);
const WALLET = fixtureAddress("world-test-wallet");

function setup() {
  const world = new FixtureWorld();
  const markets = (world.respond({ kind: "markets", scope: "all", upstream: "" }, NOW).body as { markets: ApiMarket[] }).markets;
  const settled = markets.filter((market) => market.onchain?.status === "settled");
  const chainSecs = Math.floor(NOW / 1000);
  return {
    world,
    live: markets.find((market) => market.tradable) as ApiMarket,
    won: settled.find((market) => market.resolution === "yes" && (market.onchain?.redeemAfter ?? 0) <= chainSecs) as ApiMarket,
    lost: settled.find((market) => market.resolution === "no" && (market.onchain?.redeemAfter ?? 0) <= chainSecs) as ApiMarket,
    locked: settled.find((market) => (market.onchain?.redeemAfter ?? 0) > chainSecs) as ApiMarket,
  };
}

const held = (world: FixtureWorld, mint: string, nowMs = NOW) => world.chain(WALLET, nowMs).positions.find((position) => position.mint === mint)?.units ?? "0";
const stable = (world: FixtureWorld, nowMs = NOW) => BigInt(world.chain(WALLET, nowMs).balances.stableMicros);

describe("the simulated chain: redeem", () => {
  it("starts the wallet with a winning, a losing and a not yet redeemable settled position", () => {
    const { world, won, lost, locked } = setup();
    expect(held(world, won.onchain!.yesMint)).toBe("500");
    expect(held(world, lost.onchain!.yesMint)).toBe("250");
    expect(held(world, locked.onchain!.noMint)).toBe("200");
    expect(locked.resolution).toBe("no");
    expect(stable(world)).toBe(1_000_000_000n);
  });

  it("burns winning tokens and pays one test dollar per contract", () => {
    const { world, won } = setup();
    world.redeem({ holder: WALLET, market: won.onchain!.market, outcomeMint: won.onchain!.yesMint, amount: 500n }, NOW);
    expect(held(world, won.onchain!.yesMint)).toBe("0");
    expect(stable(world)).toBe(1_005_000_000n);
    // The balance stays moved later on.
    expect(stable(world, NOW + 60_000)).toBe(1_005_000_000n);
  });

  it("burns losing tokens for nothing, and still succeeds", () => {
    const { world, lost } = setup();
    world.redeem({ holder: WALLET, market: lost.onchain!.market, outcomeMint: lost.onchain!.yesMint, amount: 250n }, NOW);
    expect(held(world, lost.onchain!.yesMint)).toBe("0");
    expect(stable(world)).toBe(1_000_000_000n);
  });

  it("redeems part of a balance", () => {
    const { world, won } = setup();
    world.redeem({ holder: WALLET, market: won.onchain!.market, outcomeMint: won.onchain!.yesMint, amount: 120n }, NOW);
    expect(held(world, won.onchain!.yesMint)).toBe("380");
    expect(stable(world)).toBe(1_001_200_000n);
  });

  it("refuses as the program would", () => {
    const { world, won, live, locked } = setup();
    const redeem = (market: ApiMarket, mint: string, amount: bigint) => () => world.redeem({ holder: WALLET, market: market.onchain!.market, outcomeMint: mint, amount }, NOW);
    expect(redeem(live, live.onchain!.yesMint, 100n)).toThrow("NotSettled");
    expect(redeem(locked, locked.onchain!.noMint, 200n)).toThrow("RedeemLocked");
    expect(redeem(won, won.onchain!.yesMint, 0n)).toThrow("BadQuantity");
    expect(redeem(won, won.onchain!.yesMint, 501n)).toThrow("InsufficientFunds");
    expect(redeem(won, live.onchain!.yesMint, 100n)).toThrow("WrongMint");
    expect(stable(world)).toBe(1_000_000_000n);
    expect(held(world, won.onchain!.yesMint)).toBe("500");
  });

  it("opens the locked market's redemption once the cluster clock passes redeemAfter", () => {
    const { world, locked } = setup();
    const later = locked.onchain!.redeemAfter! * 1000;
    world.redeem({ holder: WALLET, market: locked.onchain!.market, outcomeMint: locked.onchain!.noMint, amount: 200n }, later);
    expect(stable(world, later)).toBe(1_002_000_000n);
  });
});

describe("the simulated relayer: markets", () => {
  it("lists earlier windows under scope=all only, so their tokens and orders can still be named", () => {
    const world = new FixtureWorld();
    const list = (scope: "live" | "all", nowMs = NOW) => (world.respond({ kind: "markets", scope, upstream: "" }, nowMs).body as { markets: ApiMarket[] }).markets;
    // The first live market of the cycle before this one.
    const before = list("live", NOW - 5 * 60_000)[0] as ApiMarket;
    const all = list("all");
    expect(list("live").map((market) => market.symbol)).not.toContain(before.symbol);
    expect(all.map((market) => market.symbol)).toContain(before.symbol);
    expect(new Set(all.map((market) => market.symbol)).size).toBe(all.length);
  });
});

describe("the simulated chain and relayer: place_sell", () => {
  const ORDER = fixtureAddress("world-test-sell");
  const sellInput = (live: ApiMarket, patch: Partial<Parameters<FixtureWorld["placeSell"]>[0]> = {}) => ({
    user: WALLET,
    market: live.onchain!.market,
    order: ORDER,
    outcomeMint: live.onchain!.yesMint,
    side: "YES" as const,
    units: 300n,
    limitPx: 5_500n,
    maxFeeMicros: 90_000n,
    ...patch,
  });
  const order = (world: FixtureWorld, nowMs: number) => world.orders(WALLET, nowMs).find((entry) => entry.address === ORDER);

  it("holds the tokens in an open sell order", () => {
    const { world, live } = setup();
    expect(held(world, live.onchain!.yesMint)).toBe("300");
    world.placeSell(sellInput(live), NOW);
    expect(held(world, live.onchain!.yesMint)).toBe("0");
    expect(stable(world)).toBe(1_000_000_000n);
    expect(world.chain(WALLET, NOW).openOrders.find((entry) => entry.address === ORDER)).toMatchObject({ kind: 1, side: 0, qtyUnits: "300", limitPx: "5500", maxFee: "90000" });
  });

  it("fills a sale at or below the bid: tokens burned, proceeds less the fee paid", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live), NOW);
    const later = NOW + 6_000;
    // Sold at the $0.55 bid: $1.65, less a fee of 6 cents.
    expect(order(world, later)).toMatchObject({ kind: "sell", state: "chain_filled", filledUnits: "300", amountMicros: "1650000", feeMicros: "60000", fills: [{ units: "300", px: "4500" }] });
    expect(held(world, live.onchain!.yesMint, later)).toBe("0");
    expect(stable(world, later)).toBe(1_001_590_000n);
    expect(world.chain(WALLET, later).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
  });

  it("does not fill a sale above the bid, and returns the tokens", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 5_600n }), NOW);
    expect(order(world, NOW + 4_000)).toMatchObject({ state: "venue_not_filled", filledUnits: "0" });
    expect(held(world, live.onchain!.yesMint, NOW + 4_000)).toBe("0");
    const later = NOW + 6_000;
    expect(order(world, later)).toMatchObject({ kind: "sell", state: "chain_cancelled", amountMicros: "0", fills: [] });
    expect(held(world, live.onchain!.yesMint, later)).toBe("300");
    expect(stable(world, later)).toBe(1_000_000_000n);
  });

  it("is refused by the relayer when the minimum proceeds do not exceed the fee cap", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 300n, maxFeeMicros: 90_000n }), NOW);
    expect(order(world, NOW + 6_000)).toMatchObject({ state: "chain_cancelled", venueOrderId: null, detail: "fee_cap" });
    expect(held(world, live.onchain!.yesMint, NOW + 6_000)).toBe("300");
  });

  it("returns the tokens when the user reclaims the order", () => {
    const { world, live } = setup();
    world.placeSell(sellInput(live, { limitPx: 5_600n }), NOW);
    world.cancel(ORDER, NOW + 1_000);
    expect(held(world, live.onchain!.yesMint, NOW + 1_000)).toBe("300");
    expect(world.chain(WALLET, NOW + 1_000).openOrders.some((entry) => entry.address === ORDER)).toBe(false);
  });

  it("refuses as the program would", () => {
    const { world, live, won } = setup();
    expect(() => world.placeSell(sellInput(live, { units: 301n }), NOW)).toThrow("InsufficientFunds");
    expect(() => world.placeSell(sellInput(live, { maxFeeMicros: 1_650_001n }), NOW)).toThrow("FeeCapTooHigh");
    expect(() => world.placeSell(sellInput(live, { outcomeMint: won.onchain!.yesMint }), NOW)).toThrow("WrongMint");
    expect(() => world.placeSell(sellInput(won, { outcomeMint: won.onchain!.yesMint }), NOW)).toThrow("MarketNotOpen");
    expect(held(world, live.onchain!.yesMint)).toBe("300");
  });
});

describe("the simulated chain: markets", () => {
  it("finds a market by one of its mints, with the name its token carries", () => {
    const { world, live } = setup();
    const found = world.chainMarkets({ mints: [live.onchain!.noMint] }, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      address: live.onchain!.market,
      symbol: live.symbol,
      yesMint: live.onchain!.yesMint,
      noMint: live.onchain!.noMint,
      status: "open",
      closeTs: live.onchain!.closeTs,
      yesPayout: "0",
      noPayout: "0",
      redeemAfter: 0,
    });
    expect(found[0]?.tokenName).toMatch(/^BTC Up \d{2}:\d{2}Z \d{1,2} [A-Z][a-z]{2} YES$/);
  });

  it("carries a settlement's payouts and the time redemption opens", () => {
    const { world, won } = setup();
    expect(world.chainMarkets({ markets: [won.onchain!.market] }, NOW)[0]).toMatchObject({ status: "settled", yesPayout: "10000", noPayout: "0", redeemAfter: won.onchain!.redeemAfter });
  });

  it("answers once per market however it was asked for, and not at all for what it does not hold", () => {
    const { world, live, lost } = setup();
    const found = world.chainMarkets({ mints: [live.onchain!.yesMint, live.onchain!.noMint, fixtureAddress("someone-else's-mint")], markets: [live.onchain!.market], symbols: [live.symbol, lost.symbol, "GEMI-NOSUCH-UP"] }, NOW);
    expect(found.map((market) => market.symbol).sort()).toEqual([live.symbol, lost.symbol].sort());
  });
});
