import { describe, expect, it } from "vitest";
import type { ChainMarket } from "@/lib/chain/reads";
import { fixtureOnchainMarkets } from "@/lib/relayer/fixtures";
import { knownMarkets, marketFromChain, parseTokenName, venueKnown } from "./known";
import { payoutStatement } from "./wording";

const NOW = Date.UTC(2026, 10, 14, 22, 8, 30);
const CLOSE = Math.floor(Date.UTC(2026, 10, 14, 22, 0, 0) / 1000);

const chain = (over: Partial<ChainMarket> = {}): ChainMarket => ({
  address: "Mkt1111111111111111111111111111111111111111",
  symbol: "GEMI-BTC15M2611142200-UP",
  yesMint: "Yes1111111111111111111111111111111111111111",
  noMint: "No11111111111111111111111111111111111111111",
  status: "open",
  closeTs: CLOSE,
  placeCutoffSecs: 60,
  tickPx: 100,
  yesPayout: 0n,
  noPayout: 0n,
  redeemAfter: 0,
  tokenName: "BTC Up 15m 14Nov26 22:00 YES",
  ...over,
});

describe("parseTokenName", () => {
  it("reads the subject and the outcome from an outcome token's name", () => {
    expect(parseTokenName("BTC Up 15m 14Nov26 22:15 YES")).toEqual({ subject: "BTC", label: "Up", strike: null });
    expect(parseTokenName("XRP Up 5m 14Nov26 22:10 NO")).toEqual({ subject: "XRP", label: "Up", strike: null });
    expect(parseTokenName("BTC >=64500 14Nov26 23:00 YES")).toEqual({ subject: "BTC", label: "$64,500 or above", strike: "64500" });
    expect(parseTokenName("COPPER >=6.12 14Nov26 22:00 NO")).toEqual({ subject: "COPPER", label: "$6.12 or above", strike: "6.12" });
    expect(parseTokenName("FEDJAN26 DN25 28Jan26 19:00 YES")).toEqual({ subject: "FEDJAN26", label: "DN25", strike: null });
  });

  it("reads the names given before every market was listed", () => {
    expect(parseTokenName("BTC Up 22:00Z 14 Nov YES")).toEqual({ subject: "BTC", label: "Up", strike: null });
    expect(parseTokenName("ETH Up 09:15Z 3 Jan NO")).toEqual({ subject: "ETH", label: "Up", strike: null });
    expect(parseTokenName("SOL Above 190 by noo 00:00Z 1 Dec YES")).toEqual({ subject: "SOL", label: "Above 190 by noo", strike: null });
  });

  it("gives null for a name in any other form", () => {
    expect(parseTokenName("Some other token")).toBeNull();
    expect(parseTokenName("BTC 22:00Z 14 Nov YES")).toBeNull();
    expect(parseTokenName("BTC 14Nov26 22:15 YES")).toBeNull();
    expect(parseTokenName("")).toBeNull();
  });
});

