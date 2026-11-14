import type { ChainConfig, ChainMarket, ChainOrder, MarketChain, NewChainMarket } from "../../src/chain/chain.ts";
import { FakeChain } from "./fake-chain.ts";
import { FakeMarketChain } from "./fake-market-chain.ts";

/**
 * The order side and the market side of the program in one object, as the Solana adapter is. A
 * buy that lands mints into the supply of its market, when that market exists.
 */
export class FakeFullChain extends FakeChain implements MarketChain {
  /** The market side: markets, supplies, treasury, config, injectable failures. */
  readonly marketSide = new FakeMarketChain();

  override async fillBuy(order: ChainOrder, args: { fillUnits: bigint; costMicros: bigint; feeMicros: bigint }): Promise<string> {
    const signature = await super.fillBuy(order, args);
    const market = this.marketSide.markets.get(order.symbol);
    if (market !== undefined) {
      const yes = market.yesSupply + (order.side === "YES" ? args.fillUnits : 0n);
      const no = market.noSupply + (order.side === "NO" ? args.fillUnits : 0n);
      this.marketSide.setSupply(order.symbol, yes, no);
    }
    return signature;
  }

  config(): Promise<ChainConfig> {
    return this.marketSide.config();
  }

  market(symbol: string): Promise<ChainMarket | null> {
    return this.marketSide.market(symbol);
  }

  ensureMarket(spec: NewChainMarket): Promise<ChainMarket> {
    return this.marketSide.ensureMarket(spec);
  }

  haltMarket(symbol: string): Promise<string> {
    return this.marketSide.haltMarket(symbol);
  }

  settleMarket(symbol: string, yesPayout: bigint, noPayout: bigint): Promise<string> {
    return this.marketSide.settleMarket(symbol, yesPayout, noPayout);
  }

  pause(flags: { place?: boolean; fill?: boolean }): Promise<string> {
    return this.marketSide.pause(flags);
  }

  treasuryMicros(): Promise<bigint> {
    return this.marketSide.treasuryMicros();
  }

  relayerLamports(): Promise<bigint> {
    return this.marketSide.relayerLamports();
  }
}
