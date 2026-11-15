// Order book depth, recent trades and price history of one contract, read from the venue on
// request. Every answer is kept for a few seconds and shared by all callers, so the number of
// people looking at a market does not change how often the venue is asked.

import type { Registry, RegistryMarket } from "../registry.ts";
import type { Venue } from "../venue/venue.ts";
import type { ApiDepth, ApiHistory, ApiTrade } from "./types.ts";

export interface MarketData {
  /** Each answer is undefined for a symbol the registry does not know. */
  depth(symbol: string): Promise<ApiDepth | undefined>;
  /** Newest first. */
  trades(symbol: string): Promise<ApiTrade[] | undefined>;
  history(symbol: string): Promise<ApiHistory | undefined>;
}

export interface MarketDataDeps {
  venue: Pick<Venue, "depth" | "trades" | "history">;
  registry: Pick<Registry, "get">;
  /** Unix milliseconds. */
  now(): number;
}

const DEPTH_LEVELS = 10;
const TRADES_LIMIT = 50;
const DEPTH_KEPT_MS = 3_000;
const TRADES_KEPT_MS = 10_000;
const HISTORY_KEPT_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The step of a contract's price history, by how long the contract runs. */
function stepSecsFor(market: RegistryMarket): number {
  const lifeMs = market.expiresAt - market.effectiveAt;
  if (lifeMs <= 2 * HOUR_MS) return 60;
  if (lifeMs <= 36 * HOUR_MS) return 900;
  if (lifeMs <= 10 * DAY_MS) return 3_600;
  return 21_600;
}

export function createMarketData({ venue, registry, now }: MarketDataDeps): MarketData {
  /**
   * `read` behind a cache per symbol: callers share a read that is under way, and its answer for
   * `keptMs` after it arrived. A read that failed is not kept.
   */
  function kept<T>(keptMs: number, read: (market: RegistryMarket) => Promise<T>): (market: RegistryMarket) => Promise<T> {
    const entries = new Map<string, { answer: Promise<T>; until: number }>();
    return (market) => {
      const at = now();
      for (const [symbol, entry] of entries) if (entry.until <= at) entries.delete(symbol);
      const known = entries.get(market.symbol);
      if (known !== undefined) return known.answer;
      const entry = { answer: read(market), until: Number.POSITIVE_INFINITY };
      entries.set(market.symbol, entry);
      entry.answer.then(
        () => (entry.until = now() + keptMs),
        () => entries.delete(market.symbol),
      );
      return entry.answer;
    };
  }

  const depth = kept(DEPTH_KEPT_MS, async ({ symbol }): Promise<ApiDepth> => {
    const book = await venue.depth(symbol, DEPTH_LEVELS);
    const side = (levels: typeof book.bids) => levels.map((level) => ({ px: level.px.toString(), units: level.units.toString() }));
    return { bids: side(book.bids), asks: side(book.asks), at: now() };
  });
  const trades = kept(TRADES_KEPT_MS, async ({ symbol }): Promise<ApiTrade[]> =>
    (await venue.trades(symbol, TRADES_LIMIT)).map((trade) => ({
      id: trade.id,
      at: trade.atMs,
      px: trade.px.toString(),
      units: trade.units.toString(),
      taker: trade.taker,
    })),
  );
  const history = kept(HISTORY_KEPT_MS, async (market): Promise<ApiHistory> => {
    const stepSecs = stepSecsFor(market);
    const points = await venue.history(market.symbol, stepSecs);
    return { stepSecs, points: points.map((point) => ({ at: point.atMs, px: point.px.toString() })) };
  });

  /**
   * The venue's answer for a contract it has market data for; `empty` for one that is not an
   * instrument yet or expired more than a day ago, without asking the venue.
   */
  async function answer<T>(
    symbol: string,
    read: (market: RegistryMarket) => Promise<T>,
    empty: (market: RegistryMarket) => T,
  ): Promise<T | undefined> {
    const market = registry.get(symbol);
    if (market === undefined) return undefined;
    return market.venueStatus === "approved" || now() - market.expiresAt > DAY_MS ? empty(market) : read(market);
  }

  return {
    depth: (symbol) => answer(symbol, depth, () => ({ bids: [], asks: [], at: now() })),
    trades: (symbol) => answer(symbol, trades, () => []),
    history: (symbol) => answer(symbol, history, (market) => ({ stepSecs: stepSecsFor(market), points: [] })),
  };
}
