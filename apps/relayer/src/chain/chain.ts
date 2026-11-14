import type { Outcome } from "../venue/types.ts";

/** An open order account as read from the program. */
export interface ChainOrder {
  address: string;
  addressBytes: Uint8Array;
  user: string;
  /** Venue symbol of the order's market. */
  symbol: string;
  side: Outcome;
  kind: "buy" | "sell";
  units: bigint;
  /** Buy: maximum px. Sell: minimum px. Own outcome space. */
  limitPx: bigint;
  maxFeeMicros: bigint;
  /** Unix seconds. */
  expiresAt: number;
}

/** What the order pipeline needs from the chain. Every write resolves with the transaction
 *  signature once the transaction is confirmed, and rejects otherwise. */
export interface Chain {
  /** Cluster unix time in seconds. */
  now(): Promise<number>;
  openOrders(): Promise<ChainOrder[]>;
  orderExists(address: string): Promise<boolean>;
  fillBuy(order: ChainOrder, args: { fillUnits: bigint; costMicros: bigint; feeMicros: bigint }): Promise<string>;
  fillSell(order: ChainOrder, args: { fillUnits: bigint; proceedsMicros: bigint; feeMicros: bigint }): Promise<string>;
  cancel(order: ChainOrder): Promise<string>;
}

/** On-chain state of one market. */
export interface ChainMarket {
  address: string;
  symbol: string;
  /** Null until the mint for that side has been created. */
  yesMint: string | null;
  noMint: string | null;
  status: "open" | "halted" | "settled";
  /** Unix seconds. */
  closeTs: number;
  placeCutoffSecs: number;
  tickPx: bigint;
  maxSupplyUnits: bigint;
  yesSupply: bigint;
  noSupply: bigint;
  /** Micro-dollars per unit; null until settled. */
  yesPayout: bigint | null;
  noPayout: bigint | null;
  /** Unix seconds; null until settled. */
  redeemAfter: number | null;
}

/** Everything needed to create a market and its two outcome mints. */
export interface NewChainMarket {
  symbol: string;
  closeTs: number;
  placeCutoffSecs: number;
  tickPx: bigint;
  maxSupplyUnits: bigint;
  yes: { name: string; ticker: string; uri: string };
  no: { name: string; ticker: string; uri: string };
}

export interface ChainConfig {
  admin: string;
  relayer: string;
  settler: string;
  registrar: string;
  stableMint: string;
  treasury: string;
  orderTtlSecs: number;
  minOrderUnits: bigint;
  maxOrderUnits: bigint;
  settleDelaySecs: number;
  pausePlace: boolean;
  pauseFill: boolean;
}

/** What market management, settlement and reconciliation need from the chain. */
export interface MarketChain {
  config(): Promise<ChainConfig>;
  market(symbol: string): Promise<ChainMarket | null>;
  /** Creates the market and any missing outcome mint. Parts that already exist are left alone. */
  ensureMarket(spec: NewChainMarket): Promise<ChainMarket>;
  haltMarket(symbol: string): Promise<string>;
  /** Signed by the settler. Payouts are micro-dollars per unit and must sum to 10_000. */
  settleMarket(symbol: string, yesPayout: bigint, noPayout: bigint): Promise<string>;
  /** Sets pause bits. The relayer can add bits but not clear them. */
  pause(flags: { place?: boolean; fill?: boolean }): Promise<string>;
  /** Balance of the treasury token account in micro-dollars. */
  treasuryMicros(): Promise<bigint>;
  relayerLamports(): Promise<bigint>;
}
