import { formatPx, formatUnits, parseMicros, parseUnits } from "../../money.ts";
import { FillAggregator } from "../fills.ts";
import type { AggregateState } from "../fills.ts";
import type { VenueFrame } from "../frames.ts";
import type { VenueOrderRequest, VenueOrderResult } from "../types.ts";
import type { ContractInfo, Depth, EventInfo, OrderLookup, PricePoint, TopOfBook, Venue, VenueTrade } from "../venue.ts";
import { MarketFeed } from "./feed.ts";
import { isRecord, listOf, lower, rowsOf, text, toContract, toDepth, toEvent, toHistory, toTrades, upper, wholePx } from "./payloads.ts";
import type { Row } from "./payloads.ts";
import { RestError, SANDBOX_REST_HOST, createRestClient } from "./rest.ts";
import type { FetchLike, RestClient } from "./rest.ts";
import { SANDBOX_WS_URL, openPrivateSocket } from "./socket.ts";
import type { CloseInfo, VenueSocket, WebSocketConstructor } from "./socket.ts";

const STREAMS = ["orders@account", "positions@account", "balances@account"] as const;
/** Wait before each reconnection attempt; the last value repeats. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;
const DEFAULT_FILL_TIMEOUT_MS = 5_000;
/** How far the venue's clock may be behind ours when filtering orders by creation time. */
const CLOCK_SKEW_MS = 60_000;

const EVENTS = "/v1/prediction-markets/events";
const HISTORY = "/v1/prediction-markets/orders/history";
const ACTIVE = "/v1/prediction-markets/orders/active";
const POSITIONS = "/v1/prediction-markets/positions";
const SETTLED_POSITIONS = "/v1/prediction-markets/positions/settled";
const BALANCES = "/v1/balances";

/** Every event that trades or is about to. The venue returns at most 500 events a page. */
const LIST_QUERY = "status=active&status=approved&limit=500";
/** `listEvents` answers from its last read while that read is younger than this: a guard against bursts of calls. */
const LIST_CACHE_MS = 10_000;
/** A list page older than the one held is not taken while the held one is younger than this. */
const LIST_HOLD_MS = 300_000;
/**
 * The venue lists a new five-minute event every five minutes, so a current page always holds an
 * event listed within the last few minutes. Ten minutes leaves room for a late listing; a page
 * without one is behind.
 */
const FRESH_LIST_MS = 600_000;
/** Reads of the list, at most, before the first one is held. */
const FIRST_LIST_READS = 3;
/** A single-event read is shared for this long, so the contracts of one ladder cost one read. */
const EVENT_CACHE_MS = 2_000;
/** The event ticker of a symbol is kept this long after its contract expired: settlement asks for it then. */
const TICKER_KEEP_MS = 7 * 24 * 3_600_000;
/** Rows asked for per page of positions. */
const PAGE_ROWS = 100;
/** Public calls queued or running beyond which display reads are not sent. */
const DISPLAY_QUEUE_LIMIT = 3;
/** The most trades the venue returns in one read. */
const MAX_TRADES = 500;
/** The venue's candle frame for each step in seconds. */
const CANDLE_FRAMES = new Map([
  [60, "1m"],
  [300, "5m"],
  [900, "15m"],
  [1_800, "30m"],
  [3_600, "1hr"],
  [21_600, "6hr"],
  [86_400, "1day"],
]);

export interface GeminiSandboxVenueOptions {
  apiKey: string;
  apiSecret: string;
  /** Only the sandbox hosts are accepted. */
  restHost?: string;
  wsUrl?: string;
  fetch?: FetchLike;
  WebSocketImpl?: WebSocketConstructor;
  /** Epoch milliseconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Receives the text of every frame of the authenticated socket, for recording. */
  onFrame?: (raw: string) => void;
  /** Called when an established authenticated connection is lost. */
  onDisconnect?: (info: CloseInfo) => void;
  /** Receives a line when a listed row is skipped or the market data socket fails. Default: the console. */
  log?: (line: string) => void;
  /** How long to wait for the final order event after the ack. */
  fillTimeoutMs?: number;
}

