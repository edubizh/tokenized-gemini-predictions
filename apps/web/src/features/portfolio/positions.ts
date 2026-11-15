// The wallet's outcome tokens as position rows: token balances from Solana joined by mint to the
// relayer's markets, and grouped by where each market is in its life. Pure.

import type { ApiMarket, SideName } from "@outcome/relayer/api-types";
import { chancePx } from "@/features/markets/derive";
import { formatClock, formatStrike, type TimeOptions } from "@/features/markets/wording";
import { formatPrice } from "@/lib/format";

/** What one winning unit pays, in micro-dollars: one test dollar per contract. */
export const PAYOUT_PER_UNIT = 10_000n;

export type PositionGroup = "live" | "awaiting" | "redeemable" | "opening";

/** Outcome tokens of one mint held by the wallet, in units. */
export interface TokenBalance {
  mint: string;
  units: bigint;
}

export interface PositionRow {
  mint: string;
  units: bigint;
  side: SideName;
  market: ApiMarket;
  group: PositionGroup;
  /** Live and awaiting: what the tokens are worth at the current chance of their side. Null when no chance is known. */
  valueMicros: bigint | null;
  /** What the tokens pay if their side wins. */
  fullPayoutMicros: bigint;
  /** Settled only: what the tokens pay. Zero for the side that lost. */
  payoutMicros: bigint | null;
  /** Settled only: the cluster time, unix seconds, from which the tokens can be redeemed. */
  redeemAfter: number | null;
}

export interface Portfolio {
  /** The market's window is still running. */
  live: PositionRow[];
  /** The window has ended and the market is not settled on Solana yet. */
  awaiting: PositionRow[];
  /** Settled, and redemption is open. */
  redeemable: PositionRow[];
  /** Settled, and redemption opens shortly. */
  opening: PositionRow[];
  /** Tokens of a mint the relayer does not list. */
  unknown: TokenBalance[];
  /** True when the wallet holds no outcome tokens at all. */
  empty: boolean;
}

export interface PortfolioClock {
  /** The wall clock, unix milliseconds: markets close on it. */
  wallMs: number;
  /** The cluster clock, unix seconds: redemption opens on it. */
  chainSecs: number;
  /** False while the relayer is not answering: the last prices it gave are not prices any more. */
  pricesKnown?: boolean;
}

const CENT_MICROS = 10_000n;

/**
 * What the tokens are worth at the current chance of their side (Yes at the chance, No at 100
 * cents less), an estimate rounded half up to whole cents.
 */
function valueAtChance(market: ApiMarket, side: SideName, units: bigint): bigint | null {
  const chance = chancePx(market);
  if (chance === null) return null;
  const exact = units * (side === "YES" ? chance : PAYOUT_PER_UNIT - chance);
  return ((exact + CENT_MICROS / 2n) / CENT_MICROS) * CENT_MICROS;
}

function rowFor(balance: TokenBalance, market: ApiMarket, side: SideName, clock: PortfolioClock): PositionRow {
  const onchain = market.onchain;
  const base = { mint: balance.mint, units: balance.units, side, market, fullPayoutMicros: balance.units * PAYOUT_PER_UNIT };

  if (onchain?.status === "settled" && onchain.redeemAfter !== null) {
    const payout = BigInt((side === "YES" ? onchain.yesPayout : onchain.noPayout) ?? "0");
    return {
      ...base,
      group: clock.chainSecs >= onchain.redeemAfter ? "redeemable" : "opening",
      valueMicros: null,
      payoutMicros: balance.units * payout,
      redeemAfter: onchain.redeemAfter,
    };
  }
  const valueMicros = clock.pricesKnown === false ? null : valueAtChance(market, side, balance.units);
  const group = market.settleState === "open" && clock.wallMs < market.expiresAt ? "live" : "awaiting";
  return { ...base, group, valueMicros, payoutMicros: null, redeemAfter: null };
}

const yesFirst = (a: PositionRow, b: PositionRow) => (a.side === b.side ? 0 : a.side === "YES" ? -1 : 1);
const bySymbol = (a: PositionRow, b: PositionRow) => a.market.symbol.localeCompare(b.market.symbol);

