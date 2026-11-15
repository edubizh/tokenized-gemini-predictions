// Deterministic relayer data for fixtures mode (RELAYER_URL=fixtures), screenshots and tests: the
// venue's variety as a handful of series, each listing a new event on a fixed beat. Everything
// here is a pure function of the time asked about, so the same time always gives the same data.

import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { OUTCOME_TOKENS_PROGRAM_ADDRESS } from "@outcome/program-client";
import { cost, feeCap, parseDecimal, takerFee } from "@outcome/relayer/money";
import type {
  ApiBook,
  ApiDepth,
  ApiEventDetail,
  ApiHealth,
  ApiHistory,
  ApiMarket,
  ApiOnchainMarket,
  ApiOrder,
  ApiStatus,
  ApiTrade,
  Cadence,
  NotTradableReason,
  SideName,
} from "@outcome/relayer/api-types";
import type { FixtureChainMarket } from "@/lib/fixtures/chain-types";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The short-lived series list a new event every five minutes, whatever their cadence says, so
 * that an order can be followed to its settlement and redemption in one sitting.
 */
const BEAT_MS = 5 * MINUTE;
/** New orders are taken until this long before expiry. */
const ORDERS_CLOSE_MS = MINUTE;
/** The settler records a result on Solana this long after the venue reports it. */
const SETTLED_AFTER_MS = 4 * SECOND;
/** Redemption opens this long after a market is settled on Solana. */
const REDEEM_AFTER_MS = 90 * SECOND;
const TICK_PX = 100n;
/** Tokens of every market that exists on-chain from the start: YES, then NO. */
const SEEDED_SUPPLY = [1_250n, 400n] as const;
const NONE: ReadonlySet<string> = new Set();

/** Pseudo-random bytes from a label (FNV-1a seed, xorshift32 stream). Not a hash; fixtures only. */
function bytesFor(label: string, length: number): Uint8Array {
  let state = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) state = Math.imul(state ^ label.charCodeAt(i), 0x01000193) >>> 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

export function fixtureAddress(label: string): string {
  return getAddressDecoder().decode(bytesFor(`address:${label}`, 32));
}

export function fixtureSignature(label: string): string {
  const bytes = bytesFor(`signature:${label}`, 64);
  bytes[0] = (bytes[0] ?? 0) | 0x80; // keeps the base58 form at full length
  return getBase58Decoder().decode(bytes);
}

const RELAYER = fixtureAddress("relayer");
const STABLE_MINT = fixtureAddress("stable-mint");

/** Bid, ask and last trade of one contract, in px. What is left out does not exist. */
interface Quote {
  bid?: bigint;
  ask?: bigint;
  /** The last trade of a contract that is not quoted on both sides now. */
  last?: bigint;
}

interface Series {
  /** What a ticker starts with: the underlying, and the venue's marker on 5 and 15 minute events. */
  prefix: string;
  underlying: string;
  /** The underlying in words, for titles and rules. */
  subject: string;
  category: string;
  subcategory: string[];
  shape: "binary" | "ladder";
  cadence: Cadence;
  /** A new event expires every `every`, `offset` after a multiple of it. */
  every: number;
  offset: number;
  /** How many of the events still to expire are listed. */
  listed: number;
  /** Trading, or the window of an up-or-down contract, starts this long before expiry. */
  runs: number;
  /** The event is listed this long before trading starts. */
  announced: number;
  /** Quotes appear this long before expiry and stay until it. */
  quotedFor: number;
  /** The venue reports the result this long after expiry. */
  resultAfter: number;
  /** Dollars as the venue prints them: the strikes of a ladder, ascending, or the price to beat of an up-or-down contract. */
  strikes: readonly string[];
  /** The values successive events settle at. A contract resolves Yes when the value is at or above its strike. */
  settlements: readonly string[];
  /** One per contract. */
  quotes: readonly Quote[];
  /** Units resting at the best bid and at the best ask. */
  sizes: readonly [bid: bigint, ask: bigint];
  /** The contracts, by position, that exist on-chain from the start. The others are created when first traded. */
  onchain: readonly number[];
  /** Units traded once the event has started. */
  volumeUnits: string;
  /** Who publishes the value the event resolves from, and the terms of the contract. Null where the venue names none. */
  source: { agency: string; index: string } | null;
  termsUrl: string | null;
}

