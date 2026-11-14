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

/** A market account with the metadata name of its YES token. */
export interface FixtureChainMarket {
  address: string;
  symbol: string;
  yesMint: string;
  noMint: string;
  status: "open" | "halted" | "settled";
  /** Cluster seconds. */
  closeTs: number;
  placeCutoffSecs: number;
  tickPx: number;
  /** Micro-dollars per unit; zero until settled. */
  yesPayout: string;
  noPayout: string;
  /** Cluster seconds; zero until settled. */
  redeemAfter: number;
  tokenName: string | null;
}

/** What a read of market accounts asks for: by outcome mint, by market address or by venue symbol. */
export interface MarketQuery {
  mints?: readonly string[];
  markets?: readonly string[];
  symbols?: readonly string[];
}

/** One instruction of a simulated transaction, as the browser posts it. */
export interface FixtureInstruction {
  programAddress: string;
  accounts: Array<{ address: string; role: number }>;
  /** Base64. */
  data: string;
}