type FlightEnd = AggregateState | { status: "closed" };

/** One order between `order.place` and its final event. */
interface Flight {
  aggregator: FillAggregator;
  /** The order id of any update seen for this client order id. */
  seenOrderId: string | null;
  /** Settles when the aggregator leaves `pending` or the socket closes. */
  end: Promise<FlightEnd>;
  finish(end: FlightEnd): void;
}

/**
 * The Gemini Predictions sandbox as a `Venue`: orders over the authenticated socket, the live top
 * of book of every active contract over the public socket, everything else over REST. The venue
 * does not deduplicate client order ids, so an order is sent at most once and never retried;
 * when its outcome cannot be established the result is `unknown` and the caller reconciles
 * through `findOrder`.
 *
 * Public reads share one queue of one request a second. The list is read when it is asked for,
 * at most every `LIST_CACHE_MS`; every other public read is made when it is asked for.
 */
export class GeminiSandboxVenue implements Venue {
  readonly #options: GeminiSandboxVenueOptions;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;
  readonly #fillTimeoutMs: number;
  readonly #feed: MarketFeed;
  readonly #flights = new Map<string, Flight>();
  /** The event of every symbol a list has shown, with the expiry of its contract in epoch milliseconds. */
  readonly #eventTickers = new Map<string, { ticker: string; expiresAtMs: number }>();
  /** Single-event reads by ticker. `atMs` is when the read arrived; it is infinite until then. */
  readonly #eventReads = new Map<string, { atMs: number; body: Promise<unknown> }>();

  #socket: VenueSocket | null = null;
  /** Bumped whenever the current socket stops being the current one. */
  #generation = 0;
  #connecting: Promise<void> | null = null;
  #attempts = 0;
  #nextAttemptAtMs = 0;
  /** The last list page taken: when it was read, and the newest listing time among its events. */
  #listing: { events: EventInfo[]; atMs: number; newestMs: number } | null = null;
  #listRead: Promise<EventInfo[]> | null = null;
  /** Why rows of the last list read were left out. */
  #skipped = new Set<string>();

