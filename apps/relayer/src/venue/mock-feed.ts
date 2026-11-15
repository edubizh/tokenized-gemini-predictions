// A mock venue that behaves like a live one for offline demos: at any moment it lists a fixed
// variety of events (up-or-down contracts on two short cadences and strike ladders from hourly to
// monthly, in two categories), quotes some of them, closes each at expiry and resolves it a few
// seconds later from a simulated reference price. Everything follows from the clock alone, so a
// restarted venue lists the same events at the same prices. No network, no API key.

import type { Cadence } from "../api/types.ts";
import { takerFee } from "../money.ts";
import { MockVenue } from "./mock.ts";
import type { MockBook, MockEvent, MockLevel } from "./mock.ts";
import type { VenueOrderRequest, VenueOrderResult } from "./types.ts";
import type { ContractInfo, Depth, EventInfo, TopOfBook } from "./venue.ts";

export const MOCK_WINDOW_SECS_MIN = 180;
/** The venue prefix of every symbol. */
const SYMBOL_PREFIX = "MOCK";

export type MockResolve = "yes" | "no" | "random";

/** What the events of an underlying say about it. Prices are whole numbers of its smallest unit. */
const ASSETS = {
  BTC: { name: "Bitcoin", category: "Crypto", path: ["Bitcoin"], decimals: 2, price: 6_400_000 },
  ETH: { name: "Ethereum", category: "Crypto", path: ["Ethereum"], decimals: 2, price: 310_000 },
  SOL: { name: "Solana", category: "Crypto", path: ["Solana"], decimals: 2, price: 15_000 },
  XRP: { name: "XRP", category: "Crypto", path: ["XRP"], decimals: 4, price: 8_400 },
  XAU: { name: "Gold", category: "Commodities", path: ["Precious Metals", "Gold"], decimals: 2, price: 380_000 },
  COPPER: { name: "Copper", category: "Commodities", path: ["Industrial Metals", "Copper"], decimals: 2, price: 612 },
} as const;

/**
 * How long an event of each cadence trades and how long before that it is listed, in minutes of
 * the real venue. A simulated minute is a fifteenth of the configured window.
 */
const CADENCES: Record<Exclude<Cadence, "other">, { minutes: number; leadMinutes: number; marker: string }> = {
  "5m": { minutes: 5, leadMinutes: 5, marker: "05M" },
  "15m": { minutes: 15, leadMinutes: 4, marker: "15M" },
  hourly: { minutes: 60, leadMinutes: 60, marker: "" },
  daily: { minutes: 1_440, leadMinutes: 60, marker: "" },
  weekly: { minutes: 10_080, leadMinutes: 3, marker: "" },
  monthly: { minutes: 43_200, leadMinutes: 60, marker: "" },
};

/** One recurring kind of event. */
export interface MockSeries {
  underlying: keyof typeof ASSETS;
  /** "binary": one up-or-down contract. "ladder": five to eight "$X or above" contracts. */
  shape: "binary" | "ladder";
  cadence: Exclude<Cadence, "other">;
  /**
   * The distance between two strikes of a ladder, in the underlying's smallest unit; the
   * reference price moves in quarters of it. An up-or-down event has no ladder but moves alike.
   */
  step: number;
  /** Percent of its trading life after which an event is quoted: 0 from the start, null never. */
  quotedFrom: number | null;
}

/**
 * Everything the venue lists. Like the real one it quotes the short crypto contracts late or not
 * at all and the long ladders never; unlike it, the gold ladder is always quoted, so that a
 * commodity can be traded.
 */
