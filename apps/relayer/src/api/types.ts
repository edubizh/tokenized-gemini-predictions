// JSON shapes of the relayer's local HTTP API. Shared with the web app.
//
// Conventions: integers that can exceed 2^53 (units, px, micro-dollars, venue ids) are decimal
// strings. Times ending in `At` are unix milliseconds; `chainTime`, `expiresAt` of an order,
// `closeTs` and `redeemAfter` are unix seconds on the cluster clock. Prices are `px`
// (micro-dollars per unit, one cent per contract = 100) in YES price space unless stated.

import type { OrderState } from "../journal.ts";

export type SideName = "YES" | "NO";

export interface ApiHealth {
  ok: boolean;
  cluster: "devnet" | "localnet";
  venue: "sandbox" | "mock";
  programId: string;
  relayer: string;
  stableMint: string;
  paused: { place: boolean; fill: boolean };
  venueConnected: boolean;
  /** Cluster clock, unix seconds. */
  chainTime: number;
  /** Relayer wall clock, unix milliseconds. */
  serverTime: number;
  orderTtlSecs: number;
  minOrderUnits: string;
  maxOrderUnits: string;
  /** Slack added to the fee formula when the relayer checks an order's fee cap. */
  feeSlackMicros: string;
}

/** Best bid and ask. The NO ask is `10_000 - bidPx`. A null price means that side is empty. */
export interface ApiBook {
  bidPx: string | null;
  /** "0" when the size is not known. */
  bidUnits: string;
  askPx: string | null;
  askUnits: string;
  /** When the relayer learned it, unix milliseconds. */
  at: number;
}

export interface ApiOnchainMarket {
  market: string;
  yesMint: string;
  noMint: string;
  status: "open" | "halted" | "settled";
  closeTs: number;
  placeCutoffSecs: number;
  yesSupply: string;
  noSupply: string;
  /** Micro-dollars per unit, set once settled. */
  yesPayout: string | null;
  noPayout: string | null;
  /** Redemption opens at this cluster time; null until settled. */
  redeemAfter: number | null;
}

export type NotTradableReason =
  | "not_started"
  | "too_close_to_expiry"
  | "market_not_open"
  | "not_active"
  | "no_offers"
  | "paused"
  | "venue_offline";

export type SettleState = "open" | "awaiting_result" | "settled" | "needs_review" | "unused";

/** One contract of the venue: a yes-or-no question with its own order book. */
export interface ApiMarket {
  /** Venue instrument symbol; also the key of the on-chain market. */
  symbol: string;
  eventTicker: string;
  /** Title of the event the contract belongs to. */
  title: string;
  /** What YES means, for example "Up" or "$68,000 or above". */
  label: string;
  /**
   * Reference price in dollars as the venue prints it: the strike of a ladder contract, or the
   * price to beat of an up-or-down contract (null until its window starts).
   */
  strike: string | null;
  /** Position inside the event, ascending by strike. */
  sortOrder: number;
  /** Start of trading, or of the observation window of an up-or-down contract. */
  startsAt: number;
  expiresAt: number;
  /** New orders are accepted until this time (venue cutoff and on-chain cutoff, whichever is earlier). */
  lastOrderAt: number;
  /** "approved" (listed, not yet trading), "active", "under_review" or "settled". */
  venueStatus: string;
  /** "post_only", "open" or "closed". */
  marketState: string;
  tradable: boolean;
  notTradableReason: NotTradableReason | null;
  tickPx: string;
  minUnits: string;
  unitIncrement: string;
  /** Null while the relayer has no quote for the contract at all. */
  book: ApiBook | null;
  /** Price of the last trade at the venue; null when it never traded. */
  lastPx: string | null;
  /** Null until the market has been created on-chain (see POST /markets/:symbol/ensure). */
  onchain: ApiOnchainMarket | null;
  /** Venue resolution once known. */
  resolution: "yes" | "no" | null;
  /** Final reference value in dollars as the venue prints it. */
  settlementValue: string | null;
  settleState: SettleState;
}

/** How long an event runs. "other" is anything the relayer cannot place in the known durations. */
export type Cadence = "5m" | "15m" | "hourly" | "daily" | "weekly" | "monthly" | "other";