  constructor(options: GeminiSandboxVenueOptions) {
    this.#wsUrl = options.wsUrl ?? SANDBOX_WS_URL;
    if (this.#wsUrl !== SANDBOX_WS_URL) {
      throw new Error(`refusing socket url ${JSON.stringify(this.#wsUrl)}: this build is sandbox only`);
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#log = options.log ?? ((line) => console.warn(line));
    this.#fillTimeoutMs = options.fillTimeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
    this.#rest = createRestClient({
      host: options.restHost ?? SANDBOX_REST_HOST,
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      now: this.#now,
      sleep: this.#sleep,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.#feed = new MarketFeed({
      url: this.#wsUrl,
      now: this.#now,
      log: this.#log,
      ...(options.WebSocketImpl === undefined ? {} : { WebSocketImpl: options.WebSocketImpl }),
    });
  }

  /** True while the authenticated socket is open and all three subscriptions are acked. */
  get connected(): boolean {
    return this.#socket !== null && this.#socket.isOpen;
  }

  /** Opens the authenticated socket and subscribes, now. Concurrent calls share one attempt. */
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    this.#connecting ??= this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  /** Connects if needed, waiting out the reconnection back-off first. One attempt per call. */
  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.#connecting === null) {
      const waitMs = this.#nextAttemptAtMs - this.#now();
      if (waitMs > 0) await this.#sleep(waitMs);
    }
    return this.connect();
  }

  /** Closes both sockets. In-flight orders end as `unknown`, and the market data socket stays closed. */
  close(): void {
    const socket = this.#drop();
    socket?.close();
    this.#feed.close();
  }

  async placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult> {
    if (!this.connected) {
      // Reconnect on this call only when it costs no back-off wait.
      if (this.#connecting !== null || this.#now() >= this.#nextAttemptAtMs) await this.connect().catch(() => {});
    }
    const socket = this.#socket;
    if (socket === null || !socket.isOpen) return rejected("venue disconnected");

    const { clientOrderId } = request;
    if (this.#flights.has(clientOrderId)) {
      return rejected(`an order with client order id ${clientOrderId} is already in flight`);
    }
    let flight: Flight;
    let params: Record<string, string>;
    try {
      flight = newFlight(new FillAggregator({ clientOrderId, requestedUnits: request.units, limitPx: request.limitPx }));
      params = {
        symbol: request.symbol,
        side: "BUY",
        type: "LIMIT",
        timeInForce: request.timeInForce,
        price: formatPx(request.limitPx),
        quantity: formatUnits(request.units),
        eventOutcome: request.outcome,
        clientOrderId,
      };
    } catch (error) {
      return rejected(messageOf(error));
    }

    // Registered before sending: order events can arrive before the ack.
    this.#flights.set(clientOrderId, flight);
    try {
      let ack;
      try {
        ack = await socket.request("order.place", params);
      } catch (error) {
        return unknown(flight.seenOrderId, `no ack: ${messageOf(error)}`);
      }
      if (ack.status !== 200) {
        // A refused order produces no order events. If some arrived, the refusal cannot be trusted.
        if (flight.seenOrderId !== null) {
          return unknown(flight.seenOrderId, `ack status ${ack.status} after order events were received`);
        }
        return { kind: "rejected", code: ack.error?.code ?? null, message: ack.error?.msg ?? `order refused with status ${ack.status}` };
      }

      const end = await withTimeout<FlightEnd>(flight.end, this.#fillTimeoutMs, { status: "pending" });
      const venueOrderId = text(ack.result?.orderId) ?? flight.seenOrderId;
      switch (end.status) {
        case "filled":
          return {
            kind: "filled",
            venueOrderId: end.venueOrderId,
            fills: end.fills,
            filledUnits: end.filledUnits,
            costMicros: end.costMicros,
            feeMicros: end.feeMicros,
          };
        case "not_filled":
          return { kind: "not_filled", venueOrderId: end.venueOrderId, reason: end.reason };
        case "inconsistent":
          return unknown(venueOrderId, `inconsistent order events: ${end.detail}`);
        case "closed":
          return unknown(venueOrderId, "socket closed before the final order event");
        case "pending":
          return unknown(venueOrderId, `no final order event within ${this.#fillTimeoutMs} ms`);
      }
    } finally {
      this.#flights.delete(clientOrderId);
    }
  }

  /** `sinceMs` hides older orders that used the same client order id, with a minute of clock slack. */
  async findOrder(clientOrderId: string, symbol: string, sinceMs: number): Promise<OrderLookup> {
    const history = await this.#signedRead(HISTORY, { symbol, limit: 50 });
    const past = newestMatch(rowsOf(history, "orders"), clientOrderId, sinceMs);
    if (past !== null) {
      // The status alone does not say whether the order filled: a fully filled
      // immediate-or-cancel order reports "cancelled".
      const status = lower(past.status);
      return lookupOf(past, status === "filled" || status === "cancelled" || status === "canceled");
    }
    const active = await this.#signedRead(ACTIVE, {});
    const open = newestMatch(rowsOf(active, "orders"), clientOrderId, sinceMs);
    return open === null ? { found: false } : lookupOf(open, false);
  }

  /** A position that cannot be read is an error: neither its size nor its sign is ever guessed. */
  async positions(): Promise<Map<string, bigint>> {
    const net = new Map<string, bigint>();
    for (const row of await this.#positionRows(POSITIONS, {})) {
      const symbol = upper(row.symbol);
      if (symbol === null) throw new Error("position without a symbol");
      let quantity: bigint;
      try {
        quantity = parseUnits(text(row.totalQuantity) ?? "");
      } catch {
        throw new Error(`position for ${symbol}: unreadable quantity`);
      }
      if (quantity === 0n) continue;
      const outcome = lower(row.outcome);
      if (outcome !== "yes" && outcome !== "no") {
        throw new Error(`position for ${symbol} has an unknown outcome: ${String(row.outcome)}`);
      }
      net.set(symbol, (net.get(symbol) ?? 0n) + (outcome === "yes" ? quantity : -quantity));
    }
    for (const [symbol, units] of net) if (units === 0n) net.delete(symbol);
    return net;
  }

  async cashMicros(): Promise<bigint> {
    const body = await this.#signedRead(BALANCES, {});
    if (!Array.isArray(body)) throw new Error("unexpected balances response: not a list");
    const usd: unknown = body.find((entry) => isRecord(entry) && entry.currency === "USD");
    return isRecord(usd) ? parseMicros(text(usd.available) ?? "") : 0n;
  }

  /**
   * The contract as its own event reads now: the list can be minutes behind, and a result is
   * only ever taken from here.
   */
  async contract(symbol: string): Promise<ContractInfo | null> {
    const wanted = symbol.toUpperCase();
    const eventTicker = this.#eventTickerOf(wanted);
    if (eventTicker === null) return null;
    const event = await this.#event(eventTicker);
    const rows: unknown[] = isRecord(event) && Array.isArray(event.contracts) ? event.contracts : [];
    const row = rows.find((candidate) => isRecord(candidate) && upper(candidate.instrumentSymbol) === wanted);
    return row === undefined ? null : toContract(row, eventTicker);
  }

  async listEvents(): Promise<EventInfo[]> {
    if (this.#listing !== null && this.#now() - this.#listing.atMs < LIST_CACHE_MS) return this.#listing.events;
    this.#listRead ??= this.#readEvents().finally(() => {
      this.#listRead = null;
    });
    return this.#listRead;
  }

  /**
   * The payout of the account's settled position in the contract, summed over its rows. No row
   * means the account was flat at resolution, or the row is not published yet. A payout that
   * cannot be read is an error, never "nothing paid".
   */
  async settledPayoutMicros(symbol: string): Promise<bigint | null> {
    const wanted = symbol.toUpperCase();
    const eventTicker = this.#eventTickerOf(wanted);
    if (eventTicker === null) throw new Error(`no event ticker for ${symbol}`);
    const rows = await this.#positionRows(SETTLED_POSITIONS, { eventTicker });
    const matching = rows.filter((candidate) => upper(candidate.instrumentSymbol) === wanted);
    if (matching.length === 0) return null;
    try {
      return matching.reduce((sum, row) => sum + parseMicros(text(row.payout) ?? ""), 0n);
    } catch {
      throw new Error(`settled position for ${symbol}: unreadable payout`);
    }
  }

  async topOfBook(symbol: string): Promise<TopOfBook> {
    const { bids, asks } = await this.#book(symbol, 1);
    const [bid, ask] = [bids[0], asks[0]];
    // A new contract's book route can answer an empty book for minutes while the stream shows quotes.
    const live = bid === undefined && ask === undefined ? this.#feed.top(symbol) : undefined;
    if (live !== undefined) return live.top;
    return { bidPx: bid?.px ?? null, bidUnits: bid?.units ?? 0n, askPx: ask?.px ?? null, askUnits: ask?.units ?? 0n };
  }

  /** Served while the public socket is connected and the contract is active; see `MarketFeed`. */
  liveTop(symbol: string): { top: TopOfBook; atMs: number } | undefined {
    return this.#feed.top(symbol);
  }

  async depth(symbol: string, levels: number): Promise<Depth> {
    // The venue reads a limit of zero as "every level".
    atLeastOne("levels", levels);
    if (this.#publicBusy()) return { bids: [], asks: [] };
    return nothingWhenUnknown(this.#book(symbol, levels), { bids: [], asks: [] });
  }

  async trades(symbol: string, limit: number): Promise<VenueTrade[]> {
    atLeastOne("limit", limit);
    if (this.#publicBusy()) return [];
    const tape = this.#get(`/v1/trades/${encodeURIComponent(symbol)}?limit_trades=${Math.min(limit, MAX_TRADES)}`).then(toTrades);
    return (await nothingWhenUnknown(tape, [])).slice(0, limit);
  }

  /** Candles are built from trades: a contract that never traded has none (HTTP 400 `NoDataFound`). */
  async history(symbol: string, stepSecs: number): Promise<PricePoint[]> {
    const frame = CANDLE_FRAMES.get(stepSecs);
    if (frame === undefined) throw new RangeError(`the venue has no candles of ${stepSecs} seconds`);
    if (this.#publicBusy()) return [];
    return nothingWhenUnknown(this.#get(`/v2/candles/${encodeURIComponent(symbol)}/${frame}`).then(toHistory), []);
  }

  /**
   * Up to `levels` levels a side of the book, read now. For its first minutes as an instrument an
   * active contract is unknown to the book route on about half the calls, while the socket has
   * its book from the first second: then the socket is asked instead, and when it cannot answer
   * the read fails, for the caller to try again. An unknown symbol is never read as an empty book.
   */
  async #book(symbol: string, levels: number): Promise<Depth> {
    try {
      return toDepth(await this.#get(`/v1/book/${encodeURIComponent(symbol)}?limit_bids=${levels}&limit_asks=${levels}`), levels);
    } catch (error) {
      if (!isUnknownSymbol(error) || !this.#feed.follows(symbol)) throw error;
      return this.#feed.depth(symbol, levels);
    }
  }

  /**
   * Reads the list. A row that cannot be read is left out, and its reason is logged when it first
   * shows up.
   *
   * The venue answers from caches that disagree: a read can return a page that is older than the
   * one before it, by minutes while the list is asked for steadily and by an hour after a pause.
   * Events are listed all the time and stay listed until they expire, so a page whose newest
   * event is older than the newest one already seen is such a page. It is dropped and the list
   * held is answered again, for at most `LIST_HOLD_MS`, in case the newest event was simply
   * taken off the list.
   *
   * Until a list is held there is nothing to compare a page with, so a page without an event
   * listed in the last `FRESH_LIST_MS` is not taken yet: the list is read again, at most
   * `FIRST_LIST_READS` reads in all, and the page with the newest event is kept.
   */
  async #readEvents(): Promise<EventInfo[]> {
    let read = await this.#readList();
    for (let reads = 1; this.#listing === null && reads < FIRST_LIST_READS && read.newestMs < this.#now() - FRESH_LIST_MS; reads += 1) {
      const next = await this.#readList();
      if (next.newestMs >= read.newestMs) read = next;
    }
    const { events, skipped, newestMs } = read;

    const now = this.#now();
    const held = this.#listing;
    if (held !== null && newestMs < held.newestMs && now - held.atMs < LIST_HOLD_MS) return held.events;

    for (const reason of skipped) if (!this.#skipped.has(reason)) this.#log(`venue list: skipped ${reason}`);
    this.#skipped = skipped;
    for (const { ticker, contracts } of events) {
      for (const { symbol, expiresAt } of contracts) this.#eventTickers.set(symbol, { ticker, expiresAtMs: expiresAt.getTime() });
    }
    for (const [symbol, { expiresAtMs }] of this.#eventTickers) {
      if (expiresAtMs + TICKER_KEEP_MS <= now) this.#eventTickers.delete(symbol);
    }
    this.#feed.follow(events.flatMap((event) => event.contracts));
    this.#listing = { events, atMs: now, newestMs };
    return events;
  }

  /**
   * One read of the whole list, page by page, with the listing time of its newest event. Two
   * pages read a second apart can overlap, so every event and every contract is taken once.
   */
  async #readList(): Promise<{ events: EventInfo[]; skipped: Set<string>; newestMs: number }> {
    const events: EventInfo[] = [];
    const tickers = new Set<string>();
    const symbols = new Set<string>();
    const skipped = new Set<string>();
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const body = await this.#get(`${EVENTS}?${LIST_QUERY}&offset=${offset}`);
      const rows = listOf(body, "data");
      if (rows.length === 0) break;
      offset += rows.length;
      const pagination: unknown = isRecord(body) ? body.pagination : undefined;
      total = isRecord(pagination) && typeof pagination.total === "number" ? pagination.total : offset;
      for (const row of rows) {
        let event: EventInfo;
        try {
          event = toEvent(row, (reason) => skipped.add(reason));
        } catch (error) {
          skipped.add(messageOf(error));
          continue;
        }
        if (tickers.has(event.ticker)) continue;
        tickers.add(event.ticker);
        const contracts = event.contracts.filter((contract) => !symbols.has(contract.symbol));
        for (const contract of contracts) symbols.add(contract.symbol);
        if (contracts.length > 0) events.push({ ...event, contracts });
      }
    }
    return { events, skipped, newestMs: Math.max(...events.map((event) => event.listedAt.getTime())) };
  }

  /**
   * The event of a symbol: the one the list gave, else `GEMI-<EVENT>-<CONTRACT>` split at its last
   * dash (event tickers can hold dashes, contract tickers do not).
   */
  #eventTickerOf(symbol: string): string | null {
    return this.#eventTickers.get(symbol)?.ticker ?? /^GEMI-(.+)-[^-]+$/.exec(symbol)?.[1] ?? null;
  }

  /** One event, or null when the venue does not know the ticker. */
  #event(ticker: string): Promise<unknown> {
    const now = this.#now();
    for (const [key, read] of this.#eventReads) if (now - read.atMs >= EVENT_CACHE_MS) this.#eventReads.delete(key);
    const shared = this.#eventReads.get(ticker);
    if (shared !== undefined) return shared.body;

    const body = this.#get(`${EVENTS}/${encodeURIComponent(ticker)}`).catch((error: unknown) => {
      if (error instanceof RestError && error.status === 404) return null;
      throw error;
    });
    const read = { atMs: Number.POSITIVE_INFINITY, body };
    this.#eventReads.set(ticker, read);
    body.then(
      () => {
        read.atMs = this.#now();
      },
      () => {
        if (this.#eventReads.get(ticker) === read) this.#eventReads.delete(ticker);
      },
    );
    return body;
  }

  /**
   * Every row of a list of positions, page by page. The last page is the one that reaches the
   * venue's `total`; a list filtered by event comes without a total, and there it is the first
   * page that is not full.
   */
  async #positionRows(path: string, query: Record<string, string>): Promise<Row[]> {
    const rows: Row[] = [];
    let offset = 0;
    let more = true;
    while (more) {
      const body = await this.#signedRead(path, {}, { ...query, limit: String(PAGE_ROWS), offset: String(offset) });
      const page = listOf(body, "positions");
      rows.push(...page.filter(isRecord));
      offset += page.length;
      const total = isRecord(body) && typeof body.total === "number" ? body.total : null;
      more = page.length > 0 && (total === null ? page.length >= PAGE_ROWS : offset < total);
    }
    return rows;
  }

  async #open(): Promise<void> {
    const generation = ++this.#generation;
    const { apiKey, apiSecret, WebSocketImpl, onFrame } = this.#options;
    let socket: VenueSocket | undefined;
    try {
      socket = await openPrivateSocket({
        url: this.#wsUrl,
        apiKey,
        apiSecret,
        now: this.#now,
        // The upgrade uses a nonce second of the key, like a signed REST call.
        beforeConnect: () => this.#rest.reserveSlot(),
        onFrame: (raw) => onFrame?.(raw),
        onMessage: (frame) => this.#onMessage(frame),
        onClose: (info) => this.#onSocketClose(generation, info),
        ...(WebSocketImpl === undefined ? {} : { WebSocketImpl }),
      });
      for (const stream of STREAMS) {
        const ack = await socket.request("SUBSCRIBE", [stream]);
        if (ack.status !== 200) throw new Error(`subscription to ${stream} was refused with status ${ack.status}`);
      }
      if (generation !== this.#generation || !socket.isOpen) throw new Error("socket closed while subscribing");
      this.#socket = socket;
      this.#attempts = 0;
    } catch (error) {
      if (generation === this.#generation) this.#generation++;
      socket?.close();
      this.#backOff();
      throw error;
    }
  }

  #onMessage(frame: VenueFrame): void {
    if (frame.kind !== "orderUpdate" || frame.clientOrderId === null) return;
    const flight = this.#flights.get(frame.clientOrderId);
    if (flight === undefined) return;
    flight.seenOrderId ??= frame.orderId;
    flight.aggregator.accept(frame);
    const state = flight.aggregator.state();
    if (state.status !== "pending") flight.finish(state);
  }

  #onSocketClose(generation: number, info: CloseInfo): void {
    if (generation !== this.#generation) return;
    const wasConnected = this.#socket !== null;
    this.#drop();
    if (!wasConnected) return; // closed while connecting: #open reports it and backs off
    this.#attempts = 0;
    this.#backOff();
    this.#options.onDisconnect?.(info);
  }

  /** Forgets the current socket and ends every in-flight order. */
  #drop(): VenueSocket | null {
    const socket = this.#socket;
    this.#generation++;
    this.#socket = null;
    for (const flight of this.#flights.values()) flight.finish({ status: "closed" });
    return socket;
  }

  #backOff(): void {
    const delayMs = BACKOFF_MS[Math.min(this.#attempts, BACKOFF_MS.length - 1)] ?? 10_000;
    this.#nextAttemptAtMs = this.#now() + delayMs;
    this.#attempts++;
  }

  /**
   * Display reads share the public queue with order and settlement reads, which must not wait
   * behind them: while the queue is backed up, display reads answer empty without a call.
   */
  #publicBusy(): boolean {
    return this.#rest.publicPending() > DISPLAY_QUEUE_LIMIT;
  }

  #get(path: string): Promise<unknown> {
    return retryOnce(() => this.#rest.publicGet(path));
  }

  /** A signed POST that only reads. The retry waits its turn in the signed queue like any call. */
  #signedRead(path: string, params: Record<string, unknown>, query?: Record<string, string>): Promise<unknown> {
    return retryOnce(() => this.#rest.signed("POST", path, params, query));
  }
}

function newFlight(aggregator: FillAggregator): Flight {
  let finish: (end: FlightEnd) => void = () => {};
  const end = new Promise<FlightEnd>((resolve) => {
    finish = resolve;
  });
  return { aggregator, seenOrderId: null, end, finish };
}

function rejected(message: string): VenueOrderResult {
  return { kind: "rejected", code: null, message };
}

function unknown(venueOrderId: string | null, reason: string): VenueOrderResult {
  return { kind: "unknown", venueOrderId, reason };
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/** Retries once after a transport failure, a timeout or a server error; client errors are final. */
async function retryOnce<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RestError && error.status < 500) throw error;
    return call();
  }
}

