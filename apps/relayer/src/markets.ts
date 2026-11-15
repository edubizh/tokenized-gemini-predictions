// Market manager: keeps the registry in step with the venue's event list, caches the list quotes
// and the on-chain state per market, builds the API views from those caches, and creates on-chain
// markets on request.

import type { ApiBook, ApiEvent, ApiEventDetail, ApiMarket, ApiOnchainMarket, NotTradableReason } from "./api/types.ts";
import type { ChainMarket, MarketChain } from "./chain/chain.ts";
import type { Registry, RegistryEvent, RegistryMarket } from "./registry.ts";
import { cutoffMs } from "./venue/tradable.ts";
import type { Outcome } from "./venue/types.ts";
import type { EventInfo, Venue } from "./venue/venue.ts";

export interface MarketManagerOptions {
  venue: Venue;
  chain: MarketChain;
  registry: Registry;
  maxSupplyUnits: bigint;
  /** Seconds the on-chain order cutoff sits ahead of the venue's. */
  cutoffBufferSecs: number;
  /** The venue's event list is asked for again once the last answer is this old. */
  listRefreshMs: number;
  /** A market's on-chain state is read again once its cached copy is this old. */
  chainRefreshMs: number;
  /** Unix milliseconds. */
  now(): number;
}

export const DEFAULT_MARKET_OPTIONS = {
  maxSupplyUnits: 1_000_000n,
  cutoffBufferSecs: 30,
  listRefreshMs: 15_000,
  chainRefreshMs: 15_000,
} as const satisfies Partial<MarketManagerOptions>;

export type MarketManagerInput = Omit<MarketManagerOptions, keyof typeof DEFAULT_MARKET_OPTIONS> &
  Partial<Pick<MarketManagerOptions, keyof typeof DEFAULT_MARKET_OPTIONS>>;

export interface MarketManager {
  /** Venue event list -> registry and list quotes, when it is due; chain state of on-chain markets. */
  refresh(): Promise<void>;
  /** Every listed event that has not expired, soonest expiry first. Built from cached data only, like every view. */
  eventViews(): ApiEvent[];
  /** Any event the registry knows, expired or not. */
  eventView(ticker: string): ApiEventDetail | undefined;
  /** The markets that exist on-chain, newest expiry first. */
  views(): ApiMarket[];
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

export type RefreshPart = "venue_list" | "registry" | "chain";

/** What went wrong during a refresh. Every part ran before this was thrown. */
export class RefreshError extends Error {
  readonly parts: Array<{ part: RefreshPart; error: unknown }>;