const crypto = (underlying: string, subject: string) => ({
  underlying,
  subject,
  category: "Crypto",
  subcategory: [subject],
  resultAfter: 8 * SECOND,
  sizes: [2_500n, 1_800n] as const,
  onchain: [],
  volumeUnits: "0",
  source: { agency: "reference-rates", index: `RR-${underlying}USD-60S` },
  termsUrl: `https://example.com/terms/${underlying.toLowerCase()}.pdf`,
});

const upOrDown = (minutes: 5 | 15, offsetMinutes: number) => ({
  shape: "binary" as const,
  cadence: minutes === 5 ? ("5m" as const) : ("15m" as const),
  every: BEAT_MS,
  offset: offsetMinutes * MINUTE,
  listed: 1,
  runs: minutes * MINUTE,
  announced: 4 * MINUTE,
  quotedFor: (minutes - 2) * MINUTE,
});

const ladder = (cadence: Cadence, every: number, offset: number) => ({ shape: "ladder" as const, cadence, every, offset, listed: 1, runs: every, announced: HOUR, quotedFor: every });

/**
 * What the venue shows at any moment: up-or-down contracts of 5 and 15 minutes, an hourly ladder
 * quoted on every strike, a daily ladder quoted on some, a commodity ladder nobody quotes, and a
 * weekly ladder with a bid on one strike and its successor listed but not trading yet. The short
 * series expire a minute apart, so that the closing minute of one never empties the list.
 */
const SERIES: readonly Series[] = [
  // The next event is listed before its window opens: no price to beat yet, nothing to trade.
  { ...crypto("BTC", "Bitcoin"), ...upOrDown(5, 0), prefix: "BTC05M", listed: 2, announced: HOUR, quotedFor: 4 * MINUTE, strikes: ["104188.4"], settlements: ["104201.75", "104160.2"], quotes: [{ bid: 4_600n, ask: 4_900n }], volumeUnits: "1200" },
  // Never quoted: the venue's makers skip many of the shortest contracts.
  { ...crypto("SOL", "Solana"), ...upOrDown(5, 0), prefix: "SOL05M", quotedFor: 0, strikes: ["187.9104166667"], settlements: ["187.95", "187.31"], quotes: [{}] },
  { ...crypto("BTC", "Bitcoin"), ...upOrDown(15, 1), prefix: "BTC15M", strikes: ["104212.5"], settlements: ["104243.9", "104180.02"], quotes: [{ bid: 5_500n, ask: 5_700n }], sizes: [25_000n, 18_000n], onchain: [0], volumeUnits: "4800" },
  { ...crypto("ETH", "Ethereum"), ...upOrDown(15, 2), prefix: "ETH15M", strikes: ["3415.2266666667"], settlements: ["3404.11", "3421.6"], quotes: [{ bid: 3_800n, ask: 4_100n }], sizes: [12_000n, 9_500n], volumeUnits: "2150" },
  // The venue is slow with this one's result, so one of its events is always awaiting it.
  { ...crypto("XRP", "XRP"), ...upOrDown(15, 4), prefix: "XRP15M", resultAfter: 6 * MINUTE, strikes: ["0.9908752722"], settlements: ["0.99312", "0.98871"], quotes: [{ bid: 6_100n, ask: 6_400n }], onchain: [0], volumeUnits: "900" },
  {
    ...crypto("BTC", "Bitcoin"),
    ...ladder("hourly", BEAT_MS, 3 * MINUTE),
    prefix: "BTC",
    runs: HOUR,
    quotedFor: 46 * MINUTE,
    strikes: ["103900", "104000", "104100", "104200", "104300", "104400", "104500", "104600"],
    settlements: ["104212.5"],
    quotes: [
      { bid: 9_100n, ask: 9_500n },
      { bid: 8_200n, ask: 8_600n },
      { bid: 6_700n, ask: 7_100n },
      { bid: 5_200n, ask: 5_600n },
      { bid: 3_600n, ask: 4_000n },
      { bid: 2_000n, ask: 2_400n },
      { bid: 900n, ask: 1_300n },
      { bid: 300n, ask: 700n },
    ],
    onchain: [2, 5],
    volumeUnits: "49400",
  },
  {
    ...crypto("ETH", "Ethereum"),
    ...ladder("daily", DAY, 22 * HOUR),
    prefix: "ETH",
    strikes: ["3300", "3350", "3400", "3450", "3500", "3550"],
    settlements: ["3412.08"],
    quotes: [{ last: 9_200n }, { bid: 7_800n, ask: 8_200n }, { bid: 5_500n, ask: 5_900n }, { bid: 3_000n, ask: 3_400n }, {}, {}],
    volumeUnits: "21600",
  },
  {
    ...ladder("daily", DAY, 22 * HOUR),
    prefix: "XAU",
    underlying: "XAU",
    subject: "Gold",
    category: "Commodities",
    subcategory: ["Precious Metals", "Gold"],
    resultAfter: 40 * SECOND,
    strikes: ["3750", "3775", "3800", "3825", "3850"],
    settlements: ["3799.671428571428"],
    quotes: [{}, {}, {}, {}, {}],
    sizes: [0n, 0n],
    onchain: [],
    volumeUnits: "0",
    source: { agency: "reference-rates", index: "RR-XAUUSD-60S" },
    termsUrl: "https://example.com/terms/gold.pdf",
  },
  // Fridays at 22:00 UTC. The venue names no source and no terms for it.
  {
    ...crypto("SOL", "Solana"),
    ...ladder("weekly", 7 * DAY, DAY + 22 * HOUR),
    prefix: "SOL",
    listed: 2,
    announced: 7 * DAY,
    strikes: ["170", "180", "190", "200", "210"],
    settlements: ["187.32"],
    quotes: [{}, {}, {}, { bid: 200n }, {}],
    source: null,
    termsUrl: null,
  },
];

