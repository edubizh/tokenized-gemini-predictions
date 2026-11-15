import { describe, expect, it } from "vitest";
import type { ApiMarket } from "@outcome/relayer/api-types";
import { knownMarkets } from "@/features/markets/known";
import type { ChainMarket } from "@/lib/chain/reads";
import { fixtureAddress, fixtureMarket } from "@/lib/relayer/fixtures";
import { buildPortfolio, resultWords, summarize } from "./positions";

const NOW = Date.UTC(2026, 10, 14, 22, 14, 0);
const CHAIN = Math.floor(NOW / 1000);
const fixture = (symbol: string) => fixtureMarket(symbol, NOW) as ApiMarket;
// A fifteen-minute contract that is running, one strike of the hourly ladder, a contract whose
// result the venue has not reported, and two that settled: one Yes, one No.
const btc = fixture("GEMI-BTC15M2611142216-UP");
const strike = fixture("GEMI-BTC2611142218-HI104100");
const awaiting = fixture("GEMI-XRP15M2611142209-UP");
const settledYes = fixture("GEMI-BTC15M2611142211-UP");
const settledNo = fixture("GEMI-BTC15M2611142206-UP");
const markets = [btc, strike, awaiting, settledYes, settledNo];
const at = { wallMs: NOW, chainSecs: CHAIN };

const yes = (market: ApiMarket) => market.onchain!.yesMint;
const no = (market: ApiMarket) => market.onchain!.noMint;