  constructor(parts: Array<{ part: RefreshPart; error: unknown }>) {
    super(`market refresh failed: ${parts.map(({ part, error }) => `${part}: ${messageOf(error)}`).join("; ")}`);
    this.name = "RefreshError";
    this.parts = parts;
  }
}

/** How many on-chain markets the views and the chain reads cover. */
const ONCHAIN_LIMIT = 500;
/** Chain reads per refresh spent on markets that are neither live nor awaiting settlement. */
const CATCH_UP_READS = 10;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const NAME_MAX_BYTES = 32;
/** The subject of a name is not cut below this. */
const NAME_SUBJECT_MIN_BYTES = 3;
/** A ticker is the subject, the side letter, the key and the tenor letter: 10 bytes at most. */
const TICKER_SUBJECT_AND_KEY_BYTES = 8;
const TICKER_KEY_MAX_BYTES = 6;
const TICKER_SUBJECT_MIN_BYTES = 2;

/**
 * Token metadata of one side of a market, from the contract's symbol, strike and dates.
 *
 * A symbol is `<venue prefix>-<event>-<contract>`. The subject is the event without its time
 * (`BTC05M2611142210` -> `BTC`). What YES means and the ticker's key and tenor letter follow from
 * the contract:
 *   `UP` of a 5 or 15 minute event   "Up 5m" / "Up 15m", key = expiry `HHMM`, tenor `F` / `Q`
 *   `HI<strike code>`                ">=<strike>", key = the strike code, tenor by the contract's
 *                                    life: `H` up to 90 minutes, `D` up to 36 hours, `W` up to
 *                                    10 days, else `M`
 *   anything else                    the contract part as it is, tenor `X`
 *
 * Name: `<SUBJECT> <OUTCOME> <DDMonYY> <HH:MM> <YES|NO>`, expiry in UTC, at most 32 bytes: the
 * subject is cut first, down to three bytes, then the outcome. Ticker:
 * `<SUBJECT><Y|N><key><tenor>`, at most 10 bytes: the key keeps up to six, the subject the rest.
 * The venue's name is removed from every part.
 */
export function tokenNames(
  market: Pick<RegistryMarket, "symbol" | "strike" | "effectiveAt" | "expiresAt">,
  side: Outcome,
): { name: string; ticker: string; uri: string } {
  const parts = market.symbol.split("-");
  const contract = withoutVenueName(parts.length > 1 ? parts.pop()! : "");
  if (parts.length > 1) parts.shift(); // the venue's prefix
  const event = parts.join("");
  const interval = /^([A-Z]+?)(05M|15M)?\d{10}$/.exec(event);
  let subject = withoutVenueName(interval?.[1] ?? event.replace(/\d{6,}/g, ""));

  const expiry = new Date(market.expiresAt);
  const two = (value: number): string => String(value).padStart(2, "0");
  const hours = two(expiry.getUTCHours());
  const minutes = two(expiry.getUTCMinutes());

  let outcome = contract;
  let key = contract;
  let tenor = "X";
  if (contract === "UP" && interval?.[2] !== undefined) {
    const five = interval[2] === "05M";
    outcome = five ? "Up 5m" : "Up 15m";
    key = `${hours}${minutes}`;
    tenor = five ? "F" : "Q";
  } else if (/^HI./.test(contract)) {
    key = contract.slice(2);
    // The venue writes the decimal point of a strike as `D` in the symbol.
    outcome = `>=${market.strike === null ? key.replace("D", ".") : withoutTrailingZeros(market.strike)}`;
    const lifeMs = market.expiresAt - market.effectiveAt;
    tenor = lifeMs <= 90 * MINUTE_MS ? "H" : lifeMs <= 36 * HOUR_MS ? "D" : lifeMs <= 10 * DAY_MS ? "W" : "M";
  }

  const tail = `${two(expiry.getUTCDate())}${MONTHS[expiry.getUTCMonth()] ?? ""}${two(expiry.getUTCFullYear() % 100)} ${hours}:${minutes} ${side}`;
  const subjectBytes = Math.max(TICKER_SUBJECT_MIN_BYTES, TICKER_SUBJECT_AND_KEY_BYTES - byteLength(key));
  const ticker = `${cutToBytes(subject, subjectBytes)}${side === "YES" ? "Y" : "N"}${cutToBytes(key, TICKER_KEY_MAX_BYTES)}${tenor}`;
  const name = (): string => [subject, outcome, tail].filter((part) => part !== "").join(" ");
  while (byteLength(name()) > NAME_MAX_BYTES && byteLength(subject) > NAME_SUBJECT_MIN_BYTES) subject = withoutLastCharacter(subject);
  while (byteLength(name()) > NAME_MAX_BYTES && outcome !== "") outcome = withoutLastCharacter(outcome);
  return { name: name(), ticker, uri: "" };
}

export function createMarketManager(input: MarketManagerInput): MarketManager {
  const o: MarketManagerOptions = {
    ...input,
    maxSupplyUnits: input.maxSupplyUnits ?? DEFAULT_MARKET_OPTIONS.maxSupplyUnits,
    cutoffBufferSecs: input.cutoffBufferSecs ?? DEFAULT_MARKET_OPTIONS.cutoffBufferSecs,
    listRefreshMs: input.listRefreshMs ?? DEFAULT_MARKET_OPTIONS.listRefreshMs,
    chainRefreshMs: input.chainRefreshMs ?? DEFAULT_MARKET_OPTIONS.chainRefreshMs,
  };
  /** Best prices as they came with the event list and when they first came, kept until the contract expires. */
  const quotes = new Map<string, { bidPx: bigint | null; askPx: bigint | null; at: number; expiresAt: number }>();
  /** When the venue last answered with its event list, unix milliseconds. */
  let listedAt = Number.NEGATIVE_INFINITY;
  /** What could not be stored from that answer. Reported until the next one, so it does not come and go. */
  let unstored: RefreshError["parts"] = [];
  const chainMarkets = new Map<string, ChainMarket>();
  /** When each market's on-chain state was last read, unix milliseconds. */
  const chainReadAt = new Map<string, number>();
  const flights = new Map<string, Promise<ApiMarket>>();
  let venueOnline = true;
  let paused = false;

  /**
   * The venue's live top of book while it is at least as new as the quote that came with the
   * list; otherwise that quote, which carries no sizes.
   */
  function bookOf(symbol: string): ApiBook | null {
    const quote = quotes.get(symbol);
    const live = o.venue.liveTop(symbol);
    const px = (value: bigint | null): string | null => (value === null ? null : value.toString());
    if (live !== undefined && (quote === undefined || live.atMs >= quote.at)) {
      const { top } = live;
      return { bidPx: px(top.bidPx), bidUnits: top.bidUnits.toString(), askPx: px(top.askPx), askUnits: top.askUnits.toString(), at: live.atMs };
    }
    if (quote === undefined) return null;
    return { bidPx: px(quote.bidPx), bidUnits: "0", askPx: px(quote.askPx), askUnits: "0", at: quote.at };
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
      title: market.title,
      label: market.label,
      strike: market.strike,
      sortOrder: market.sortOrder,
      startsAt: market.effectiveAt,
      expiresAt: market.expiresAt,
      lastOrderAt,
      venueStatus: market.venueStatus,
      marketState: market.marketState,
      tradable: reason === null,
      notTradableReason: reason,
      tickPx: market.tickPx.toString(),
      minUnits: market.minUnits.toString(),
      unitIncrement: market.unitIncrement.toString(),
      book,
      lastPx: market.lastPx === null ? null : market.lastPx.toString(),
      onchain,
      resolution: market.resolution,
      settlementValue: market.settlementValue,
      settleState: market.settleState,
    };
  }