describe("marketFromChain", () => {
  it("names an open market from its token and takes its event, times and mints from the account", () => {
    const market = marketFromChain(chain());
    expect(market).not.toBeNull();
    expect(market?.symbol).toBe("GEMI-BTC15M2611142200-UP");
    expect(market?.eventTicker).toBe("BTC15M2611142200");
    expect(market?.title).toBe("BTC");
    expect(market?.label).toBe("Up");
    expect(market?.expiresAt).toBe(CLOSE * 1000);
    expect(market?.lastOrderAt).toBe((CLOSE - 60) * 1000);
    expect(market?.settleState).toBe("open");
    expect(market?.book).toBeNull();
    expect(market?.lastPx).toBeNull();
    expect(market?.strike).toBeNull();
    expect(market?.tradable).toBe(false);
    expect(market?.onchain).toMatchObject({ market: chain().address, yesMint: chain().yesMint, noMint: chain().noMint, status: "open", closeTs: CLOSE, yesPayout: null, noPayout: null, redeemAfter: null });
    expect(market && venueKnown(market)).toBe(false);
  });

  it("knows the strike of a ladder contract from its token", () => {
    const market = marketFromChain(chain({ symbol: "GEMI-BTC2611142200-HI64500", tokenName: "BTC >=64500 14Nov26 22:00 YES" }));
    expect(market).toMatchObject({ eventTicker: "BTC2611142200", title: "BTC", label: "$64,500 or above", strike: "64500" });
    expect(market && payoutStatement(market, { timeZone: "UTC" })).toBe("YES pays $1.00 if the price is at or above $64,500.00 at 10:00 PM UTC. NO pays $1.00 otherwise.");
  });

  it("carries a settlement: payouts, the time redemption opens, and the side that won", () => {
    const market = marketFromChain(chain({ status: "settled", yesPayout: 0n, noPayout: 10_000n, redeemAfter: CLOSE + 180 }));
    expect(market?.settleState).toBe("settled");
    expect(market?.resolution).toBe("no");
    expect(market?.onchain).toMatchObject({ status: "settled", yesPayout: "0", noPayout: "10000", redeemAfter: CLOSE + 180 });
    expect(marketFromChain(chain({ status: "settled", yesPayout: 5_000n, noPayout: 5_000n, redeemAfter: CLOSE }))?.resolution).toBeNull();
  });

  it("gives null when the token's name is missing or cannot be read", () => {
    expect(marketFromChain(chain({ tokenName: null }))).toBeNull();
    expect(marketFromChain(chain({ tokenName: "Some other token" }))).toBeNull();
  });

  it("has no event to link to when the symbol is not in the venue's form", () => {
    expect(marketFromChain(chain({ symbol: "ODD" }))?.eventTicker).toBe("");
  });

  it("is worded without a price to beat", () => {
    const market = marketFromChain(chain());
    expect(market && payoutStatement(market, { timeZone: "UTC" })).toBe(
      "YES pays $1.00 if the price is at or above its price to beat at 10:00 PM UTC. NO pays $1.00 otherwise. The price to beat is not known while the relayer is not answering.",
    );
  });
});

describe("knownMarkets", () => {
  const relayer = fixtureOnchainMarkets(NOW);
  const live = relayer[0]!;
  const liveChain = (over: Partial<ChainMarket> = {}): ChainMarket =>
    chain({ address: live.onchain!.market, symbol: live.symbol, yesMint: live.onchain!.yesMint, noMint: live.onchain!.noMint, closeTs: live.onchain!.closeTs, ...over });

  it("is the relayer's list, as it is, while the relayer answers", () => {
    expect(knownMarkets({ relayer, chain: [liveChain({ status: "settled", yesPayout: 10_000n, redeemAfter: 5 })], offline: false })).toEqual(relayer);
  });

  it("adds markets only Solana knows, after the relayer's", () => {
    const markets = knownMarkets({ relayer, chain: [chain()], offline: false });
    expect(markets).toHaveLength(relayer.length + 1);
    expect(markets.at(-1)?.symbol).toBe("GEMI-BTC15M2611142200-UP");
    expect(markets.at(-1) && venueKnown(markets.at(-1)!)).toBe(false);
  });

  it("leaves out a market Solana knows but nothing names", () => {
    expect(knownMarkets({ relayer: undefined, chain: [chain({ tokenName: null })], offline: true })).toEqual([]);
  });

  it("offline, keeps the relayer's last names and takes the state from Solana", () => {
    expect(live).toMatchObject({ settleState: "open", strike: "104100" });
    expect(live.book).not.toBeNull();
    const markets = knownMarkets({ relayer, chain: [liveChain({ status: "settled", yesPayout: 10_000n, noPayout: 0n, redeemAfter: live.onchain!.closeTs + 180 })], offline: true });
    const merged = markets.find((market) => market.symbol === live.symbol);
    expect(merged?.strike).toBe(live.strike);
    expect(merged?.title).toBe(live.title);
    expect(merged?.label).toBe("$104,100 or above");
    expect(merged?.book).toBeNull();
    expect(merged?.settleState).toBe("settled");
    expect(merged?.resolution).toBe("yes");
    expect(merged?.onchain).toMatchObject({ status: "settled", yesPayout: "10000", noPayout: "0", redeemAfter: live.onchain!.closeTs + 180, yesSupply: live.onchain!.yesSupply });
    expect(merged && venueKnown(merged)).toBe(true);
    // The others are the relayer's last answer, untouched.
    expect(markets.filter((market) => market.symbol !== live.symbol)).toEqual(relayer.slice(1));
  });

  it("offline with nothing from the relayer, is what Solana knows", () => {
    const markets = knownMarkets({ relayer: undefined, chain: [chain()], offline: true });
    expect(markets.map((market) => market.symbol)).toEqual(["GEMI-BTC15M2611142200-UP"]);
  });
});
