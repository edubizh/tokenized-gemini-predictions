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
  /** Event title, for display. */
  title?: string;
  /** Contract label, for example "Up". YES means the label is true. */
  label?: string;
  /** Event series, for example "BTC15M". */
  series?: string;
  /** Reference price in dollars as the venue prints it; null while it is not known. */
  strike?: string | null;
  /** Final reference value in dollars as the venue prints it; null until resolved. */
  settlementValue?: string | null;
  /**
   * Top of book in YES price space as it came with the contract; null when that side has no
   * quote. Left out by a venue whose contract data carries no quotes.
   */
  bestBidPx?: bigint | null;
  bestAskPx?: bigint | null;
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
  /** The contracts the venue currently lists as active. */
  listContracts(): Promise<ContractInfo[]>;
  /**
   * What the venue paid the account for its position in a resolved contract, in micro-dollars.
   * Null when the venue reports no settled position: the account was flat at resolution.
   */
  settledPayoutMicros(symbol: string): Promise<bigint | null>;
  topOfBook(symbol: string): Promise<TopOfBook>;
}