/** The outcome tokens every wallet starts with, in each event of a series that the fixtures remember. */
const HOLDINGS: ReadonlyArray<{ prefix: string; contract: number; side: SideName; units: bigint }> = [
  { prefix: "BTC15M", contract: 0, side: "YES", units: 300n },
  { prefix: "XRP15M", contract: 0, side: "YES", units: 500n },
  // Of the hourly ladder: a strike that resolves Yes and one that resolves No.
  { prefix: "BTC", contract: 2, side: "YES", units: 200n },
  { prefix: "BTC", contract: 5, side: "YES", units: 250n },
];

const two = (value: number) => String(value).padStart(2, "0");

/** The time part of a venue ticker: `2611142215`, in UTC. */
function stamp(atMs: number): string {
  const d = new Date(atMs);
  return `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}`;
}

/** The series and the expiry a ticker names, or null when no fixture event has that ticker. */
function locate(ticker: string): { series: Series; expiry: number } | null {
  const time = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ticker.slice(-10));
  const series = SERIES.find((candidate) => candidate.prefix === ticker.slice(0, -10));
  if (!time || !series) return null;
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0] = time.slice(1).map(Number);
  const expiry = Date.UTC(2000 + year, month - 1, day, hour, minute);
  return (expiry - series.offset) % series.every === 0 && stamp(expiry) === ticker.slice(-10) ? { series, expiry } : null;
}

/** The expiries of the events of a series that are still to come, soonest first, as many as it lists. */
function upcoming(series: Series, nowMs: number): number[] {
  const next = (Math.floor((nowMs - series.offset) / series.every) + 1) * series.every + series.offset;
  return Array.from({ length: series.listed }, (_, index) => next + index * series.every);
}

/** What the fixtures keep of a series: its listed events and the one that expired last. */
function remembered(series: Series, nowMs: number): number[] {
  const listed = upcoming(series, nowMs);
  return [(listed[0] as number) - series.every, ...listed];
}

