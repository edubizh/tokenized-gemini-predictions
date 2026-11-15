// What the sandbox sends, read into the relayer's own types. Nothing here does I/O.

import type { Cadence } from "../../api/types.ts";
import { parseDecimal, parsePx, parseUnits } from "../../money.ts";
import type { BookLevel, ContractInfo, Depth, EventInfo, PricePoint, VenueTrade } from "../venue.ts";

export type Row = Record<string, unknown>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const CADENCE_BY_TAG = new Map<string, Cadence>([
  ["five-minute", "5m"],
  ["fifteen-minute", "15m"],
  ["hourly", "hourly"],
  ["daily", "daily"],
  ["monthly", "monthly"],
]);

/** The longest contract life of each cadence, shortest first. Weekly events carry no tag of their own. */
const CADENCE_BY_LIFE: ReadonlyArray<readonly [maxMs: number, cadence: Cadence]> = [
  [5 * MINUTE_MS, "5m"],
  [15 * MINUTE_MS, "15m"],
  [90 * MINUTE_MS, "hourly"],
  [36 * HOUR_MS, "daily"],
  [10 * DAY_MS, "weekly"],
  [Number.POSITIVE_INFINITY, "monthly"],
];

const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/**
 * One event of the list. Throws with the reason when the event cannot be described. A contract
 * that cannot be described is left out and its reason passed to `skipped`.
 */
export function toEvent(row: unknown, skipped: (reason: string) => void): EventInfo {
  const ticker = isRecord(row) ? row.ticker : undefined;
  if (!isRecord(row) || typeof ticker !== "string" || ticker === "") throw new Error("event without a ticker");
  const date = (field: string): Date => readDate(row, field, `event ${ticker}`);

  const contracts: ContractInfo[] = [];
  for (const contract of Array.isArray(row.contracts) ? row.contracts : []) {
    try {
      contracts.push(toContract(contract, ticker));
    } catch (error) {
      skipped(error instanceof Error ? error.message : String(error));
    }
  }
  const first = contracts[0];
  if (first === undefined) throw new Error(`event ${ticker}: no readable contract`);
  contracts.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const path: unknown = isRecord(row.subcategory) ? row.subcategory.path : undefined;
  const source = row.sourceDetails;
  return {
    ticker,
    title: typeof row.title === "string" ? row.title : ticker,
    category: typeof row.category === "string" ? row.category : "",
    subcategory: Array.isArray(path) ? path.slice(1).filter((name): name is string => typeof name === "string") : [],
    underlying: underlyingOf(ticker),
    shape: row.type === "binary" ? "binary" : "ladder",
    cadence: cadenceOf(row.eventTags, first),
    description: typeof row.description === "string" ? row.description : "",
    source: isRecord(source) && typeof source.agency === "string" && typeof source.index === "string" ? { agency: source.agency, index: source.index } : null,
    // It becomes a link on a page, so nothing but https is passed on.
    termsUrl: typeof row.termsLink === "string" && row.termsLink.startsWith("https://") ? row.termsLink : null,
    listedAt: date("createdAt"),
    expiresAt: date("expiryDate"),
    status: typeof row.status === "string" ? row.status : "unknown",
    volumeUnits: unitsOrZero(row.volume),
    contracts,
  };
}

/**
 * The venue writes the strike in a ladder label without its trailing zeros (`$6.1 or above` for
 * the strike `6.10`). A label that states the strike's number is written again with the strike's
 * own digits and thousands separators (`$6.10 or above`); any other label is kept as written.
 */
function strikeLabel(label: string, strike: string | null): string {
  const stated = /^\$([\d,]+(?:\.\d+)?) or above$/.exec(label)?.[1];
  if (stated === undefined || strike === null || !/^\d+(?:\.\d+)?$/.test(strike)) return label;
  const short = (decimal: string): string => (decimal.includes(".") ? decimal.replace(/\.?0+$/, "") : decimal);
  if (short(stated.replaceAll(",", "")) !== short(strike)) return label;
  const [whole = "", fraction] = strike.split(".");
  return `$${whole.replace(/\B(?=(\d{3})+$)/g, ",")}${fraction === undefined ? "" : `.${fraction}`} or above`;
}

/**
 * One contract of an event. Throws with the reason when the row has no symbol, a date that
 * cannot be read, or a price and quantity grid that cannot be traded on in px and units: none of
 * these is guessed. States and the resolution side are read leniently (unknown values pass
 * through or become null). `prices` is `{ buy: {}, sell: {} }` without quotes: a key that is
 * absent means no quote, and a row without `prices` leaves the quote fields out.
 */
export function toContract(row: unknown, eventTicker: string): ContractInfo {
  const symbol = isRecord(row) ? upper(row.instrumentSymbol) : null;
  if (!isRecord(row) || symbol === null || symbol === "") throw new Error(`event ${eventTicker}: a contract has no symbol`);
  const grid = (field: string, decimals: number): bigint => {
    try {
      const value = parseDecimal(text(row[field]) ?? "", decimals);
      if (value > 0n) return value;
    } catch {
      // Reported below.
    }
    throw new Error(`contract ${symbol}: unreadable ${field}`);
  };
  const side = lower(row.resolutionSide);
  const rules = plainText(row.description).replace(MARKDOWN_LINK, "$1").trim();
  const prices = row.prices;
  const strike = isRecord(row.strike) ? text(row.strike.value) : null;
  return {
    symbol,
    eventTicker,
    status: typeof row.status === "string" ? row.status : "unknown",
    marketState: typeof row.marketState === "string" ? row.marketState : "unknown",
    effectiveAt: readDate(row, "effectiveDate", `contract ${symbol}`),
    expiresAt: readDate(row, "expiryDate", `contract ${symbol}`),
    tickPx: grid("priceIncrement", 4),
    unitIncrement: grid("quantityIncrement", 2),
    minUnits: grid("quantityMinimum", 2),
    resolutionSide: side === "yes" || side === "no" ? side : null,
    ...(typeof row.label === "string" ? { label: strikeLabel(row.label, strike) } : {}),
    ...(typeof row.sortOrder === "number" && Number.isInteger(row.sortOrder) ? { sortOrder: row.sortOrder } : {}),
    ...(rules === "" ? {} : { rules }),
    strike,
    settlementValue: text(row.settlementValue),
    ...(isRecord(prices) ? { bestBidPx: wholePx(prices.bestBid), bestAskPx: wholePx(prices.bestAsk), lastPx: wholePx(prices.lastTradePrice) } : {}),
  };
}

