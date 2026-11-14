// JSON shapes of the relayer's local HTTP API. Shared with the web app.
//
// Conventions: integers that can exceed 2^53 (units, px, micro-dollars, venue order ids) are
// decimal strings. Times ending in `At` are unix milliseconds; `chainTime`, `expiresAt` of an
// order, `closeTs` and `redeemAfter` are unix seconds on the cluster clock.

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

/** Best bid and ask in YES price space. The NO ask is `10_000 - bidPx`. */
export interface ApiBook {
  bidPx: string | null;
  bidUnits: string;
  askPx: string | null;
  askUnits: string;
  /** When the relayer read it, unix milliseconds. */
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

export interface ApiMarket {
  /** Venue instrument symbol; also the key of the on-chain market. */
  symbol: string;
  eventTicker: string;
  /** For example "BTC15M". */
  series: string;
  /** For example "BTC". */
  underlying: string;
  /** Venue event title. */
  title: string;
  /** Contract label, for example "Up". YES means this label is true. */
  label: string;
  startsAt: number;
  expiresAt: number;
  /** New orders are accepted until this time (venue cutoff and on-chain cutoff, whichever is earlier). */
  lastOrderAt: number;
  /** Reference price in dollars as the venue prints it; null until the window starts. */
  strike: string | null;
  venueStatus: string;
  marketState: string;
  tradable: boolean;
  notTradableReason: NotTradableReason | null;
  tickPx: string;
  minUnits: string;
  unitIncrement: string;
  book: ApiBook | null;
  /** Null until the market has been created on-chain (see POST /markets/:symbol/ensure). */
  onchain: ApiOnchainMarket | null;
  /** Venue resolution once known. */
  resolution: "yes" | "no" | null;
  /** Final reference value in dollars as the venue prints it. */
  settlementValue: string | null;
  settleState: SettleState;
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
  /** Buy: maximum px. Sell: minimum px. */
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
//   GET  /markets?scope=live|all      -> { markets: ApiMarket[] }
//   GET  /markets/:symbol             -> ApiMarket | 404 ApiError
//   POST /markets/:symbol/ensure      -> ApiMarket (on-chain market created if it was missing)
//   GET  /orders?user=<address>       -> { orders: ApiOrder[] }  (newest first, at most 100)
//   GET  /orders/:address             -> ApiOrder | 404 ApiError
//   GET  /status                      -> ApiStatus
