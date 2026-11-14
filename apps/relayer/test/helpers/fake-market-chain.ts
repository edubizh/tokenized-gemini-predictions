import type { ChainConfig, ChainMarket, MarketChain, NewChainMarket } from "../../src/chain/chain.ts";

export type MarketChainMethod = "market" | "ensureMarket" | "settleMarket" | "pause" | "treasuryMicros";

/**
 * In-memory stand-in for the market side of the program: markets by venue symbol with settable
 * supplies, a settable treasury balance, a record of every write and injectable failures.
 */
export class FakeMarketChain implements MarketChain {
  readonly markets = new Map<string, ChainMarket>();
  /** Symbols passed to `market`, in order. */
  readonly reads: string[] = [];
  /** Specs passed to `ensureMarket`, in order, including calls that failed. */
  readonly ensured: NewChainMarket[] = [];
  /** Settlements that landed, in order. */
  readonly settlements: Array<{ symbol: string; yesPayout: bigint; noPayout: bigint; signature: string }> = [];
  /** Flags of every `pause` call that landed. */
  readonly pauses: Array<{ place?: boolean; fill?: boolean }> = [];
  treasury = 0n;
  lamports = 2_000_000_000n;
  /** When set, `ensureMarket` waits for it before doing anything. */
  ensureGate: Promise<void> | null = null;
  configValue: ChainConfig = {
    admin: "Admin",
    relayer: "Relayer",
    settler: "Settler",
    registrar: "Registrar",
    stableMint: "StableMint",
    treasury: "Treasury",
    orderTtlSecs: 90,
    minOrderUnits: 1n,
    maxOrderUnits: 10_000n,
    settleDelaySecs: 30,
    pausePlace: false,
    pauseFill: false,
  };

  private readonly failures: Record<MarketChainMethod, number> = { market: 0, ensureMarket: 0, settleMarket: 0, pause: 0, treasuryMicros: 0 };
  private nextSignature = 1;

  /** The next `times` calls of `method` reject without landing. Default: every later call. */
  fail(method: MarketChainMethod, times: number = Number.POSITIVE_INFINITY): void {
    this.failures[method] = times;
  }

  /** Puts a market on the chain directly. */
  addMarket(symbol: string, overrides: Partial<ChainMarket> = {}): ChainMarket {
    const market: ChainMarket = {
      address: `market:${symbol}`,
      symbol,
      yesMint: `yes:${symbol}`,
      noMint: `no:${symbol}`,
      status: "open",
      closeTs: 0,
      placeCutoffSecs: 0,
      tickPx: 100n,
      maxSupplyUnits: 1_000_000n,
      yesSupply: 0n,
      noSupply: 0n,
      yesPayout: null,
      noPayout: null,
      redeemAfter: null,
      ...overrides,
    };
    this.markets.set(symbol, market);
    return { ...market };
  }

  setSupply(symbol: string, yesSupply: bigint, noSupply: bigint): void {
    const market = this.existing(symbol);
    this.markets.set(symbol, { ...market, yesSupply, noSupply });
  }

  async config(): Promise<ChainConfig> {
    return { ...this.configValue };
  }

  async market(symbol: string): Promise<ChainMarket | null> {
    this.reads.push(symbol);
    this.enter("market");
    const market = this.markets.get(symbol);
    return market === undefined ? null : { ...market };
  }

  async ensureMarket(spec: NewChainMarket): Promise<ChainMarket> {
    this.ensured.push(spec);
    if (this.ensureGate !== null) await this.ensureGate;
    this.enter("ensureMarket");
    const existing = this.markets.get(spec.symbol);
    if (existing === undefined) {
      return this.addMarket(spec.symbol, {
        closeTs: spec.closeTs,
        placeCutoffSecs: spec.placeCutoffSecs,
        tickPx: spec.tickPx,
        maxSupplyUnits: spec.maxSupplyUnits,
      });
    }
    const completed = { ...existing, yesMint: existing.yesMint ?? `yes:${spec.symbol}`, noMint: existing.noMint ?? `no:${spec.symbol}` };
    this.markets.set(spec.symbol, completed);
    return { ...completed };
  }

  async haltMarket(symbol: string): Promise<string> {
    this.markets.set(symbol, { ...this.existing(symbol), status: "halted" });
    return this.signature();
  }

  async settleMarket(symbol: string, yesPayout: bigint, noPayout: bigint): Promise<string> {
    this.enter("settleMarket");
    const market = this.existing(symbol);
    if (market.status === "settled") throw new Error(`market ${symbol} is already settled`);
    if (yesPayout + noPayout !== 10_000n) throw new Error(`payouts ${yesPayout} + ${noPayout} do not sum to 10000`);
    const signature = this.signature();
    this.markets.set(symbol, {
      ...market,
      status: "settled",
      yesPayout,
      noPayout,
      redeemAfter: market.closeTs + this.configValue.settleDelaySecs,
    });
    this.settlements.push({ symbol, yesPayout, noPayout, signature });
    return signature;
  }

  async pause(flags: { place?: boolean; fill?: boolean }): Promise<string> {
    this.enter("pause");
    this.pauses.push({ ...flags });
    this.configValue = {
      ...this.configValue,
      pausePlace: this.configValue.pausePlace || flags.place === true,
      pauseFill: this.configValue.pauseFill || flags.fill === true,
    };
    return this.signature();
  }

  async treasuryMicros(): Promise<bigint> {
    this.enter("treasuryMicros");
    return this.treasury;
  }

  async relayerLamports(): Promise<bigint> {
    return this.lamports;
  }

  private existing(symbol: string): ChainMarket {
    const market = this.markets.get(symbol);
    if (market === undefined) throw new Error(`market account for ${symbol} not found`);
    return market;
  }

  private enter(method: MarketChainMethod): void {
    if (this.failures[method] > 0) {
      this.failures[method] -= 1;
      throw new Error(`injected failure: ${method}`);
    }
  }

  private signature(): string {
    return `market-sig-${this.nextSignature++}`;
  }
}
