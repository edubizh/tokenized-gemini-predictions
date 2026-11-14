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