export function buildPortfolio(balances: readonly TokenBalance[], markets: readonly ApiMarket[], clock: PortfolioClock): Portfolio {
  const byMint = new Map<string, { market: ApiMarket; side: SideName }>();
  for (const market of markets) {
    if (!market.onchain) continue;
    byMint.set(market.onchain.yesMint, { market, side: "YES" });
    byMint.set(market.onchain.noMint, { market, side: "NO" });
  }

  const portfolio: Portfolio = { live: [], awaiting: [], redeemable: [], opening: [], unknown: [], empty: true };
  for (const balance of balances) {
    if (balance.units <= 0n) continue;
    portfolio.empty = false;
    const known = byMint.get(balance.mint);
    if (!known) {
      portfolio.unknown.push({ mint: balance.mint, units: balance.units });
      continue;
    }
    const row = rowFor(balance, known.market, known.side, clock);
    portfolio[row.group].push(row);
  }

  // Soonest deadline first where there is one ahead. Redeemable: what pays first, then newest.
  portfolio.live.sort((a, b) => a.market.expiresAt - b.market.expiresAt || bySymbol(a, b) || yesFirst(a, b));
  portfolio.awaiting.sort((a, b) => a.market.expiresAt - b.market.expiresAt || bySymbol(a, b) || yesFirst(a, b));
  portfolio.opening.sort((a, b) => (a.redeemAfter ?? 0) - (b.redeemAfter ?? 0) || bySymbol(a, b) || yesFirst(a, b));
  const won = (row: PositionRow) => (row.payoutMicros !== null && row.payoutMicros > 0n ? 0 : 1);
  portfolio.redeemable.sort((a, b) => won(a) - won(b) || b.market.expiresAt - a.market.expiresAt || bySymbol(a, b) || yesFirst(a, b));
  return portfolio;
}

const SIDE_WORD: Record<SideName, string> = { YES: "Yes", NO: "No" };

/** How a settled market came out: the side that won, and the final price where the venue gave one. */
export function resultWords(market: Pick<ApiMarket, "strike" | "expiresAt" | "settlementValue" | "resolution" | "onchain">, options: TimeOptions = {}): string {
  const yesPayout = market.onchain?.yesPayout == null ? null : BigInt(market.onchain.yesPayout);
  const noPayout = market.onchain?.noPayout == null ? null : BigInt(market.onchain.noPayout);
  if (yesPayout !== null && noPayout !== null && yesPayout > 0n && noPayout > 0n) {
    return `Settled as a split: Yes pays ${formatPrice(yesPayout)} and No pays ${formatPrice(noPayout)} per contract.`;
  }
  const winner: SideName | null = yesPayout !== null ? (yesPayout > 0n ? "YES" : "NO") : market.resolution === null ? null : market.resolution === "yes" ? "YES" : "NO";
  if (winner === null) return "The result is not in yet.";
  if (market.settlementValue === null || market.strike === null) return `Result: ${SIDE_WORD[winner]}.`;
  const relation = winner === "YES" ? "at or above" : "below";
  const close = formatClock(market.expiresAt, { ...options, zone: true });
  return `Result: ${SIDE_WORD[winner]}. The price was ${formatStrike(market.settlementValue)} at ${close}, ${relation} ${formatStrike(market.strike)}.`;
}

export interface PortfolioSummary {
  /** Live and awaiting positions at the current chance; the ones with no chance are left out. */
  valueMicros: bigint;
  /** False when some position could not be valued, so the value is a lower bound. */
  priced: boolean;
  /** What the winning positions whose redemption is open pay. */
  redeemableMicros: bigint;
  openOrders: number;
  /** Test dollars held by the program for the open orders. */
  heldMicros: bigint;
}

/** The figures at the top of the portfolio. */
export function summarize(portfolio: Portfolio, openOrders: ReadonlyArray<{ holdMicros: bigint }>): PortfolioSummary {
  const held = [...portfolio.live, ...portfolio.awaiting];
  return {
    valueMicros: held.reduce((sum, row) => sum + (row.valueMicros ?? 0n), 0n),
    priced: held.every((row) => row.valueMicros !== null),
    redeemableMicros: portfolio.redeemable.reduce((sum, row) => sum + (row.payoutMicros ?? 0n), 0n),
    openOrders: openOrders.length,
    heldMicros: openOrders.reduce((sum, order) => sum + order.holdMicros, 0n),
  };
}
