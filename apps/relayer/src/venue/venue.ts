import type { VenueOrderRequest, VenueOrderResult } from "./types.ts";

/** One tradable contract as the venue describes it. */
export interface ContractInfo {
  /** Canonical upper-case instrument symbol. */
  symbol: string;
  eventTicker: string;
  /** Venue status, for example "active", "under_review", "settled". */
  status: string;
  /** Venue market state, for example "open", "closed", "post_only". */
  marketState: string;
  effectiveAt: Date;
  expiresAt: Date;
  /** Price increment in px. */
  tickPx: bigint;
  /** Quantity increment in units (1 unit = 0.01 contract). */
  unitIncrement: bigint;
  minUnits: bigint;
  resolutionSide: "yes" | "no" | null;
}

/** Best bid and ask in YES price space. A null price means that side of the book is empty. */
export interface TopOfBook {
  bidPx: bigint | null;
  bidUnits: bigint;
  askPx: bigint | null;
  askUnits: bigint;
}

/** Result of looking an order up by client order id. `avgPx` is in the order's own outcome space
 *  and is null when the venue's average is not exactly representable as a whole px. */
export type OrderLookup =
  | { found: false }
  | { found: true; venueOrderId: string; closed: boolean; filledUnits: bigint; avgPx: bigint | null };

export interface Venue {
  placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult>;
  findOrder(clientOrderId: string, symbol: string, sinceMs: number): Promise<OrderLookup>;
  /** Signed units: YES positive, NO negative. */
  netPosition(symbol: string): Promise<bigint>;
  /** Available USD in micro-dollars. */
  cashMicros(): Promise<bigint>;
  contract(symbol: string): Promise<ContractInfo | null>;
  topOfBook(symbol: string): Promise<TopOfBook>;
}