describe("buildPortfolio", () => {
  it("joins balances to markets by mint and values a live position at the current chance", () => {
    const portfolio = buildPortfolio(
      [
        { mint: no(btc), units: 125n },
        { mint: yes(btc), units: 300n },
      ],
      markets,
      at,
    );
    // The fixture book of the first market: bid 55¢, ask 57¢, so the chance of Yes is 56%.
    expect(portfolio.live.map((row) => [row.side, row.units, row.valueMicros, row.fullPayoutMicros])).toEqual([
      ["YES", 300n, 300n * 5_600n, 3_000_000n],
      ["NO", 125n, 125n * 4_400n, 1_250_000n],
    ]);
    expect(portfolio.live[0]?.market.symbol).toBe(btc.symbol);
    expect(portfolio.live[0]?.payoutMicros).toBeNull();
    expect(portfolio.empty).toBe(false);
  });

  it("values at the last trade without both sides of the book, and has no value without either", () => {
    const oneSided: ApiMarket = { ...btc, book: { bidPx: null, bidUnits: "0", askPx: "5700", askUnits: "100", at: NOW }, lastPx: "6000" };
    const held = [
      { mint: yes(btc), units: 300n },
      { mint: no(btc), units: 100n },
    ];
    expect(buildPortfolio(held, [oneSided], at).live.map((row) => row.valueMicros)).toEqual([300n * 6_000n, 100n * 4_000n]);
    expect(buildPortfolio(held, [{ ...btc, book: null, lastPx: null }], at).live.map((row) => row.valueMicros)).toEqual([null, null]);
  });

  it("rounds a value at the chance to whole cents", () => {
    // 0.05 contracts at a chance of 56.01¢ is 2.8005¢: 3¢. At 56.00¢ it is 2.8¢: still 3¢.
    const odd: ApiMarket = { ...btc, book: { bidPx: "5501", bidUnits: "100", askPx: "5700", askUnits: "100", at: NOW } };
    expect(buildPortfolio([{ mint: yes(btc), units: 5n }], [odd], at).live[0]?.valueMicros).toBe(30_000n);
    expect(buildPortfolio([{ mint: yes(btc), units: 1n }], [btc], at).live[0]?.valueMicros).toBe(10_000n);
  });

  it("has no value while prices are not known, such as while the relayer is not answering", () => {
    const portfolio = buildPortfolio([{ mint: yes(btc), units: 300n }], markets, { ...at, pricesKnown: false });
    expect(portfolio.live[0]?.valueMicros).toBeNull();
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
    expect(portfolio.awaiting.every((row) => row.payoutMicros === null)).toBe(true);
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

describe("resultWords", () => {
  it("names the side that won and the final price against the strike", () => {
    expect(resultWords(settledYes, { timeZone: "UTC" })).toBe("Result: Yes. The price was $104,243.90 at 10:11 PM UTC, at or above $104,212.50.");
    expect(resultWords(settledNo, { timeZone: "UTC" })).toBe("Result: No. The price was $104,180.02 at 10:06 PM UTC, below $104,212.50.");
  });

  it("says less when the venue gave no final price, and spells out a split settlement", () => {
    expect(resultWords({ ...settledYes, settlementValue: null })).toBe("Result: Yes.");
    expect(resultWords({ ...settledYes, onchain: { ...settledYes.onchain!, yesPayout: "5000", noPayout: "5000" } })).toBe("Settled as a split: Yes pays $0.50 and No pays $0.50 per contract.");
  });
});

describe("positions without the relayer", () => {
  const CLOSE = Math.floor(Date.UTC(2026, 10, 14, 22, 0, 0) / 1000);
  const account = (id: string, over: Partial<ChainMarket> = {}): ChainMarket => ({
    address: `market-${id}`,
    symbol: `GEMI-${id}15M2611142200-UP`,
    yesMint: `yes-${id}`,
    noMint: `no-${id}`,
    status: "open",
    closeTs: CLOSE,
    placeCutoffSecs: 60,
    tickPx: 100,
    yesPayout: 0n,
    noPayout: 0n,
    redeemAfter: 0,
    tokenName: `${id} Up 22:00Z 14 Nov YES`,
    ...over,
  });
  const accounts = [
    account("BTC"),
    account("ETH", { closeTs: CLOSE - 900 }),
    account("SOL", { closeTs: CLOSE - 1800, status: "settled", yesPayout: 10_000n, noPayout: 0n, redeemAfter: CLOSE - 1500 }),
    account("XRP", { closeTs: CLOSE - 900, status: "settled", yesPayout: 0n, noPayout: 10_000n, redeemAfter: CLOSE + 60 }),
    account("DOGE", { tokenName: null }),
  ];
  const markets = knownMarkets({ relayer: undefined, chain: accounts, offline: true });
  const clock = { wallMs: (CLOSE - 300) * 1000, chainSecs: CLOSE - 300 };
  const held = [
    { mint: "yes-BTC", units: 300n },
    { mint: "no-ETH", units: 100n },
    { mint: "yes-SOL", units: 500n },
    { mint: "no-SOL", units: 50n },
    { mint: "no-XRP", units: 200n },
    { mint: "yes-DOGE", units: 700n },
  ];

  it("groups tokens from their market accounts alone", () => {
    const portfolio = buildPortfolio(held, markets, clock);
    expect(portfolio.live.map((row) => [row.mint, row.valueMicros])).toEqual([["yes-BTC", null]]);
    expect(portfolio.awaiting.map((row) => row.mint)).toEqual(["no-ETH"]);
    expect(portfolio.redeemable.map((row) => [row.mint, row.side, row.payoutMicros])).toEqual([
      ["yes-SOL", "YES", 5_000_000n],
      ["no-SOL", "NO", 0n],
    ]);
    expect(portfolio.opening.map((row) => [row.mint, row.payoutMicros, row.redeemAfter])).toEqual([["no-XRP", 2_000_000n, CLOSE + 60]]);
    // The market account is what Redeem and Clear need.
    expect(portfolio.redeemable[0]?.market.onchain?.market).toBe("market-SOL");
  });

  it("lists by mint what nothing names", () => {
    expect(buildPortfolio(held, markets, clock).unknown).toEqual([{ mint: "yes-DOGE", units: 700n }]);
  });

  it("words a result without a final price", () => {
    expect(resultWords(markets.find((market) => market.title === "SOL")!, { timeZone: "UTC" })).toBe("Result: Yes.");
  });
});

describe("summarize", () => {
  it("adds up the value at the current chance, what is redeemable now, and the open orders", () => {
    const portfolio = buildPortfolio(
      [
        { mint: yes(btc), units: 300n },
        { mint: yes(settledYes), units: 500n },
        { mint: no(settledYes), units: 40n },
      ],
      markets,
      at,
    );
    expect(summarize(portfolio, [{ holdMicros: 2_920_000n }, { holdMicros: 0n }])).toEqual({
      valueMicros: 300n * 5_600n,
      priced: true,
      redeemableMicros: 5_000_000n,
      openOrders: 2,
      heldMicros: 2_920_000n,
    });
  });

  it("says when a position has no value it could be counted at", () => {
    const portfolio = buildPortfolio([{ mint: yes(btc), units: 300n }], [{ ...btc, book: null, lastPx: null }], at);
    expect(summarize(portfolio, [])).toEqual({ valueMicros: 0n, priced: false, redeemableMicros: 0n, openOrders: 0, heldMicros: 0n });
  });
});