  function toEventView(event: RegistryEvent): ApiEvent {
    return {
      ticker: event.ticker,
      title: event.title,
      category: event.category,
      subcategory: event.subcategory,
      underlying: event.underlying,
      shape: event.shape,
      cadence: event.cadence,
      listedAt: event.listedAt,
      expiresAt: event.expiresAt,
      venueStatus: event.venueStatus,
      volumeUnits: event.volumeUnits.toString(),
      markets: event.markets.map(toView),
    };
  }

  /** One list read, when it is due: every event and contract into the registry, the quotes into the cache. */
  async function refreshList(failures: RefreshError["parts"]): Promise<void> {
    const now = o.now();
    if (now - listedAt < o.listRefreshMs) {
      failures.push(...unstored);
      return;
    }
    let events: EventInfo[];
    try {
      events = await o.venue.listEvents();
    } catch (error) {
      // Asked again on the next refresh.
      failures.push({ part: "venue_list", error });
      return;
    }
    listedAt = now;
    try {
      unstored = o.registry.storeEvents(events, now).map((error) => ({ part: "registry", error }));
      o.registry.prune(now);
    } catch (error) {
      unstored = [{ part: "registry", error }];
    }
    failures.push(...unstored);
    // A contract that is missing from this read keeps its quote: one read can be a stale page.
    for (const [symbol, quote] of quotes) if (!(now < quote.expiresAt)) quotes.delete(symbol);
    for (const info of events.flatMap((event) => event.contracts)) {
      if (info.bestBidPx === undefined && info.bestAskPx === undefined) {
        quotes.delete(info.symbol);
        continue;
      }
      const bidPx = info.bestBidPx ?? null;
      const askPx = info.bestAskPx ?? null;
      // The list lags the book: prices it only repeats were learned when they first came, so
      // that they do not pass for newer than a live top that has moved since.
      const known = quotes.get(info.symbol);
      const at = known !== undefined && known.bidPx === bidPx && known.askPx === askPx ? known.at : now;
      quotes.set(info.symbol, { bidPx, askPx, at, expiresAt: info.expiresAt.getTime() });
    }
  }

  async function refreshChain(failures: RefreshError["parts"]): Promise<void> {
    // Only markets that exist on-chain are read. Live and unsettled ones are read again only when
    // the cached copy has aged: the public RPC endpoint limits requests per address, and supplies
    // do not need to be fresher than this.
    const now = o.now();
    const due = (symbol: string): boolean => now - (chainReadAt.get(symbol) ?? Number.NEGATIVE_INFINITY) >= o.chainRefreshMs;
    const onchain = o.registry.onchain(ONCHAIN_LIMIT);
    const symbols = new Set<string>();
    for (const market of onchain) {
      if (now < market.expiresAt && due(market.symbol)) symbols.add(market.symbol);
    }
    for (const market of o.registry.onchainUnsettled()) {
      if (due(market.symbol)) symbols.add(market.symbol);
    }
    // Older markets are read until their final state is cached: once after a restart, and once
    // more after settlement so the view carries the payouts and the redemption time.
    let catchUp = 0;
    for (const market of onchain) {
      if (catchUp >= CATCH_UP_READS) break;
      if (symbols.has(market.symbol)) continue;
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
    if (market.venueStatus !== "active") throw new MarketError("not_allowed", `market ${symbol} is not active at the venue`);
    if (!(o.now() < market.expiresAt)) throw new MarketError("expired", `market ${symbol} has expired`);
    if (market.unitIncrement !== 1n) {
      throw new MarketError("not_allowed", `market ${symbol} trades in steps of ${market.unitIncrement} units, not 1`);
    }

    // The names only reach the chain for a mint that does not exist yet.
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
      await refreshList(failures);
      await refreshChain(failures);
      if (failures.length > 0) throw new RefreshError(failures);
    },

    eventViews() {
      return o.registry.liveEvents(o.now()).map(toEventView);
    },

    eventView(ticker) {
      const event = o.registry.event(ticker);
      if (event === undefined) return undefined;
      return {
        ...toEventView(event),
        description: event.description,
        source: event.source,
        termsUrl: event.termsUrl,
        rules: Object.fromEntries(event.markets.map((market) => [market.symbol, market.rules])),
      };
    },

    views() {
      return o.registry.onchain(ONCHAIN_LIMIT).map(toView);
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
  let out = text;
  while (/gemi/i.test(out)) out = out.replace(/gemini|gemi/gi, "");
  return out;
}

/** `3.550` -> `3.55`, `50.00` -> `50`; a whole number is left as it is. */
function withoutTrailingZeros(decimal: string): string {
  return decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal;
}

function withoutLastCharacter(text: string): string {
  return Array.from(text).slice(0, -1).join("").trimEnd();
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