/** A venue event: one question with one contract, or a ladder of independent strike contracts. */
export interface ApiEvent {
  /** Venue event ticker, for example "BTC2611142300". The key of the event. */
  ticker: string;
  title: string;
  /** For example "Crypto" or "Commodities". */
  category: string;
  /** Names below the category, for example ["Bitcoin"] or ["Precious Metals", "Gold"]. */
  subcategory: string[];
  /** The subject of the event, for example "BTC" or "XAU". */
  underlying: string;
  /** "binary": one contract. "ladder": several, each settling by itself, so more than one can pay. */
  shape: "binary" | "ladder";
  cadence: Cadence;
  /** When the venue listed the event. */
  listedAt: number;
  expiresAt: number;
  /** "approved" (listed, not yet trading), "active", "under_review" or "settled". */
  venueStatus: string;
  /** Units traded at the venue over the life of the event (1 unit = 0.01 contract). */
  volumeUnits: string;
  /** Ascending by `sortOrder`. */
  markets: ApiMarket[];
}

/** An event with what the list leaves out. */
export interface ApiEventDetail extends ApiEvent {
  description: string;
  /** Who publishes the reference value the event resolves from; null when the venue names none. */
  source: { agency: string; index: string } | null;
  /** The venue's terms for this kind of contract. */
  termsUrl: string | null;
  /** The rule of each contract in plain text, by symbol. */
  rules: Record<string, string>;
}

export interface ApiLevel {
  px: string;
  units: string;
}

/** Resting orders of one contract, best price first on each side. */
export interface ApiDepth {
  bids: ApiLevel[];
  asks: ApiLevel[];
  /** When the relayer read it, unix milliseconds. */
  at: number;
}

/** One trade at the venue. `taker` is the side that crossed the spread: "buy" lifted an offer. */
export interface ApiTrade {
  id: string;
  at: number;
  px: string;
  units: string;
  taker: "buy" | "sell";
}

/**
 * Price history of one contract: the last trade price of each step, oldest first. Empty until the
 * contract has traded. The relayer picks the step from the contract's lifetime.
 */
export interface ApiHistory {
  stepSecs: number;
  points: Array<{ at: number; px: string }>;
}

export interface ApiFill {
  tradeId: string;
  units: string;
  /** In the venue order's own outcome space. */
  px: string;
  feeMicros: string;
}

export interface ApiOrder {
  address: string;
  user: string;
  symbol: string;
  kind: "buy" | "sell";
  side: SideName;
  units: string;
  /** Buy: maximum px. Sell: minimum px. In the order's own outcome space. */
  limitPx: string;
  maxFeeMicros: string;
  /** Unix seconds, cluster clock. */
  expiresAt: number;
  state: OrderState;
  venueOrderId: string | null;
  filledUnits: string;
  /** Cost of a buy or proceeds of a sell, micro-dollars. */
  amountMicros: string;
  feeMicros: string;
  fills: ApiFill[];
  /** Signature of the on-chain fill or cancel, once done. */
  chainSignature: string | null;
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApiReconcileMarket {
  symbol: string;
  yesSupply: string;
  noSupply: string;
  /** Signed units at the venue: YES positive, NO negative. */
  venueNet: string;
  /** Signed units of orders filled at the venue but not yet recorded on-chain. */
  inFlight: string;
  /** Signed units held by the operator because a venue fill could not be recorded on-chain. */
  houseInventory: string;
  /** venueNet == yesSupply - noSupply + inFlight + houseInventory */
  balanced: boolean;
}

export interface ApiStatus {
  markets: ApiReconcileMarket[];
  /** Venue cash plus treasury against what open markets and unredeemed settlements could require. */
  solvency: { venueCashMicros: string; treasuryMicros: string; requiredMicros: string; ok: boolean };
  journal: Record<OrderState, number>;
  relayerLamports: string;
  /** Most recent alerts, newest first. */
  alerts: Array<{ at: number; kind: string; orderAddress: string | null; detail: string }>;
}

export interface ApiError {
  error: string;
}

// Routes
//   GET  /health                      -> ApiHealth
//   GET  /events                      -> { events: ApiEvent[] }   every listed event that has not expired, soonest expiry first
//   GET  /events/:ticker              -> ApiEventDetail | 404 ApiError   (any event the relayer knows, expired ones included)
//   GET  /markets                     -> { markets: ApiMarket[] } the markets that exist on-chain, newest expiry first, at most 500
//   GET  /markets/:symbol             -> ApiMarket | 404 ApiError
//   POST /markets/:symbol/ensure      -> ApiMarket (on-chain market created if it was missing)
//   GET  /markets/:symbol/depth       -> ApiDepth | 404 ApiError
//   GET  /markets/:symbol/trades      -> { trades: ApiTrade[] } | 404 ApiError   (newest first, at most 50)
//   GET  /markets/:symbol/history     -> ApiHistory | 404 ApiError
//   GET  /orders?user=<address>       -> { orders: ApiOrder[] }  (newest first, at most 100)
//   GET  /orders/:address             -> ApiOrder | 404 ApiError
//   GET  /status                      -> ApiStatus
