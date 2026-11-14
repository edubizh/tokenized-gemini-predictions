// JSON shapes of the simulated chain served in fixtures mode. Integers are decimal strings.

export interface FixtureOpenOrder {
  address: string;
  user: string;
  market: string;
  side: number;
  kind: number;
  qtyUnits: string;
  limitPx: string;
  maxFee: string;
  /** Cluster seconds. */
  expiresAt: number;
  rentPayer: string;
  nonce: string;
}

export interface FixtureChain {
  trader: { address: string; nextNonce: string };
  balances: { lamports: string; stableMicros: string };
  positions: Array<{ mint: string; units: string }>;
  openOrders: FixtureOpenOrder[];
}

/** One instruction of a simulated transaction, as the browser posts it. */
export interface FixtureInstruction {
  programAddress: string;
  accounts: Array<{ address: string; role: number }>;
  /** Base64. */
  data: string;
}