const tickerOf = (series: Series, expiry: number) => `${series.prefix}${stamp(expiry)}`;
const codeOf = (series: Series, index: number) => (series.shape === "binary" ? "UP" : `HI${(series.strikes[index] as string).replace(".", "D")}`);
const symbolOf = (series: Series, expiry: number, index: number) => `GEMI-${tickerOf(series, expiry)}-${codeOf(series, index)}`;
/** `$104,200 or above`: a strike with its whole dollars grouped. */
function labelOf(series: Series, index: number): string {
  if (series.shape === "binary") return "Up";
  const [whole = "", cents] = (series.strikes[index] as string).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cents === undefined ? "" : `.${cents}`} or above`;
}
const scaled = (value: string) => parseDecimal(value, 12);

function settlementOf(series: Series, expiry: number): string {
  return series.settlements[((expiry - series.offset) / series.every) % series.settlements.length] as string;
}

const EASTERN = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });

/** The venue words its titles and rules in US Eastern time: `5:15pm EST`, `November 14`. */
function eastern(atMs: number): { clock: string; zone: string; day: string; year: string } {
  const parts = EASTERN.formatToParts(new Date(atMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  const clock = `${part("hour")}${part("minute") === "00" ? "" : `:${part("minute")}`}${part("dayPeriod").toLowerCase()}`;
  return { clock, zone: part("timeZoneName"), day: `${part("month")} ${part("day")}`, year: part("year") };
}

function titleOf(series: Series, expiry: number): string {
  const { clock, zone, day } = eastern(expiry);
  if (series.runs <= HOUR) return `${series.underlying} price today at ${clock} ${zone}`;
  return series.category === "Crypto" ? `${series.underlying} price on ${day}` : `${series.subject} price on ${day}?`;
}

/** The step of a contract's price history, from how long it runs. */
function stepSecs(series: Series): number {
  if (series.runs <= 2 * HOUR) return 60;
  if (series.runs <= 36 * HOUR) return 900;
  return series.runs <= 10 * DAY ? 3_600 : 21_600;
}

interface Print {
  at: number;
  px: bigint;
  units: bigint;
}

/**
 * The trades of a contract up to `nowMs`, oldest first: one per step of its history while it is
 * quoted on both sides, each a few cents from the middle of its quote.
 */
function tape(series: Series, expiry: number, index: number, nowMs: number): Print[] {
  const { bid, ask } = series.quotes[index] as Quote;
  if (bid === undefined || ask === undefined) return [];
  const step = stepSecs(series) * SECOND;
  const middle = ((bid + ask) / 2n / TICK_PX) * TICK_PX;
  const prints: Print[] = [];
  for (let at = Math.ceil((expiry - series.quotedFor) / step) * step; at <= Math.min(nowMs, expiry - 1); at += step) {
    const turn = at / step;
    const px = middle + TICK_PX * BigInt(((turn * 7 + index * 3) % 9) - 4);
    prints.push({ at, px: px < TICK_PX ? TICK_PX : px > 9_900n ? 9_900n : px, units: 100n * BigInt(1 + ((turn * 5 + index) % 20)) });
  }
  return prints;
}

function bookOf(series: Series, expiry: number, index: number, nowMs: number): ApiBook | null {
  const started = nowMs >= expiry - series.runs;
  // Before a ladder starts its contracts are not instruments yet, and after expiry the book is gone.
  if (nowMs >= expiry || (!started && series.shape === "ladder")) return null;
  const quoted = started && nowMs >= expiry - series.quotedFor;
  const { bid, ask } = quoted ? (series.quotes[index] as Quote) : ({} as Quote);
  return {
    bidPx: bid?.toString() ?? null,
    bidUnits: bid === undefined ? "0" : series.sizes[0].toString(),
    askPx: ask?.toString() ?? null,
    askUnits: ask === undefined ? "0" : series.sizes[1].toString(),
    at: nowMs - SECOND,
  };
}

function marketAt(series: Series, expiry: number, index: number, nowMs: number, created: ReadonlySet<string>): ApiMarket {
  const symbol = symbolOf(series, expiry, index);
  const binary = series.shape === "binary";
  const strike = series.strikes[index] as string;
  const started = nowMs >= expiry - series.runs;
  const expired = nowMs >= expiry;
  const resultAt = expiry + series.resultAfter;
  const resolved = nowMs >= resultAt;
  const settlement = settlementOf(series, expiry);
  const won = scaled(settlement) >= scaled(strike);
  const book = bookOf(series, expiry, index, nowMs);

  let reason: NotTradableReason | null = null;
  if (expired) reason = "market_not_open";
  else if (!started) reason = binary ? "not_started" : "not_active";
  else if (nowMs >= expiry - ORDERS_CLOSE_MS) reason = "too_close_to_expiry";
  else if (book === null || (book.bidPx === null && book.askPx === null)) reason = "no_offers";

  let onchain: ApiOnchainMarket | null = null;
  const seeded = series.onchain.includes(index);
  if (seeded || created.has(symbol)) {
    const settledAt = resultAt + SETTLED_AFTER_MS;
    const settled = nowMs >= settledAt;
    onchain = {
      market: fixtureAddress(`market:${symbol}`),
      yesMint: fixtureAddress(`yes:${symbol}`),
      noMint: fixtureAddress(`no:${symbol}`),
      status: settled ? "settled" : "open",
      closeTs: Math.floor(expiry / SECOND),
      placeCutoffSecs: ORDERS_CLOSE_MS / SECOND,
      yesSupply: (seeded ? SEEDED_SUPPLY[0] : 0n).toString(),
      noSupply: (seeded ? SEEDED_SUPPLY[1] : 0n).toString(),
      yesPayout: settled ? (won ? "10000" : "0") : null,
      noPayout: settled ? (won ? "0" : "10000") : null,
      redeemAfter: settled ? Math.floor((settledAt + REDEEM_AFTER_MS) / SECOND) : null,
    };
  }

  // An up-or-down contract trades from its listing at the venue; a ladder is approved first.
  const venueStatus = resolved ? "settled" : expired ? "under_review" : started || binary ? "active" : "approved";
  return {
    symbol,
    eventTicker: tickerOf(series, expiry),
    title: titleOf(series, expiry),
    label: labelOf(series, index),
    // The price to beat of an up-or-down contract is taken when its window starts.
    strike: binary && !started ? null : strike,
    sortOrder: index,
    startsAt: expiry - series.runs,
    expiresAt: expiry,
    lastOrderAt: expiry - ORDERS_CLOSE_MS,
    venueStatus,
    marketState: expired ? "closed" : venueStatus === "approved" ? "post_only" : "open",
    tradable: reason === null,
    notTradableReason: reason,
    tickPx: TICK_PX.toString(),
    minUnits: "1",
    unitIncrement: "1",
    book,
    lastPx: (tape(series, expiry, index, nowMs).at(-1)?.px ?? (started ? series.quotes[index]?.last : undefined))?.toString() ?? null,
    onchain,
    resolution: resolved ? (won ? "yes" : "no") : null,
    settlementValue: resolved ? settlement : null,
    settleState: !expired ? "open" : onchain === null ? "unused" : onchain.status === "settled" ? "settled" : "awaiting_result",
  };
}

function eventAt(series: Series, expiry: number, nowMs: number, created: ReadonlySet<string>): ApiEventDetail {
  const markets = series.strikes.map((_, index) => marketAt(series, expiry, index, nowMs, created));
  const { clock, day, year } = eastern(expiry);
  const when = `on ${day}, ${year} at ${clock} ET`;
  const verified = series.source ? ` Outcome verified against the ${series.source.index} index.` : "";
  return {
    ticker: tickerOf(series, expiry),
    title: titleOf(series, expiry),
    category: series.category,
    subcategory: series.subcategory,
    underlying: series.underlying,
    shape: series.shape,
    cadence: series.cadence,
    listedAt: expiry - series.runs - series.announced,
    expiresAt: expiry,
    venueStatus: (markets[0] as ApiMarket).venueStatus,
    volumeUnits: nowMs >= expiry - series.runs ? series.volumeUnits : "0",
    markets,
    description: `Interval ${series.underlying} price prediction event expiring ${when}`,
    source: series.source,
    termsUrl: series.termsUrl,
    rules: Object.fromEntries(
      markets.map((market) => {
        const condition = series.shape === "binary" ? "greater than or equal to the price to beat" : market.label;
        return [market.symbol, `If the price of ${series.subject} (${series.underlying}) is ${condition} ${when}, this market will resolve to Yes. Otherwise, it will resolve to No.${verified}`];
      }),
    ),
  };
}

/** Every listed event that has not expired, soonest expiry first. `created` names the markets created on-chain since. */
export function fixtureEvents(nowMs: number, created: ReadonlySet<string> = NONE): ApiEventDetail[] {
  return SERIES.flatMap((series) => upcoming(series, nowMs).map((expiry) => eventAt(series, expiry, nowMs, created))).sort(
    (a, b) => a.expiresAt - b.expiresAt || (a.ticker < b.ticker ? -1 : 1),
  );
}

/** One event by its ticker, expired or not. Null for a ticker no series lists, or one that is not listed yet. */
export function fixtureEvent(ticker: string, nowMs: number, created: ReadonlySet<string> = NONE): ApiEventDetail | null {
  const found = locate(ticker);
  if (!found) return null;
  const event = eventAt(found.series, found.expiry, nowMs, created);
  return event.listedAt <= nowMs ? event : null;
}

interface Contract {
  series: Series;
  expiry: number;
  index: number;
}

function contractOf(symbol: string, nowMs: number): Contract | null {
  const parts = /^GEMI-([A-Z0-9]+)-([A-Z0-9]+)$/.exec(symbol);
  const found = parts && locate(parts[1] as string);
  if (!found || found.expiry - found.series.runs - found.series.announced > nowMs) return null;
  const index = found.series.strikes.findIndex((_, candidate) => codeOf(found.series, candidate) === parts[2]);
  return index === -1 ? null : { ...found, index };
}

/** One contract by its symbol, expired or not. Null when no fixture event has it. */
export function fixtureMarket(symbol: string, nowMs: number, created: ReadonlySet<string> = NONE): ApiMarket | null {
  const contract = contractOf(symbol, nowMs);
  return contract && marketAt(contract.series, contract.expiry, contract.index, nowMs, created);
}

/**
 * The markets that exist on-chain, newest expiry first: those of the remembered events that
 * start on-chain, and those created since.
 */
export function fixtureOnchainMarkets(nowMs: number, created: ReadonlySet<string> = NONE): ApiMarket[] {
  const markets = new Map<string, ApiMarket>();
  for (const series of SERIES) {
    for (const expiry of remembered(series, nowMs)) for (const index of series.onchain) markets.set(symbolOf(series, expiry, index), marketAt(series, expiry, index, nowMs, created));
  }
  for (const symbol of created) {
    const market = markets.has(symbol) ? null : fixtureMarket(symbol, nowMs, created);
    if (market) markets.set(symbol, market);
  }
  return [...markets.values()].sort((a, b) => b.expiresAt - a.expiresAt || (a.symbol < b.symbol ? -1 : 1));
}

/** The tokens every wallet starts with: one position in each remembered event of the series it holds. */
export function fixtureHoldings(nowMs: number): Array<{ mint: string; units: bigint }> {
  return HOLDINGS.flatMap(({ prefix, contract, side, units }) => {
    const series = SERIES.find((candidate) => candidate.prefix === prefix) as Series;
    return remembered(series, nowMs).map((expiry) => ({ mint: fixtureAddress(`${side === "YES" ? "yes" : "no"}:${symbolOf(series, expiry, contract)}`), units }));
  });
}

/** Resting orders of one contract: three levels a side, a cent apart, from its quote. Null for an unknown symbol. */
export function fixtureDepth(symbol: string, nowMs: number): ApiDepth | null {
  const contract = contractOf(symbol, nowMs);
  if (!contract) return null;
  const book = bookOf(contract.series, contract.expiry, contract.index, nowMs);
  const levels = (best: string | null | undefined, units: string | undefined, direction: 1n | -1n) =>
    best == null
      ? []
      : [0n, 1n, 2n]
          .map((level) => ({ px: BigInt(best) + direction * level * TICK_PX, units: (BigInt(units ?? "0") * (level + 2n)) / 2n }))
          .filter((level) => level.px >= TICK_PX && level.px <= 9_900n)
          .map((level) => ({ px: level.px.toString(), units: level.units.toString() }));
  return { bids: levels(book?.bidPx, book?.bidUnits, -1n), asks: levels(book?.askPx, book?.askUnits, 1n), at: nowMs - SECOND };
}

/** Trades of one contract, newest first, at most 50. Null for an unknown symbol. */
export function fixtureTrades(symbol: string, nowMs: number): ApiTrade[] | null {
  const contract = contractOf(symbol, nowMs);
  if (!contract) return null;
  const { bid = 0n, ask = 0n } = contract.series.quotes[contract.index] as Quote;
  return tape(contract.series, contract.expiry, contract.index, nowMs)
    .slice(-50)
    .reverse()
    .map((print) => ({ id: `${print.at}${SERIES.indexOf(contract.series)}${contract.index}`, at: print.at, px: print.px.toString(), units: print.units.toString(), taker: print.px * 2n >= bid + ask ? "buy" : "sell" }));
}

/** Price history of one contract, oldest first: the price of each trade. Null for an unknown symbol. */
export function fixtureHistory(symbol: string, nowMs: number): ApiHistory | null {
  const contract = contractOf(symbol, nowMs);
  if (!contract) return null;
  return { stepSecs: stepSecs(contract.series), points: tape(contract.series, contract.expiry, contract.index, nowMs).map((print) => ({ at: print.at, px: print.px.toString() })) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A market's account as the simulated chain holds it, with the name the relayer gives its YES token: `BTC >=104100 14Nov26 22:13 YES`. */
export function fixtureChainMarket(market: ApiMarket): FixtureChainMarket | null {
  const onchain = market.onchain;
  const found = locate(market.eventTicker);
  if (!onchain || !found) return null;
  const expiry = new Date(market.expiresAt);
  const outcome = found.series.shape === "binary" ? `Up ${found.series.runs / MINUTE}m` : `>=${market.strike ?? ""}`;
  const day = `${two(expiry.getUTCDate())}${MONTHS[expiry.getUTCMonth()] ?? ""}${two(expiry.getUTCFullYear() % 100)}`;
  return {
    address: onchain.market,
    symbol: market.symbol,
    yesMint: onchain.yesMint,
    noMint: onchain.noMint,
    status: onchain.status,
    closeTs: onchain.closeTs,
    placeCutoffSecs: onchain.placeCutoffSecs,
    tickPx: Number(market.tickPx),
    yesPayout: onchain.yesPayout ?? "0",
    noPayout: onchain.noPayout ?? "0",
    redeemAfter: onchain.redeemAfter ?? 0,
    tokenName: `${found.series.underlying} ${outcome} ${day} ${two(expiry.getUTCHours())}:${two(expiry.getUTCMinutes())} YES`,
  };
}

type OrderState = ApiOrder["state"];

interface OrderSpec {
  state: OrderState;
  prefix: string;
  contract: number;
  side: SideName;
  units: bigint;
  limitPx: bigint;
  /** Fill price in the order's own outcome space; null when nothing filled. */
  fillPx: bigint | null;
  /** How long before the start of the beat the order was placed. */
  age: number;
  detail: string | null;
}

/** One order the relayer never sends, which stays open until it is reclaimed, and one in each finished state. */
const ORDERS: readonly OrderSpec[] = [
  { state: "seen", prefix: "XRP15M", contract: 0, side: "YES", units: 500n, limitPx: 6_400n, fillPx: null, age: 2 * SECOND, detail: null },
  { state: "chain_filled", prefix: "BTC15M", contract: 0, side: "YES", units: 500n, limitPx: 5_700n, fillPx: 5_600n, age: 12 * MINUTE, detail: null },
  { state: "chain_cancelled", prefix: "BTC", contract: 5, side: "NO", units: 400n, limitPx: 7_000n, fillPx: null, age: 31 * MINUTE, detail: "no offers at or below the limit" },
  { state: "orphaned", prefix: "BTC15M", contract: 0, side: "NO", units: 150n, limitPx: 4_600n, fillPx: 4_500n, age: 44 * MINUTE, detail: "filled at the venue after the order expired on-chain; refunded, kept as operator inventory" },
  { state: "failed", prefix: "XRP15M", contract: 0, side: "YES", units: 250n, limitPx: 6_400n, fillPx: null, age: 47 * MINUTE, detail: "market closed before the order could be sent" },
];

export const FIXTURE_ORDER_TTL_SECS = 45;

/**
 * The orders every wallet has before it places one, newest first. They are placed afresh at the
 * start of every beat, each in the event of its series that was running then.
 */
export function fixtureOrders(nowMs: number): ApiOrder[] {
  const beat = Math.floor(nowMs / BEAT_MS) * BEAT_MS;
  return ORDERS.map((spec, index) => {
    const series = SERIES.find((candidate) => candidate.prefix === spec.prefix) as Series;
    const createdAt = beat - spec.age;
    const filled = spec.fillPx !== null;
    const fee = filled ? takerFee(spec.units, spec.fillPx as bigint) : 0n;
    const recorded = spec.state === "chain_filled" || spec.state === "chain_cancelled" || spec.state === "orphaned";
    return {
      address: fixtureAddress(`order:${index}`),
      user: fixtureAddress("user"),
      symbol: symbolOf(series, upcoming(series, createdAt)[0] as number, spec.contract),
      kind: "buy",
      side: spec.side,
      units: spec.units.toString(),
      limitPx: spec.limitPx.toString(),
      maxFeeMicros: feeCap(spec.units, spec.limitPx).toString(),
      expiresAt: Math.floor((createdAt + FIXTURE_ORDER_TTL_SECS * SECOND) / SECOND),
      state: spec.state,
      venueOrderId: spec.state === "seen" || spec.state === "failed" ? null : `7361528${(40_000_000_000 + index * 1_117).toString()}`,
      filledUnits: filled ? spec.units.toString() : "0",
      amountMicros: filled ? cost(spec.units, spec.fillPx as bigint).toString() : "0",
      feeMicros: fee.toString(),
      fills: filled ? [{ tradeId: `28417300${5_120 + index}`, units: spec.units.toString(), px: (spec.fillPx as bigint).toString(), feeMicros: fee.toString() }] : [],
      chainSignature: recorded ? fixtureSignature(`order:${index}`) : null,
      detail: spec.detail,
      createdAt,
      updatedAt: createdAt + (spec.state === "seen" ? 0 : 3 * SECOND),
    };
  });
}

export function fixtureHealth(nowMs: number): ApiHealth {
  return {
    ok: true,
    cluster: "devnet",
    venue: "mock",
    programId: OUTCOME_TOKENS_PROGRAM_ADDRESS,
    relayer: RELAYER,
    stableMint: STABLE_MINT,
    paused: { place: false, fill: false },
    venueConnected: true,
    chainTime: Math.floor(nowMs / SECOND),
    serverTime: nowMs,
    orderTtlSecs: FIXTURE_ORDER_TTL_SECS,
    minOrderUnits: "1",
    maxOrderUnits: "100000",
    feeSlackMicros: "30000",
  };
}

/** The relayer's books: every on-chain market that is not settled yet balances, and the one orphaned fill is the only alert. */
export function fixtureStatus(nowMs: number, created: ReadonlySet<string> = NONE): ApiStatus {
  const orders = fixtureOrders(nowMs);
  const orphaned = orders.find((order) => order.state === "orphaned");
  const states: OrderState[] = ["seen", "submitting", "venue_filled", "venue_not_filled", "venue_unknown", "chain_filled", "chain_cancelled", "orphaned", "failed"];
  return {
    markets: fixtureOnchainMarkets(nowMs, created)
      .filter((market) => market.onchain?.status !== "settled")
      .map((market) => {
        const yes = BigInt(market.onchain?.yesSupply ?? "0");
        const no = BigInt(market.onchain?.noSupply ?? "0");
        return { symbol: market.symbol, yesSupply: yes.toString(), noSupply: no.toString(), venueNet: (yes - no).toString(), inFlight: "0", houseInventory: "0", balanced: true };
      }),
    solvency: { venueCashMicros: "9412350000", treasuryMicros: "1000038420000", requiredMicros: "17000000", ok: true },
    journal: Object.fromEntries(states.map((state) => [state, orders.filter((order) => order.state === state).length])) as ApiStatus["journal"],
    relayerLamports: "2871450000",
    alerts: orphaned ? [{ at: orphaned.updatedAt, kind: "orphaned_fill", orderAddress: orphaned.address, detail: orphaned.detail ?? "" }] : [],
  };
}