/**
 * The answer of a market data read, or `nothing` when the venue has none to give: its market
 * data routes do not know the symbol (a listed contract is not an instrument before it is
 * active, and stays unknown to them on and off for minutes after), or no candle holds a trade.
 */
async function nothingWhenUnknown<T>(read: Promise<T>, nothing: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (isUnknownSymbol(error) || (error instanceof RestError && isRecord(error.body) && error.body.reason === "NoDataFound")) return nothing;
    throw error;
  }
}

/** HTTP 400 "... is not a valid symbol", which the candles route sends as plain text. */
function isUnknownSymbol(error: unknown): boolean {
  if (!(error instanceof RestError) || error.status !== 400) return false;
  const message: unknown = isRecord(error.body) ? error.body.message : error.body;
  return typeof message === "string" && message.includes("is not a valid symbol");
}

function atLeastOne(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number of at least 1: ${value}`);
}

/** The newest row for the client order id that was not created well before `sinceMs`. */
function newestMatch(rows: Row[], clientOrderId: string, sinceMs: number): Row | null {
  let best: Row | null = null;
  let bestCreatedMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.clientOrderId !== clientOrderId) continue;
    const parsedMs = Date.parse(String(row.createdAt));
    const createdMs = Number.isFinite(parsedMs) ? parsedMs : 0;
    if (Number.isFinite(parsedMs) && parsedMs < sinceMs - CLOCK_SKEW_MS) continue;
    if (best === null || createdMs > bestCreatedMs) {
      best = row;
      bestCreatedMs = createdMs;
    }
  }
  return best;
}

function lookupOf(row: Row, closed: boolean): OrderLookup {
  const venueOrderId = text(row.orderId);
  if (venueOrderId === null) throw new Error("order row without an order id");
  const filled = text(row.filledQuantity);
  return {
    found: true,
    venueOrderId,
    closed,
    filledUnits: filled === null ? 0n : parseUnits(filled),
    avgPx: wholePx(row.avgExecutionPrice),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