export const SERIES: readonly MockSeries[] = [
  { underlying: "BTC", shape: "binary", cadence: "5m", step: 4_000, quotedFrom: 40 },
  { underlying: "ETH", shape: "binary", cadence: "5m", step: 200, quotedFrom: 60 },
  { underlying: "SOL", shape: "binary", cadence: "5m", step: 20, quotedFrom: null },
  { underlying: "BTC", shape: "binary", cadence: "15m", step: 6_000, quotedFrom: 0 },
  { underlying: "ETH", shape: "binary", cadence: "15m", step: 400, quotedFrom: 20 },
  { underlying: "SOL", shape: "binary", cadence: "15m", step: 40, quotedFrom: 40 },
  { underlying: "BTC", shape: "ladder", cadence: "hourly", step: 10_000, quotedFrom: 25 },
  { underlying: "ETH", shape: "ladder", cadence: "hourly", step: 1_000, quotedFrom: 25 },
  { underlying: "XRP", shape: "ladder", cadence: "hourly", step: 100, quotedFrom: 50 },
  { underlying: "BTC", shape: "ladder", cadence: "daily", step: 25_000, quotedFrom: 75 },
  { underlying: "XAU", shape: "ladder", cadence: "daily", step: 2_500, quotedFrom: 0 },
  { underlying: "COPPER", shape: "ladder", cadence: "weekly", step: 4, quotedFrom: null },
  { underlying: "BTC", shape: "ladder", cadence: "monthly", step: 100_000, quotedFrom: null },
];

/** One event of a series, with everything that is fixed from the moment it is listed. */
export interface ScheduledEvent {
  series: MockSeries;
  ticker: string;
  category: string;
  subcategory: string[];
  underlying: string;
  /** Unix milliseconds. Trading, and the observation window of an up-or-down event, start at `startsAt`. */
  listedAt: number;
  startsAt: number;
  expiresAt: number;
  /** The reference price when trading starts, in the underlying's smallest unit. */
  openPrice: number;
  /** The strike of each contract, ascending. An up-or-down contract is struck at the opening price. */
  strikes: number[];
  /** Seeds everything random about the event. */
  seed: number;
}

/** The steps the reference price of an event takes between the start of trading and expiry. */
const WALK_STEPS = 30;
const PX_TICK = 100n;
/** The middle of a quote stays this far inside the price range, so that every level fits. */
const MID_PX_MIN = 500n;
const MID_PX_MAX = 9_500n;
/** Each side is quoted this far from the middle, then cent by cent. */
const HALF_SPREAD = 200n;
const LEVEL_SIZES = [2_500n, 5_000n, 10_000n] as const;

