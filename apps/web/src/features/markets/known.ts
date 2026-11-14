// The markets the app can name: the relayer's list, completed from Solana. The relayer knows the
// venue's side (the price to beat, the book, the result as the venue prints it); a market's
// account on Solana knows its symbol, close time, status, mints and payouts, and its outcome
// tokens carry their name. While the relayer is not answering, the state of a market is taken
// from Solana and the relayer's last answer is kept only for what Solana does not hold. Pure.

import type { ApiMarket, ApiOnchainMarket } from "@outcome/relayer/api-types";
import type { ChainMarket } from "@/lib/chain/reads";
import { VENUE_NOT_KNOWN, venueKnown } from "./wording";

export { venueKnown };

/**
 * The relayer names an outcome token `"<UNDERLYING> <Label> <HH:MM>Z <D> <Mon> <YES|NO>"`.
 * Null for a name in any other form.
 */
export function parseTokenName(name: string): { underlying: string; label: string } | null {
  const match = /^(\S+) (.+) \d{2}:\d{2}Z \d{1,2} [A-Z][a-z]{2} (?:YES|NO)$/.exec(name.trim());
  if (!match) return null;
  return { underlying: match[1] as string, label: match[2] as string };
}

function onchainOf(chain: ChainMarket, supplies: Pick<ApiOnchainMarket, "yesSupply" | "noSupply">): ApiOnchainMarket {
  const settled = chain.status === "settled" && chain.redeemAfter > 0;
  return {
    market: chain.address,
    yesMint: chain.yesMint,
    noMint: chain.noMint,
    status: chain.status,
    closeTs: chain.closeTs,
    placeCutoffSecs: chain.placeCutoffSecs,
    ...supplies,
    yesPayout: settled ? chain.yesPayout.toString() : null,
    noPayout: settled ? chain.noPayout.toString() : null,
    redeemAfter: settled ? chain.redeemAfter : null,
  };
}

/** The side a settlement paid in full, or null for a split or an unsettled market. */
function resolutionOf(chain: ChainMarket): ApiMarket["resolution"] {
  if (chain.status !== "settled") return null;
  if (chain.yesPayout > 0n && chain.noPayout === 0n) return "yes";
  if (chain.noPayout > 0n && chain.yesPayout === 0n) return "no";
  return null;
}

/**
 * A market in the relayer's shape from what Solana alone holds. What only the venue knows is
 * left empty and `venueStatus` says so (`venueKnown` is false); supplies are not read and are
 * zero. Null when the market's token name is missing or not in the relayer's form, since then
 * nothing says what the market is about.
 */
export function marketFromChain(chain: ChainMarket): ApiMarket | null {
  const named = chain.tokenName === null ? null : parseTokenName(chain.tokenName);
  if (!named) return null;
  const expiresAt = chain.closeTs * 1000;
  return {
    symbol: chain.symbol,
    eventTicker: "",
    series: "",
    underlying: named.underlying,
    title: `${named.underlying} ${named.label}`,
    label: named.label,
    startsAt: 0,
    expiresAt,
    lastOrderAt: (chain.closeTs - chain.placeCutoffSecs) * 1000,
    strike: null,
    venueStatus: VENUE_NOT_KNOWN,
    marketState: VENUE_NOT_KNOWN,
    tradable: false,
    notTradableReason: "venue_offline",
    tickPx: chain.tickPx.toString(),
    minUnits: "1",
    unitIncrement: "1",
    book: null,
    onchain: onchainOf(chain, { yesSupply: "0", noSupply: "0" }),
    resolution: resolutionOf(chain),
    settlementValue: null,
    settleState: chain.status === "settled" ? "settled" : "open",
  };
}

/** The relayer's last answer for a market with its state replaced by what Solana holds now. */
function withChainFacts(market: ApiMarket, chain: ChainMarket): ApiMarket {
  const settled = chain.status === "settled";
  return {
    ...market,
    // Prices from before the relayer went quiet are not prices any more.
    book: null,
    onchain: onchainOf(chain, { yesSupply: market.onchain?.yesSupply ?? "0", noSupply: market.onchain?.noSupply ?? "0" }),
    resolution: market.resolution ?? resolutionOf(chain),
    settleState: settled ? "settled" : market.settleState === "settled" ? "awaiting_result" : market.settleState,
  };
}

export interface KnownMarketsInput {
  /** The relayer's markets, or its last answer while it is not answering; undefined when it never answered. */
  relayer: readonly ApiMarket[] | undefined;
  /** Market accounts read from Solana. */
  chain: readonly ChainMarket[];
  /** True while the relayer is not answering. */
  offline: boolean;
}

/**
 * While the relayer answers: its list, then the markets only Solana knows. Offline: the same,
 * with the state of every market Solana was asked about taken from Solana.
 */
export function knownMarkets({ relayer, chain, offline }: KnownMarketsInput): ApiMarket[] {
  const listed = relayer ?? [];
  const bySymbol = new Map(chain.map((market) => [market.symbol, market]));
  const merged = listed.map((market) => {
    const facts = offline ? bySymbol.get(market.symbol) : undefined;
    return facts ? withChainFacts(market, facts) : market;
  });
  const symbols = new Set(listed.map((market) => market.symbol));
  for (const market of chain) {
    if (symbols.has(market.symbol)) continue;
    const standIn = marketFromChain(market);
    if (standIn) merged.push(standIn);
  }
  return merged;
}
