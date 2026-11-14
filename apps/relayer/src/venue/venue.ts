import type { Cadence } from "../api/types.ts";
import type { VenueOrderRequest, VenueOrderResult } from "./types.ts";

/** One tradable contract as the venue describes it. */
export interface ContractInfo {
  /** Canonical upper-case instrument symbol. */
  symbol: string;
  eventTicker: string;
  /** Venue status: "approved" (listed, not yet an instrument), "active", "under_review", "settled". */
  status: string;
  /** Venue market state: "post_only", "open", "closed". */
  marketState: string;
  /** Start of trading, or of the observation window of an up-or-down contract. */
  effectiveAt: Date;
  expiresAt: Date;
  /** Price increment in px. */
  tickPx: bigint;
  /** Quantity increment in units (1 unit = 0.01 contract). */
  unitIncrement: bigint;
  minUnits: bigint;
  resolutionSide: "yes" | "no" | null;
  /** What YES means, for example "Up" or "$68,000 or above". */
  label?: string;
  /** Position inside its event, ascending by strike. */
  sortOrder?: number;
  /** The contract's rule in plain text. */
  rules?: string;
  /**
   * Reference price in dollars as the venue prints it: the strike of a ladder contract, or the
   * price to beat of an up-or-down contract. Null while it is not known.
   */
  strike?: string | null;
  /** Final reference value in dollars as the venue prints it; null until resolved. */
  settlementValue?: string | null;
  /**
   * Top of book in YES price space as it came with the contract; null when that side has no
   * quote. Left out by a venue whose contract data carries no quotes. These can lag the book.
   */
  bestBidPx?: bigint | null;
  bestAskPx?: bigint | null;
  /** Price of the last trade in YES price space; null when the contract never traded. */
  lastPx?: bigint | null;
}

/** One event as the venue lists it: a question with one contract, or a ladder of strike contracts. */
export interface EventInfo {
  ticker: string;
  title: string;
  /** For example "Crypto" or "Commodities". */
  category: string;
  /** Names below the category, for example ["Bitcoin"] or ["Precious Metals", "Gold"]. */
  subcategory: string[];
  /** The subject of the event, for example "BTC" or "XAU". */
  underlying: string;
  /** "binary": one contract. "ladder": several contracts that each settle by themselves. */
  shape: "binary" | "ladder";
  cadence: Cadence;
  description: string;
  /** Who publishes the reference value; null when the venue names none. */
  source: { agency: string; index: string } | null;
  termsUrl: string | null;
  listedAt: Date;
  expiresAt: Date;
  /** Venue status of the event. A contract is settled on its own fields, never on this one. */
  status: string;
  /** Units traded over the life of the event. */
  volumeUnits: bigint;
  /** Ascending by `sortOrder`. */
  contracts: ContractInfo[];
}

/** Best bid and ask in YES price space. A null price means that side of the book is empty. */
export interface TopOfBook {
  bidPx: bigint | null;
  bidUnits: bigint;
  askPx: bigint | null;
  askUnits: bigint;
}

export interface BookLevel {
  px: bigint;
  units: bigint;
}

/** Resting orders in YES price space, best price first on each side. */
export interface Depth {
  bids: BookLevel[];
  asks: BookLevel[];
}

/** One trade at the venue in YES price space. `taker` is the side that crossed the spread. */
export interface VenueTrade {
  id: string;
  atMs: number;
  px: bigint;
  units: bigint;
  taker: "buy" | "sell";
}

export interface PricePoint {
  atMs: number;
  px: bigint;
}

/** Result of looking an order up by client order id. `avgPx` is in the order's own outcome space
 *  and is null when the venue's average is not exactly representable as a whole px. */
export type OrderLookup =
  | { found: false }
  | { found: true; venueOrderId: string; closed: boolean; filledUnits: bigint; avgPx: bigint | null };

export interface Venue {
  placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult>;
  findOrder(clientOrderId: string, symbol: string, sinceMs: number): Promise<OrderLookup>;
  /**
   * The account's open positions by symbol in signed units: YES positive, NO negative. A contract
   * the account is flat in is left out.
   */
  positions(): Promise<Map<string, bigint>>;
  /** Available USD in micro-dollars. */
  cashMicros(): Promise<bigint>;
  /** One contract, read from the venue now. Null when the venue does not know the symbol. */
  contract(symbol: string): Promise<ContractInfo | null>;
  /** Every event the venue lists as approved or active, with its contracts. */
  listEvents(): Promise<EventInfo[]>;
  /**
   * What the venue paid the account for its position in a resolved contract, in micro-dollars.
   * Null when the venue reports no settled position: the account was flat at resolution.
   */
  settledPayoutMicros(symbol: string): Promise<bigint | null>;
  /** The top of book, read from the venue now. This is the read an order is priced against. */
  topOfBook(symbol: string): Promise<TopOfBook>;
  /**
   * The freshest top of book the adapter already holds, without any I/O; undefined when it holds
   * none for the symbol. For display only.
   */
  liveTop(symbol: string): { top: TopOfBook; atMs: number } | undefined;
  /** Up to `levels` price levels per side. */
  depth(symbol: string, levels: number): Promise<Depth>;
  /** The most recent trades, newest first, at most `limit`. */
  trades(symbol: string, limit: number): Promise<VenueTrade[]>;
  /**
   * The last trade price of each step, oldest first; empty when the contract never traded.
   * `stepSecs` is one of 60, 300, 900, 1800, 3600, 21600, 86400.
   */
  history(symbol: string, stepSecs: number): Promise<PricePoint[]>;
}
