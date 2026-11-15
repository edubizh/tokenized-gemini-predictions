// The app's links to an event page, and what such a link asks the page to open with. Pure.

import type { ApiMarket, SideName } from "@outcome/relayer/api-types";

export type TicketAction = "buy" | "sell";

/** The page of an event, by the venue's event ticker. */
export function eventHref(ticker: string): string {
  return `/markets/${ticker}`;
}

/** The page of a contract's event with that contract selected, optionally with a side chosen and the sell tab open. */
export function marketHref(market: Pick<ApiMarket, "eventTicker" | "symbol">, side?: SideName, action?: TicketAction): string {
  const query = [`c=${market.symbol}`, side ? `side=${side.toLowerCase()}` : "", action === "sell" ? "action=sell" : ""].filter(Boolean).join("&");
  return `${eventHref(market.eventTicker)}?${query}`;
}

export interface EventIntent {
  /** The symbol of the contract to select. Null leaves the choice to the page. */
  contract: string | null;
  side: SideName;
  action: TicketAction;
}

/** Reads the query of an event page. Anything it does not recognise means buying Yes of the contract the page picks. */
export function eventIntent(query: { c?: string | string[]; side?: string | string[]; action?: string | string[] }): EventIntent {
  return { contract: typeof query.c === "string" ? query.c : null, side: query.side === "no" ? "NO" : "YES", action: query.action === "sell" ? "sell" : "buy" };
}