/** FNV-1a: a 32-bit number from a text. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
  return value >>> 0;
}

/** A well mixed 32-bit number for the `n`th draw of a seed. */
function draw(seed: number, n: number): number {
  let value = (seed + Math.imul(n + 1, 0x9e3779b9)) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

const two = (value: number): string => String(value).padStart(2, "0");

/** The event of `series` that expires at `expiresAt`, for a 15-minute window of `windowSecs`. */
function eventOf(series: MockSeries, expiresAt: number, windowSecs: number): ScheduledEvent {
  const asset = ASSETS[series.underlying];
  const { minutes, leadMinutes, marker } = CADENCES[series.cadence];
  const end = new Date(expiresAt);
  const stamp = [end.getUTCFullYear() % 100, end.getUTCMonth() + 1, end.getUTCDate(), end.getUTCHours(), end.getUTCMinutes()].map(two).join("");
  const ticker = `${series.underlying}${marker}${stamp}`;
  const seed = hash(ticker);
  const startsAt = expiresAt - spanMs(minutes, windowSecs);
  // Within three percent of the usual price, different for every event.
  const openPrice = asset.price + Math.trunc((asset.price * ((draw(seed, -1) % 60_001) - 30_000)) / 1_000_000);
  let strikes = [openPrice];
  if (series.shape === "ladder") {
    const count = 5 + (draw(seed, -2) % 4);
    const lowest = Math.round(openPrice / series.step) * series.step - Math.floor(count / 2) * series.step;
    strikes = Array.from({ length: count }, (_, index) => lowest + index * series.step);
  }
  return {
    series,
    ticker,
    category: asset.category,
    subcategory: [...asset.path],
    underlying: series.underlying,
    listedAt: startsAt - spanMs(leadMinutes, windowSecs),
    startsAt,
    expiresAt,
    openPrice,
    strikes,
    seed,
  };
}

/** `minutes` of the real venue on the simulated clock, to the nearest whole second. */
function spanMs(minutes: number, windowSecs: number): number {
  return Math.round((minutes * windowSecs) / 15) * 1_000;
}

/**
 * The events the venue lists at `nowMs`: each is listed some time before it trades and leaves
 * the list when it expires. Every event of a series expires on a whole multiple of the series'
 * length. A ticker names one event: where two ladders of one underlying expire together the
 * longer one stands, as the venue's daily ladder takes the place of the hourly one at that time.
 */
export function scheduleAt(nowMs: number, windowSecs: number): ScheduledEvent[] {
  const listed = new Map<string, ScheduledEvent>();
  for (const series of SERIES) {
    const { minutes, leadMinutes } = CADENCES[series.cadence];
    const lifeMs = spanMs(minutes, windowSecs);
    const last = Math.floor((nowMs + lifeMs + spanMs(leadMinutes, windowSecs)) / lifeMs);
    for (let k = Math.floor(nowMs / lifeMs) + 1; k <= last; k++) {
      const event = eventOf(series, k * lifeMs, windowSecs);
      const same = listed.get(event.ticker);
      if (same === undefined || same.expiresAt - same.startsAt < lifeMs) listed.set(event.ticker, event);
    }
  }
  return [...listed.values()];
}

/** How many steps of its walk an event has taken at `atMs`. */
function stepsTaken(event: ScheduledEvent, atMs: number): number {
  const taken = Math.floor(((atMs - event.startsAt) * WALK_STEPS) / (event.expiresAt - event.startsAt));
  return Math.min(Math.max(taken, 0), WALK_STEPS);
}

/**
 * The reference price of an event at `atMs`, in the underlying's smallest unit: a walk of
 * `WALK_STEPS` pseudo-random steps from the opening price, seeded by the event and finished at
 * expiry. When up-or-down contracts are told how to resolve, the walk of such an event stays on
 * that side of its opening price.
 */
export function referenceAt(event: ScheduledEvent, atMs: number, resolve: MockResolve): number {
  let steps = 0;
  for (let i = stepsTaken(event, atMs); i > 0; i--) steps += (draw(event.seed, i) % 5) - 2;
  const drift = (steps * event.series.step) / 4;
  if (event.series.shape === "ladder" || resolve === "random") return event.openPrice + drift;
  return resolve === "yes" ? event.openPrice + Math.abs(drift) : event.openPrice - Math.abs(drift) - 1;
}

/**
 * How an event resolves: the reference price at expiry, and per contract YES exactly when that
 * value is at or above the contract's strike. Several contracts of one ladder can be YES.
 */
export function resolutionOf(event: ScheduledEvent, resolve: MockResolve): { value: number; sides: Array<"yes" | "no"> } {
  const value = referenceAt(event, event.expiresAt, resolve);
  return { value, sides: event.strikes.map((strike) => (value >= strike ? "yes" : "no")) };
}

/**
 * The resting orders of the `index`th contract of an event at `atMs`: nothing before the series
 * is quoted and nothing from expiry on. The middle follows from how far the reference price is
 * from the strike, measured against how far it can still go: far in the money is quoted high,
 * far out of the money low.
 */
export function quoteAt(event: ScheduledEvent, index: number, atMs: number, resolve: MockResolve): MockBook {
  const { quotedFrom, step } = event.series;
  const strike = event.strikes[index];
  const lifeMs = event.expiresAt - event.startsAt;
  if (strike === undefined || quotedFrom === null || atMs < event.startsAt + (lifeMs * quotedFrom) / 100 || atMs >= event.expiresAt) {
    return { bids: [], asks: [] };
  }
  const edge = BigInt(referenceAt(event, atMs, resolve) - strike);
  // Twice the distance that counts as far: it shrinks with the steps that are left.
  const reach = BigInt((step / 4) * (4 + WALK_STEPS - stepsTaken(event, atMs)));
  const fair = 5_000n + (9_000n * edge) / reach;
  const mid = ((fair < MID_PX_MIN ? MID_PX_MIN : fair > MID_PX_MAX ? MID_PX_MAX : fair) + PX_TICK / 2n) / PX_TICK * PX_TICK;
  const levels = LEVEL_SIZES.slice(0, 2 + (draw(event.seed, -3 - index) % 2));
  return {
    bids: levels.map((units, level): MockLevel => [mid - HALF_SPREAD - BigInt(level) * PX_TICK, units]),
    asks: levels.map((units, level): MockLevel => [mid + HALF_SPREAD + BigInt(level) * PX_TICK, units]),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** A time as the texts of an event give it: the day ("November 14"), the year and the time of day. */
function when(ms: number): { day: string; year: number; time: string } {
  const at = new Date(ms);
  return { day: `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`, year: at.getUTCFullYear(), time: `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC` };
}

/** A price in dollars with all the decimals of its underlying: 6439465 of two decimals is "64394.65". */
function dollars(price: number, decimals: number): string {
  const digits = String(price).padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** A strike as the venue prints it, without trailing zeros: "68000", "0.84", "6.2". */
function strikeText(event: ScheduledEvent, index: number): string {
  return dollars(event.strikes[index] ?? 0, ASSETS[event.series.underlying].decimals).replace(/\.?0+$/, "");
}

/** `MOCK-BTC15M2611142215-UP`, `MOCK-XAU2611150000-HI3800`, `MOCK-XRP2611142300-HI0D84`. */
function symbolOf(event: ScheduledEvent, index: number): string {
  const contract = event.series.shape === "binary" ? "UP" : `HI${strikeText(event, index).replace(".", "D")}`;
  return `${SYMBOL_PREFIX}-${event.ticker}-${contract}`;
}

function indexName(event: ScheduledEvent): string {
  return `SIM-${event.underlying}USD`;
}

/** What the venue says about an event apart from its contracts. */
export function describe(event: ScheduledEvent): MockEvent {
  const asset = ASSETS[event.series.underlying];
  const { day, year, time } = when(event.expiresAt);
  return {
    ticker: event.ticker,
    title: `${asset.category === "Crypto" ? event.underlying : asset.name} price on ${day} at ${time}`,
    category: asset.category,
    subcategory: [...asset.path],
    underlying: event.underlying,
    shape: event.series.shape,
    cadence: event.series.cadence,
    description: `Simulated ${event.underlying} price prediction event expiring on ${day}, ${year} at ${time}`,
    source: { agency: "simulation", index: indexName(event) },
    termsUrl: null,
    listedAt: new Date(event.listedAt),
    expiresAt: new Date(event.expiresAt),
  };
}

/**
 * The `index`th contract of an event as the venue reports it at `nowMs`. An up-or-down contract
 * is active from its listing and learns its strike when its window starts; a ladder contract is
 * approved and post-only until it trades. From expiry a contract is closed and under review, and
 * `settleDelayMs` later it is settled with its side and the event's final value.
 */
export function contractAt(event: ScheduledEvent, index: number, nowMs: number, resolve: MockResolve, settleDelayMs: number): ContractInfo {
  const asset = ASSETS[event.series.underlying];
  const binary = event.series.shape === "binary";
  const started = nowMs >= event.startsAt;
  const expired = nowMs >= event.expiresAt;
  const settled = nowMs >= event.expiresAt + settleDelayMs;
  const { value, sides } = resolutionOf(event, resolve);
  const subject = asset.name === event.underlying ? asset.name : `${asset.name} (${event.underlying})`;
  const { day, year, time } = when(event.expiresAt);
  const [whole = "", fraction] = strikeText(event, index).split(".");
  const label = binary ? "Up" : `$${whole.replace(/\B(?=(\d{3})+$)/g, ",")}${fraction === undefined ? "" : `.${fraction}`} or above`;
  const condition = binary
    ? `on ${day}, ${year} at ${time} is greater than or equal to its price at ${when(event.startsAt).time}`
    : `is ${label} on ${day}, ${year} at ${time}`;
  return {
    symbol: symbolOf(event, index),
    eventTicker: event.ticker,
    status: settled ? "settled" : expired ? "under_review" : binary || started ? "active" : "approved",
    marketState: expired ? "closed" : binary || started ? "open" : "post_only",
    effectiveAt: new Date(event.startsAt),
    expiresAt: new Date(event.expiresAt),
    tickPx: PX_TICK,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: settled ? (sides[index] ?? null) : null,
    label,
    sortOrder: index,
    rules: `If the price of ${subject} ${condition}, this market will resolve to Yes. Otherwise, it will resolve to No. Outcome verified against the simulated ${indexName(event)} index.`,
    strike: !binary ? strikeText(event, index) : started ? dollars(event.openPrice, asset.decimals) : null,
    settlementValue: settled ? dollars(value, asset.decimals) : null,
  };
}

/** The event of the schedule with this ticker and expiry, if the venue ever lists one. */
function scheduled(ticker: string, expiresAt: number, windowSecs: number): ScheduledEvent | undefined {
  let found: ScheduledEvent | undefined;
  for (const series of SERIES) {
    if (expiresAt % spanMs(CADENCES[series.cadence].minutes, windowSecs) !== 0) continue;
    const event = eventOf(series, expiresAt, windowSecs);
    if (event.ticker === ticker && (found === undefined || event.startsAt < found.startsAt)) found = event;
  }
  return found;
}

/** A settled event is forgotten this long after its expiry: the relayer asks about no older one. */
const KEPT_MS = 24 * 60 * 60 * 1_000;

export interface RollingMockVenueOptions {
  /** Length of the 15-minute window in seconds. Every other cadence scales with it. */
  windowSecs: number;
  /** How up-or-down contracts resolve: "random" follows their simulated reference price. */
  resolve: MockResolve;
  /** Unix milliseconds. */
  now(): number;
  /** Time between expiry and resolution. Default 5 s. */
  resolveDelayMs?: number;
  /** Starting cash of the account in micro-dollars. Default one million dollars. */
  cashMicros?: bigint;
  /** For tests: symbols of contracts that stay under review while their siblings settle. */
  stuck?: readonly string[];
  /** For tests: tickers of events that the first list read which would carry them leaves out. */
  missedOnce?: readonly string[];
}

export class RollingMockVenue extends MockVenue {
  private readonly windowSecs: number;
  private readonly resolveMode: MockResolve;
  private readonly clock: () => number;
  private readonly resolveDelayMs: number;
  private readonly stuck: ReadonlySet<string>;
  private readonly missed: Set<string>;
  /** The events with a contract that has not settled yet, by ticker. */
  private readonly open = new Map<string, ScheduledEvent>();
  /** The best bid each contract's resting orders were last placed at; a book is replaced when it moves. */
  private readonly restingBid = new Map<string, bigint | null>();
  /** The events whose contracts all settled, oldest first, until they are forgotten. */
  private readonly settled: ScheduledEvent[] = [];
  /** Contracts of earlier runs that the schedule does not hold, with how each will resolve. */
  private readonly adopted = new Map<string, { expiresAt: number; side: "yes" | "no" }>();

  constructor(options: RollingMockVenueOptions) {
    super({ feeFor: takerFee, now: options.now });
    if (!Number.isInteger(options.windowSecs) || options.windowSecs < MOCK_WINDOW_SECS_MIN) {
      throw new RangeError(`mock window length must be a whole number of seconds, at least ${MOCK_WINDOW_SECS_MIN}`);
    }
    this.windowSecs = options.windowSecs;
    this.resolveMode = options.resolve;
    this.clock = options.now;
    this.resolveDelayMs = options.resolveDelayMs ?? 5_000;
    this.stuck = new Set(options.stuck);
    this.missed = new Set(options.missedOnce);
    this.setCash(options.cashMicros ?? 1_000_000_000_000n);
  }

  /**
   * Takes over a contract an earlier run listed, with the position the account held in it. One
   * of the schedule's own goes back under its event and follows the clock like its siblings. Any
   * other, and any with a `resolution` the relayer already saw, resolves by itself: at once that
   * way, or after its expiry.
   */
  adopt(info: ContractInfo, signedUnits: bigint, resolution?: "yes" | "no"): void {
    const expiresAt = info.expiresAt.getTime();
    const event = scheduled(info.eventTicker, expiresAt, this.windowSecs);
    const own = event?.strikes.some((_, index) => symbolOf(event, index) === info.symbol) === true;
    this.setPosition(info.symbol, signedUnits);
    if (event !== undefined && own) this.addEvent(describe(event));
    if (event !== undefined && own && resolution === undefined) {
      this.open.set(event.ticker, event);
      return;
    }
    this.addContract({ ...info, status: "active", resolutionSide: null });
    if (resolution !== undefined) this.resolve(info.symbol, resolution);
    else this.adopted.set(info.symbol, { expiresAt, side: this.resolveMode === "random" ? (hash(info.symbol) % 2 === 0 ? "yes" : "no") : this.resolveMode });
  }

  /** Brings the venue up to the clock: lists what is due, moves every open contract on, settles what resolved. */
  roll(): void {
    const now = this.clock();
    for (const event of scheduleAt(now, this.windowSecs)) {
      if (this.open.has(event.ticker)) continue;
      this.open.set(event.ticker, event);
      this.addEvent(describe(event));
    }
    for (const event of [...this.open.values()]) this.advance(event, now);
    for (let oldest = this.settled[0]; oldest !== undefined && now - oldest.expiresAt > KEPT_MS; oldest = this.settled[0]) {
      this.settled.shift();
      this.forget(oldest.ticker, oldest.strikes.map((_, index) => symbolOf(oldest, index)));
    }
    for (const [symbol, { expiresAt, side }] of [...this.adopted]) {
      if (now < expiresAt + this.resolveDelayMs) continue;
      this.resolve(symbol, side);
      this.adopted.delete(symbol);
    }
  }

  /** A list read. An event named in `missedOnce` is missing from the first read that would carry it. */
  override async listEvents(): Promise<EventInfo[]> {
    this.roll();
    return (await super.listEvents()).filter((event) => !this.missed.delete(event.ticker));
  }

  override async contract(symbol: string): Promise<ContractInfo | null> {
    this.roll();
    return super.contract(symbol);
  }

  override async placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult> {
    this.roll();
    return super.placeOrder(request);
  }

  override async positions(): Promise<Map<string, bigint>> {
    this.roll();
    return super.positions();
  }

  override async cashMicros(): Promise<bigint> {
    this.roll();
    return super.cashMicros();
  }

  override async settledPayoutMicros(symbol: string): Promise<bigint | null> {
    this.roll();
    return super.settledPayoutMicros(symbol);
  }

  override async topOfBook(symbol: string): Promise<TopOfBook> {
    this.roll();
    return super.topOfBook(symbol);
  }

  override liveTop(symbol: string): { top: TopOfBook; atMs: number } | undefined {
    this.roll();
    return super.liveTop(symbol);
  }

  override async depth(symbol: string, levels: number): Promise<Depth> {
    this.roll();
    return super.depth(symbol, levels);
  }

  /** Moves the contracts of one event to `now`; the event is done with once all of them settled. */
  private advance(event: ScheduledEvent, now: number): void {
    let settled = true;
    event.strikes.forEach((_, index) => {
      let info = contractAt(event, index, now, this.resolveMode, this.resolveDelayMs);
      if (info.status === "settled" && this.stuck.has(info.symbol)) {
        info = { ...info, status: "under_review", resolutionSide: null, settlementValue: null };
      }
      this.addContract(info);
      // The orders rest until the quote moves; what the account took from them stays taken until then.
      const book = quoteAt(event, index, now, this.resolveMode);
      const bid = book.bids[0]?.[0] ?? null;
      if (this.restingBid.get(info.symbol) !== bid) {
        this.restingBid.set(info.symbol, bid);
        this.setBook(info.symbol, book);
      }
      if (info.resolutionSide === null) settled = false;
      else this.resolve(info.symbol, info.resolutionSide);
    });
    if (settled) {
      this.open.delete(event.ticker);
      this.settled.push(event);
      event.strikes.forEach((_, index) => this.restingBid.delete(symbolOf(event, index)));
    }
  }
}
