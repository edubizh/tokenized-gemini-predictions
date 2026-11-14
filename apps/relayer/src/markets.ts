// Market manager: keeps the registry in step with the venue's contract list, caches a top of
// book and the on-chain state per market, builds the API views from those caches, and creates
// on-chain markets on request.

import type { ApiBook, ApiMarket, ApiOnchainMarket, NotTradableReason } from "./api/types.ts";
import type { ChainMarket, MarketChain } from "./chain/chain.ts";
import { seriesOf } from "./registry.ts";
import type { Registry, RegistryMarket } from "./registry.ts";
import { cutoffMs } from "./venue/tradable.ts";
import type { Outcome } from "./venue/types.ts";
import type { TopOfBook, Venue } from "./venue/venue.ts";

export interface MarketManagerOptions {
  venue: Venue;
  chain: MarketChain;
  registry: Registry;
  /** Curated series, for example ["BTC15M", "ETH15M", "SOL15M"]. */
  series: string[];
  maxSupplyUnits: bigint;
  /** Seconds the on-chain order cutoff sits ahead of the venue's. */
  cutoffBufferSecs: number;
  booksPerRefresh: number;
  /** A market's on-chain state is read again once its cached copy is this old. */
  chainRefreshMs: number;
  /** Unix milliseconds. */
  now(): number;
}

export const DEFAULT_MARKET_OPTIONS = {
  maxSupplyUnits: 1_000_000n,
  cutoffBufferSecs: 30,
  booksPerRefresh: 2,
  chainRefreshMs: 15_000,
} as const satisfies Partial<MarketManagerOptions>;

export type MarketManagerInput = Omit<MarketManagerOptions, keyof typeof DEFAULT_MARKET_OPTIONS> &
  Partial<Pick<MarketManagerOptions, keyof typeof DEFAULT_MARKET_OPTIONS>>;

export interface MarketManager {
  /** Venue list -> registry and book prices; a few book sizes; chain state of on-chain markets. */
  refresh(): Promise<void>;
  /** Built from cached data only, no I/O. */
  views(scope: "live" | "all"): ApiMarket[];
  view(symbol: string): ApiMarket | undefined;
  /** Creates the on-chain market if it is missing. Rejects with a `MarketError` when the symbol may not be listed. */
  ensureOnchain(symbol: string): Promise<ApiMarket>;
  /** While offline, no market is tradable (`venue_offline`). */
  setVenueOnline(online: boolean): void;
  /** While paused, no market is tradable (`paused`). */
  setPaused(paused: boolean): void;
}

export type MarketErrorCode = "unknown" | "not_allowed" | "expired";

/** Why `ensureOnchain` refused a symbol. */
export class MarketError extends Error {
  readonly code: MarketErrorCode;

  constructor(code: MarketErrorCode, message: string) {
    super(message);
    this.name = "MarketError";
    this.code = code;
  }
}

export type RefreshPart = "venue_list" | "contract" | "books" | "chain";

/** What went wrong during a refresh. Every part ran before this was thrown. */
export class RefreshError extends Error {
  readonly parts: Array<{ part: RefreshPart; error: unknown }>;

  constructor(parts: Array<{ part: RefreshPart; error: unknown }>) {
    super(`market refresh failed: ${parts.map(({ part, error }) => `${part}: ${messageOf(error)}`).join("; ")}`);
    this.name = "RefreshError";
    this.parts = parts;
  }
}

/** How many markets the "all" view shows. */
const ALL_VIEW_LIMIT = 200;
/** Chain reads per refresh spent on markets that are neither live nor awaiting settlement. */
const CATCH_UP_READS = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const NAME_MAX_BYTES = 32;
const TICKER_MAX_BYTES = 10;
/** Room the ticker leaves for the underlying: 10 bytes less the side letter and HHMM. */
const TICKER_UNDERLYING_BYTES = 5;

/**
 * Token metadata of one side of a market: name `"<UNDERLYING> <Label> <HH:MM>Z <D> <Mon> <YES|NO>"`
 * (expiry in UTC, at most 32 bytes: the label is shortened first) and ticker
 * `"<UNDERLYING><Y|N><HHMM>"` (at most 10 bytes: the underlying is shortened). The venue's name is
 * removed from both.
 */