/** Up to `levels` levels a side of a book, best first as the venue sends them. */
export function toDepth(body: unknown, levels: number): Depth {
  if (!isRecord(body) || !Array.isArray(body.bids) || !Array.isArray(body.asks)) throw new Error("unexpected book response");
  return { bids: body.bids.slice(0, levels).map(toLevel), asks: body.asks.slice(0, levels).map(toLevel) };
}

/** A level as REST sends it (`{ price, amount }`) or as the socket does (`[price, amount]`). */
function toLevel(level: unknown): BookLevel {
  const [price, amount]: unknown[] = Array.isArray(level) ? level : isRecord(level) ? [level.price, level.amount] : [];
  return { px: parsePx(text(price) ?? ""), units: parseUnits(text(amount) ?? "") };
}

/** A trade tape, newest first as the venue sends it. `type` is the side that crossed the spread. */
export function toTrades(body: unknown): VenueTrade[] {
  if (!Array.isArray(body)) throw new Error("unexpected trades response");
  return body.map((row: unknown): VenueTrade => {
    const id = isRecord(row) ? text(row.tid) : null;
    if (!isRecord(row) || id === null || typeof row.timestampms !== "number" || (row.type !== "buy" && row.type !== "sell")) {
      throw new Error("unexpected trade in the trades response");
    }
    return { id, atMs: row.timestampms, px: parsePx(text(row.price) ?? ""), units: parseUnits(text(row.amount) ?? ""), taker: row.type };
  });
}

/** Candles `[ms, open, high, low, close, volume]`, newest first, as closing prices oldest first. */
export function toHistory(body: unknown): PricePoint[] {
  if (!Array.isArray(body)) throw new Error("unexpected candles response");
  return body
    .map((candle: unknown): PricePoint => {
      const [atMs, close]: unknown[] = Array.isArray(candle) ? [candle[0], candle[4]] : [];
      if (typeof atMs !== "number" || typeof close !== "number") throw new Error("unexpected candle in the candles response");
      // A JSON number prints back as the decimal the venue wrote.
      return { atMs, px: parsePx(String(close)) };
    })
    .reverse();
}

/** The list at `body[key]`. A body without that list is an error, not "no rows". */
export function listOf(body: unknown, key: string): unknown[] {
  const list: unknown = isRecord(body) ? body[key] : undefined;
  if (!Array.isArray(list)) throw new Error(`unexpected response: no "${key}" list`);
  return list;
}

/** The records of the list at `body[key]`. */
export function rowsOf(body: unknown, key: string): Row[] {
  return listOf(body, key).filter(isRecord);
}

/** A price as px, or null when it is absent or not exactly a whole px. */
export function wholePx(value: unknown): bigint | null {
  try {
    return parsePx(text(value) ?? "");
  } catch {
    return null;
  }
}

/** A string, or a number that survived JSON parsing exactly, as text. */
export function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export function upper(value: unknown): string | null {
  return typeof value === "string" ? value.toUpperCase() : null;
}

export function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The duration named by an event tag, else the one the contract's life fits, else "other". */
function cadenceOf(tags: unknown, contract: ContractInfo): Cadence {
  for (const tag of Array.isArray(tags) ? tags : []) {
    const cadence = isRecord(tag) && typeof tag.slug === "string" ? CADENCE_BY_TAG.get(tag.slug) : undefined;
    if (cadence !== undefined) return cadence;
  }
  const lifeMs = contract.expiresAt.getTime() - contract.effectiveAt.getTime();
  if (!(lifeMs > 0)) return "other";
  return CADENCE_BY_LIFE.find(([maxMs]) => lifeMs <= maxMs)?.[1] ?? "other";
}

/** `<UNDERLYING>[05M|15M]<YYMMDDHHmm>`; any other ticker gives its leading letters, or all of it. */
function underlyingOf(ticker: string): string {
  return /^([A-Z]+?)(?:05M|15M)?\d{10}$/.exec(ticker)?.[1] ?? /^[A-Za-z]+/.exec(ticker)?.[0] ?? ticker;
}

/** The text of a rich-text node, its blocks on separate lines. A plain string is its own text. */
function plainText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!isRecord(node)) return "";
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.content)) return "";
  return node.content.map(plainText).join(node.nodeType === "document" ? "\n" : "");
}

function readDate(row: Row, field: string, owner: string): Date {
  const value = row[field];
  const date = new Date(typeof value === "string" ? value : Number.NaN);
  if (Number.isNaN(date.getTime())) throw new Error(`${owner}: unreadable ${field}`);
  return date;
}

/** A quantity in contracts as units; zero when it is absent or cannot be read. */
function unitsOrZero(value: unknown): bigint {
  try {
    return parseUnits(text(value) ?? "");
  } catch {
    return 0n;
  }
}
