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
