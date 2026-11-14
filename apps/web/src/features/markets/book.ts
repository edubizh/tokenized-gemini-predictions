// The top of the book as each side sees it. The relayer reports the book in YES price space;
// buying NO at `p` is the same venue trade as selling YES at `$1 - p`.

import type { ApiMarket, SideName } from "@outcome/relayer/api-types";
import { complementPx } from "@outcome/relayer/money";

type Booked = Pick<ApiMarket, "book">;

/** The price to buy one side now, in px. Null when nothing is offered. */
export function askPx(market: Booked, side: SideName): bigint | null {
  const raw = side === "YES" ? market.book?.askPx : market.book?.bidPx;
  if (raw === null || raw === undefined) return null;
  return side === "YES" ? BigInt(raw) : complementPx(BigInt(raw));
}

/** Units offered at the ask of a side. */
export function askUnits(market: Booked, side: SideName): bigint {
  const raw = side === "YES" ? market.book?.askUnits : market.book?.bidUnits;
  return BigInt(raw ?? "0");
}

/** Units a buy with this limit could take now: zero below the ask. Null when there is no book. */
export function availableAt(market: Booked, side: SideName, limitPx: bigint): bigint | null {
  if (!market.book) return null;
  const ask = askPx(market, side);
  if (ask === null || limitPx < ask) return 0n;
  return askUnits(market, side);
}

/** The best bid for one side in px: the YES bid, or the complement of the YES ask for NO. Null when nobody bids. */
export function bidPx(market: Booked, side: SideName): bigint | null {
  const raw = side === "YES" ? market.book?.bidPx : market.book?.askPx;
  if (raw === null || raw === undefined) return null;
  return side === "YES" ? BigInt(raw) : complementPx(BigInt(raw));
}

/** Units wanted at the bid of a side. */
export function bidUnits(market: Booked, side: SideName): bigint {
  const raw = side === "YES" ? market.book?.bidUnits : market.book?.askUnits;
  return BigInt(raw ?? "0");
}

/** Units a sale with this minimum could give up now: zero above the bid. Null when there is no book. */
export function wantedAt(market: Booked, side: SideName, minPx: bigint): bigint | null {
  if (!market.book) return null;
  const bid = bidPx(market, side);
  if (bid === null || minPx > bid) return 0n;
  return bidUnits(market, side);
}
