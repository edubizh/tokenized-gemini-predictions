import { describe, expect, it } from "vitest";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { buildFixtures, fixtureAddress } from "@/lib/relayer/fixtures";
import { buildPortfolio, resultWords, sideStatement } from "./positions";

const NOW = Date.UTC(2026, 10, 14, 15, 0, 0);
const CHAIN = Math.floor(NOW / 1000);
const [btc, eth, , awaiting, settledYes, settledNo] = buildFixtures(NOW).markets as [ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket, ApiMarket];
const markets = [btc, eth, awaiting, settledYes, settledNo];
const at = { wallMs: NOW, chainSecs: CHAIN };

const yes = (market: ApiMarket) => market.onchain!.yesMint;
const no = (market: ApiMarket) => market.onchain!.noMint;

describe("buildPortfolio", () => {
  it("joins balances to markets by mint and values a live position at the book", () => {
    const portfolio = buildPortfolio(
      [
        { mint: no(btc), units: 125n },
        { mint: yes(btc), units: 300n },
      ],
      markets,
      at,
    );
    // The fixture book of the first market: bid $0.55, ask $0.57.
    expect(portfolio.live.map((row) => [row.side, row.units, row.worthMicros, row.fullPayoutMicros])).toEqual([
      ["YES", 300n, 300n * 5_500n, 3_000_000n],
      ["NO", 125n, 125n * 4_300n, 1_250_000n],
    ]);
    expect(portfolio.live[0]?.market.symbol).toBe(btc.symbol);
    expect(portfolio.live[0]?.payoutMicros).toBeNull();
    expect(portfolio.empty).toBe(false);
  });

  it("has no worth for a side nobody bids for", () => {
    const oneSided: ApiMarket = { ...btc, book: { bidPx: null, bidUnits: "0", askPx: "5700", askUnits: "100", at: NOW } };
    const portfolio = buildPortfolio(
      [
        { mint: yes(btc), units: 300n },
        { mint: no(btc), units: 100n },
      ],
      [oneSided],
      at,
    );
    expect(portfolio.live.map((row) => row.worthMicros)).toEqual([null, 100n * 4_300n]);
    expect(buildPortfolio([{ mint: yes(btc), units: 300n }], [{ ...btc, book: null }], at).live[0]?.worthMicros).toBeNull();
  });

  it("drops zero balances", () => {
    const portfolio = buildPortfolio([{ mint: yes(btc), units: 0n }], markets, at);
    expect(portfolio.live).toEqual([]);
    expect(portfolio.empty).toBe(true);
  });

  it("puts an expired market that is not settled under awaiting result", () => {
    const review: ApiMarket = { ...awaiting, symbol: "X-REVIEW", settleState: "needs_review", onchain: { ...awaiting.onchain!, yesMint: fixtureAddress("review-yes") } };
    // The relayer may still say "open" for a moment after the close; the wall clock decides.
    const stale: ApiMarket = { ...btc, symbol: "X-STALE", expiresAt: NOW - 1_000, onchain: { ...btc.onchain!, noMint: fixtureAddress("stale-no") } };
    const portfolio = buildPortfolio(
      [
        { mint: yes(awaiting), units: 500n },
        { mint: fixtureAddress("review-yes"), units: 100n },
        { mint: fixtureAddress("stale-no"), units: 50n },
      ],
      [...markets, review, stale],
      at,
    );
    expect(portfolio.live).toEqual([]);
    expect(portfolio.awaiting.map((row) => [row.market.symbol, row.side, row.units]).sort()).toEqual(
      [
        [awaiting.symbol, "YES", 500n],
        ["X-REVIEW", "YES", 100n],
        ["X-STALE", "NO", 50n],
      ].sort(),
    );
    expect(portfolio.awaiting.every((row) => row.payoutMicros === null && row.worthMicros === null)).toBe(true);
  });

  it("lists settled positions as redeemable once redemption has opened, winners first", () => {
    const portfolio = buildPortfolio(
      [
        { mint: yes(settledNo), units: 250n },
        { mint: yes(settledYes), units: 500n },
        { mint: no(settledYes), units: 40n },
      ],
      markets,
      at,
    );
    expect(portfolio.redeemable.map((row) => [row.market.symbol, row.side, row.payoutMicros])).toEqual([
      [settledYes.symbol, "YES", 5_000_000n],
      [settledYes.symbol, "NO", 0n],
      [settledNo.symbol, "YES", 0n],
    ]);
    expect(portfolio.opening).toEqual([]);
  });

  it("lists a settled position as opening soon until the cluster clock reaches redeemAfter", () => {
    const redeemAfter = CHAIN + 30;
    const justSettled: ApiMarket = { ...settledYes, onchain: { ...settledYes.onchain!, redeemAfter } };
    const balances = [{ mint: yes(settledYes), units: 500n }];

    const before = buildPortfolio(balances, [justSettled], { wallMs: NOW, chainSecs: redeemAfter - 1 });
    expect(before.redeemable).toEqual([]);
    expect(before.opening.map((row) => [row.side, row.payoutMicros, row.redeemAfter])).toEqual([["YES", 5_000_000n, redeemAfter]]);

    // The program accepts a redeem from `redeem_after` on, and so does the list.
    const open = buildPortfolio(balances, [justSettled], { wallMs: NOW, chainSecs: redeemAfter });
    expect(open.opening).toEqual([]);
    expect(open.redeemable).toHaveLength(1);

    // The wall clock running ahead of the cluster does not open it early.
    const ahead = buildPortfolio(balances, [justSettled], { wallMs: NOW + 120_000, chainSecs: redeemAfter - 1 });
    expect(ahead.opening).toHaveLength(1);
  });

  it("lists tokens of a mint the relayer does not know last, as unknown", () => {
    const stray = fixtureAddress("stray-mint");
    const portfolio = buildPortfolio(
      [
        { mint: stray, units: 700n },
        { mint: yes(btc), units: 300n },
      ],
      markets,
      at,
    );
    expect(portfolio.unknown).toEqual([{ mint: stray, units: 700n }]);
    expect(portfolio.live).toHaveLength(1);
    expect(portfolio.empty).toBe(false);
    // A market without its on-chain account cannot be matched to a mint.
    expect(buildPortfolio([{ mint: yes(btc), units: 300n }], [{ ...btc, onchain: null }], at).unknown).toHaveLength(1);
  });
});