export function tokenNames(
  market: Pick<RegistryMarket, "underlying" | "label" | "expiresAt">,
  side: Outcome,
): { name: string; ticker: string; uri: string } {
  const expiry = new Date(market.expiresAt);
  const hours = String(expiry.getUTCHours()).padStart(2, "0");
  const minutes = String(expiry.getUTCMinutes()).padStart(2, "0");
  const underlying = withoutVenueName(market.underlying).toUpperCase();
  const tail = `${hours}:${minutes}Z ${expiry.getUTCDate()} ${MONTHS[expiry.getUTCMonth()] ?? ""} ${side}`;
  const build = (label: string): string => [underlying, label, tail].filter((part) => part !== "").join(" ");

  let label = withoutVenueName(market.label);
  while (label !== "" && byteLength(build(label)) > NAME_MAX_BYTES) {
    label = Array.from(label).slice(0, -1).join("").trimEnd();
  }
  return {
    name: cutToBytes(build(label), NAME_MAX_BYTES),
    ticker: cutToBytes(`${cutToBytes(underlying, TICKER_UNDERLYING_BYTES)}${side === "YES" ? "Y" : "N"}${hours}${minutes}`, TICKER_MAX_BYTES),
    uri: "",
  };
}

export function createMarketManager(input: MarketManagerInput): MarketManager {
  const o: MarketManagerOptions = {
    ...input,
    maxSupplyUnits: input.maxSupplyUnits ?? DEFAULT_MARKET_OPTIONS.maxSupplyUnits,
    cutoffBufferSecs: input.cutoffBufferSecs ?? DEFAULT_MARKET_OPTIONS.cutoffBufferSecs,
    booksPerRefresh: input.booksPerRefresh ?? DEFAULT_MARKET_OPTIONS.booksPerRefresh,
    chainRefreshMs: input.chainRefreshMs ?? DEFAULT_MARKET_OPTIONS.chainRefreshMs,
  };
  const curated = new Set(o.series);
  /** Best prices as they came with the contract list; a side the venue left out is undefined. */
  const quotes = new Map<string, { bidPx: bigint | null | undefined; askPx: bigint | null | undefined; at: number }>();
  /** The last top of book read per symbol: the source of sizes, and of prices the list lacks. */
  const tops = new Map<string, { top: TopOfBook; at: number }>();
  /** When each live symbol last had its turn at a book read; a higher number is more recent. */
  const bookTurns = new Map<string, number>();
  let turn = 0;
  const chainMarkets = new Map<string, ChainMarket>();
  /** When each market's on-chain state was last read, unix milliseconds. */
  const chainReadAt = new Map<string, number>();
  const flights = new Map<string, Promise<ApiMarket>>();
  let venueOnline = true;
  let paused = false;

  /** Prices from the contract list, else from the last book read; sizes from the last book read, "0" when unknown. */
  function bookOf(symbol: string): ApiBook | null {
    const quote = quotes.get(symbol);
    const read = tops.get(symbol);
    if (quote === undefined && read === undefined) return null;
    const bidPx = quote?.bidPx !== undefined ? quote.bidPx : (read?.top.bidPx ?? null);
    const askPx = quote?.askPx !== undefined ? quote.askPx : (read?.top.askPx ?? null);
    return {
      bidPx: bidPx === null ? null : bidPx.toString(),
      bidUnits: (read?.top.bidUnits ?? 0n).toString(),
      askPx: askPx === null ? null : askPx.toString(),
      askUnits: (read?.top.askUnits ?? 0n).toString(),
      // When the prices were read.
      at: quote?.at ?? read?.at ?? 0,
    };
  }

  function toView(market: RegistryMarket): ApiMarket {
    const now = o.now();
    const venueLastOrderAt = market.expiresAt - cutoffMs(new Date(market.effectiveAt), new Date(market.expiresAt));
    const onchain = toOnchain(chainMarkets.get(market.symbol));
    const lastOrderAt =
      onchain === null
        ? venueLastOrderAt - o.cutoffBufferSecs * 1_000
        : Math.min(venueLastOrderAt, (onchain.closeTs - onchain.placeCutoffSecs) * 1_000);
    const book = bookOf(market.symbol);

    let reason: NotTradableReason | null = null;
    if (!venueOnline) reason = "venue_offline";
    else if (paused) reason = "paused";
    else if (market.venueStatus !== "active") reason = "not_active";
    else if (market.marketState !== "open" || (onchain !== null && onchain.status !== "open")) reason = "market_not_open";
    else if (!(market.effectiveAt <= now)) reason = "not_started";
    else if (!(now < lastOrderAt)) reason = "too_close_to_expiry";
    else if (book === null || (book.bidPx === null && book.askPx === null)) reason = "no_offers";

    return {
      symbol: market.symbol,
      eventTicker: market.eventTicker,
      series: market.series,
      underlying: market.underlying,
      title: market.title,
      label: market.label,
      startsAt: market.effectiveAt,
      expiresAt: market.expiresAt,
      lastOrderAt,
      strike: market.strike,
      venueStatus: market.venueStatus,
      marketState: market.marketState,
      tradable: reason === null,
      notTradableReason: reason,
      tickPx: market.tickPx.toString(),
      minUnits: market.minUnits.toString(),
      unitIncrement: market.unitIncrement.toString(),
      book,
      onchain,
      resolution: market.resolution,
      settlementValue: market.settlementValue,
      settleState: market.settleState,
    };
  }

  async function refreshBooks(failures: RefreshError["parts"]): Promise<void> {
    const live = o.registry.live(o.now(), o.series);
    const liveSymbols = new Set(live.map((market) => market.symbol));
    for (const symbol of [...quotes.keys(), ...tops.keys(), ...bookTurns.keys()]) {
      if (liveSymbols.has(symbol)) continue;
      quotes.delete(symbol);
      tops.delete(symbol);
      bookTurns.delete(symbol);
    }
    // Stable sort: among symbols that waited equally long, the soonest expiry goes first.
    const due = live
      .sort((a, b) => (bookTurns.get(a.symbol) ?? 0) - (bookTurns.get(b.symbol) ?? 0))
      .slice(0, Math.max(0, o.booksPerRefresh));
    for (const { symbol } of due) {
      // The turn is spent even when the read fails, so one bad book cannot starve the others.
      bookTurns.set(symbol, ++turn);
      try {
        tops.set(symbol, { top: await o.venue.topOfBook(symbol), at: o.now() });
      } catch (error) {
        failures.push({ part: "books", error });
      }
    }
  }

  async function refreshChain(failures: RefreshError["parts"]): Promise<void> {
    // Live and unsettled markets are read again only when the cached copy has aged: the public
    // RPC endpoint limits requests per address, and supplies do not need to be fresher than this.
    const now = o.now();
    const due = (symbol: string): boolean => now - (chainReadAt.get(symbol) ?? Number.NEGATIVE_INFINITY) >= o.chainRefreshMs;
    const symbols = new Set<string>();
    for (const market of o.registry.live(now, o.series)) {
      if (market.marketAddress !== null && due(market.symbol)) symbols.add(market.symbol);
    }
    for (const market of o.registry.onchainUnsettled()) {
      if (due(market.symbol)) symbols.add(market.symbol);
    }
    // Older markets are read until their final state is cached: once after a restart, and once
    // more after settlement so the view carries the payouts and the redemption time.
    let catchUp = 0;
    for (const market of o.registry.all(ALL_VIEW_LIMIT)) {
      if (catchUp >= CATCH_UP_READS) break;
      if (market.marketAddress === null || symbols.has(market.symbol)) continue;
      const cached = chainMarkets.get(market.symbol);
      if (cached === undefined || (market.settleState === "settled" && cached.status !== "settled")) {
        symbols.add(market.symbol);
        catchUp += 1;
      }
    }
    for (const symbol of symbols) {
      try {
        const market = await o.chain.market(symbol);
        if (market !== null) chainMarkets.set(symbol, market);
        chainReadAt.set(symbol, o.now());
      } catch (error) {
        failures.push({ part: "chain", error });
      }
    }
  }

  async function ensure(symbol: string): Promise<ApiMarket> {
    const market = o.registry.get(symbol);
    if (market === undefined) throw new MarketError("unknown", `unknown market ${symbol}`);
    if (!curated.has(market.series)) throw new MarketError("not_allowed", `series ${market.series} is not offered`);
    if (market.venueStatus !== "active") throw new MarketError("not_allowed", `market ${symbol} is not active at the venue`);
    if (!(o.now() < market.expiresAt)) throw new MarketError("expired", `market ${symbol} has expired`);
    if (market.unitIncrement !== 1n) {
      throw new MarketError("not_allowed", `market ${symbol} trades in steps of ${market.unitIncrement} units, not 1`);
    }

    const created = await o.chain.ensureMarket({
      symbol,
      closeTs: Math.floor(market.expiresAt / 1_000),
      placeCutoffSecs: cutoffMs(new Date(market.effectiveAt), new Date(market.expiresAt)) / 1_000 + o.cutoffBufferSecs,
      tickPx: market.tickPx,
      maxSupplyUnits: o.maxSupplyUnits,
      yes: tokenNames(market, "YES"),
      no: tokenNames(market, "NO"),
    });
    if (created.yesMint === null || created.noMint === null) throw new Error(`market ${symbol} is missing an outcome mint`);
    o.registry.setOnchain(symbol, { marketAddress: created.address, yesMint: created.yesMint, noMint: created.noMint });
    chainMarkets.set(symbol, created);
    chainReadAt.set(symbol, o.now());
    return toView(o.registry.get(symbol) ?? market);
  }

  return {
    async refresh() {
      const failures: RefreshError["parts"] = [];
      try {
        const now = o.now();
        for (const info of await o.venue.listContracts()) {
          if (!curated.has(seriesOf(info))) continue;
          try {
            o.registry.upsertContract(info, now);
          } catch (error) {
            failures.push({ part: "contract", error });
            continue;
          }
          if (info.bestBidPx !== undefined || info.bestAskPx !== undefined) {
            quotes.set(info.symbol, { bidPx: info.bestBidPx, askPx: info.bestAskPx, at: now });
          } else {
            quotes.delete(info.symbol);
          }
        }
      } catch (error) {
        failures.push({ part: "venue_list", error });
      }
      await refreshBooks(failures);
      await refreshChain(failures);
      if (failures.length > 0) throw new RefreshError(failures);
    },

    views(scope) {
      const markets = scope === "live" ? o.registry.live(o.now(), o.series) : o.registry.all(ALL_VIEW_LIMIT);
      return markets.map(toView);
    },

    view(symbol) {
      const market = o.registry.get(symbol);
      return market === undefined ? undefined : toView(market);
    },

    ensureOnchain(symbol) {
      const running = flights.get(symbol);
      if (running !== undefined) return running;
      const flight = ensure(symbol).finally(() => flights.delete(symbol));
      flights.set(symbol, flight);
      return flight;
    },

    setVenueOnline(online) {
      venueOnline = online;
    },

    setPaused(value) {
      paused = value;
    },
  };
}

/** The API shape of an on-chain market, or null while the market or one of its mints is missing. */
function toOnchain(market: ChainMarket | undefined): ApiOnchainMarket | null {
  if (market === undefined || market.yesMint === null || market.noMint === null) return null;
  return {
    market: market.address,
    yesMint: market.yesMint,
    noMint: market.noMint,
    status: market.status,
    closeTs: market.closeTs,
    placeCutoffSecs: market.placeCutoffSecs,
    yesSupply: market.yesSupply.toString(),
    noSupply: market.noSupply.toString(),
    yesPayout: market.yesPayout === null ? null : market.yesPayout.toString(),
    noPayout: market.noPayout === null ? null : market.noPayout.toString(),
    redeemAfter: market.redeemAfter,
  };
}

function withoutVenueName(text: string): string {
  return text.replace(/gemini|gemi/gi, "").replace(/\s+/g, " ").trim();
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of whole characters that fits in `maxBytes` of UTF-8. */
function cutToBytes(text: string, maxBytes: number): string {
  let out = "";
  for (const character of text) {
    if (byteLength(out + character) > maxBytes) break;
    out += character;
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
