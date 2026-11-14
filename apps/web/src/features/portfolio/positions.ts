// The wallet's outcome tokens as position rows: token balances from Solana joined by mint to the
// relayer's markets, and grouped by where each market is in its life. Pure.

import type { ApiMarket, SideName } from "@outcome/relayer/api-types";
import { complementPx } from "@outcome/relayer/money";
import { formatClock, formatStrike, payoutStatement, type TimeOptions } from "@/features/markets/wording";
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
  /** Live only: what the tokens would sell for at the best bid for their side. Null when nobody bids. */
  worthMicros: bigint | null;
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
}

/** The best bid for one side in px: the YES bid, or the complement of the YES ask for NO. */
function bidPx(market: Pick<ApiMarket, "book">, side: SideName): bigint | null {
  const raw = side === "YES" ? market.book?.bidPx : market.book?.askPx;
  if (raw === null || raw === undefined) return null;
  return side === "YES" ? BigInt(raw) : complementPx(BigInt(raw));
}

function rowFor(balance: TokenBalance, market: ApiMarket, side: SideName, clock: PortfolioClock): PositionRow {
  const onchain = market.onchain;
  const base = { mint: balance.mint, units: balance.units, side, market, fullPayoutMicros: balance.units * PAYOUT_PER_UNIT };

  if (onchain?.status === "settled" && onchain.redeemAfter !== null) {
    const payout = BigInt((side === "YES" ? onchain.yesPayout : onchain.noPayout) ?? "0");
    return {
      ...base,
      group: clock.chainSecs >= onchain.redeemAfter ? "redeemable" : "opening",
      worthMicros: null,
      payoutMicros: balance.units * payout,
      redeemAfter: onchain.redeemAfter,
    };
  }
  if (market.settleState === "open" && clock.wallMs < market.expiresAt) {
    const bid = bidPx(market, side);
    return { ...base, group: "live", worthMicros: bid === null ? null : balance.units * bid, payoutMicros: null, redeemAfter: null };
  }
  return { ...base, group: "awaiting", worthMicros: null, payoutMicros: null, redeemAfter: null };
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

type Described = Pick<ApiMarket, "underlying" | "label" | "strike" | "startsAt" | "expiresAt">;

/** What one side of a market pays for, in one sentence. */
export function sideStatement(market: Described, side: SideName, options: TimeOptions = {}): string {
  if (market.label !== "Up") return side === "YES" ? `YES pays $1.00 if: ${market.label}.` : `NO pays $1.00 if not: ${market.label}.`;
  if (market.strike === null) return payoutStatement(market, options);
  const close = formatClock(market.expiresAt, { ...options, zone: true });
  const condition = side === "YES" ? "at or above" : "below";
  return `${side} pays $1.00 if ${market.underlying} is ${condition} ${formatStrike(market.strike)} at ${close}.`;
}

/** How a settled market came out: the side that won, and the final price where the venue gave one. */
export function resultWords(market: Pick<ApiMarket, "underlying" | "label" | "strike" | "expiresAt" | "settlementValue" | "resolution" | "onchain">, options: TimeOptions = {}): string {
  const yesPayout = market.onchain?.yesPayout == null ? null : BigInt(market.onchain.yesPayout);
  const noPayout = market.onchain?.noPayout == null ? null : BigInt(market.onchain.noPayout);
  if (yesPayout !== null && noPayout !== null && yesPayout > 0n && noPayout > 0n) {
    return `Settled as a split: YES pays ${formatPrice(yesPayout)} and NO pays ${formatPrice(noPayout)} per contract.`;
  }
  const winner = yesPayout !== null ? (yesPayout > 0n ? "YES" : "NO") : market.resolution === null ? null : market.resolution === "yes" ? "YES" : "NO";
  if (winner === null) return "The result is not in yet.";
  if (market.label !== "Up" || market.settlementValue === null || market.strike === null) return `Result: ${winner}.`;
  const relation = winner === "YES" ? "at or above" : "below";
  const close = formatClock(market.expiresAt, { ...options, zone: true });
  return `Result: ${winner}. ${market.underlying} was at ${formatStrike(market.settlementValue)} at ${close}, ${relation} the ${formatStrike(market.strike)} to beat.`;
}
