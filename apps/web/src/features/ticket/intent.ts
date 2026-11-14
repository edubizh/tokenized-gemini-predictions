// What a link to a market page asks its ticket to open with: which outcome, and buying or selling.
// Pure.

import type { SideName } from "@outcome/relayer/api-types";

export type TicketAction = "buy" | "sell";

export interface TicketIntent {
  side: SideName;
  action: TicketAction;
}

/** The market page, optionally with a side preselected and the sell tab open. */
export function marketHref(symbol: string, side?: SideName, action?: TicketAction): string {
  const query = [side ? `side=${side.toLowerCase()}` : "", action === "sell" ? "action=sell" : ""].filter(Boolean).join("&");
  return `/markets/${symbol}${query ? `?${query}` : ""}`;
}

/** Reads the query of a market page. Anything it does not recognise means buying YES. */
export function ticketIntent(query: { side?: string | string[]; action?: string | string[] }): TicketIntent {
  return { side: query.side === "no" ? "NO" : "YES", action: query.action === "sell" ? "sell" : "buy" };
}