describe("sideStatement", () => {
  const options = { timeZone: "UTC" };

  it("says what each side of an Up market pays for", () => {
    expect(sideStatement(btc, "YES", options)).toBe("YES pays $1.00 if BTC is at or above $104,212.50 at 3:09 PM UTC.");
    expect(sideStatement(btc, "NO", options)).toBe("NO pays $1.00 if BTC is below $104,212.50 at 3:09 PM UTC.");
  });

  it("falls back to the contract label, and to the opening time before the strike is known", () => {
    expect(sideStatement({ ...btc, label: "Rain in Lisbon" }, "YES", options)).toBe("YES pays $1.00 if: Rain in Lisbon.");
    expect(sideStatement({ ...btc, label: "Rain in Lisbon" }, "NO", options)).toBe("NO pays $1.00 if not: Rain in Lisbon.");
    expect(sideStatement({ ...btc, strike: null }, "NO", options)).toBe("The reference price is set when the window opens at 2:54 PM.");
  });
});

describe("resultWords", () => {
  it("names the side that won and the final price against the price to beat", () => {
    expect(resultWords(settledYes, { timeZone: "UTC" })).toBe("Result: YES. ETH was at $3,404.11 at 2:31 PM UTC, at or above the $3,398.40 to beat.");
    expect(resultWords(settledNo, { timeZone: "UTC" })).toBe("Result: NO. SOL was at $186.95 at 2:24 PM UTC, below the $187.32 to beat.");
  });

  it("says less when the venue gave no final price, and spells out a split settlement", () => {
    expect(resultWords({ ...settledYes, settlementValue: null })).toBe("Result: YES.");
    expect(resultWords({ ...settledYes, onchain: { ...settledYes.onchain!, yesPayout: "5000", noPayout: "5000" } })).toBe("Settled as a split: YES pays $0.50 and NO pays $0.50 per contract.");
  });
});
