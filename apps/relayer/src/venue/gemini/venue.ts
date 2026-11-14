import { formatPx, formatUnits, parseDecimal, parseMicros, parsePx, parseUnits } from "../../money.ts";
import { FillAggregator } from "../fills.ts";
import type { AggregateState } from "../fills.ts";
import type { VenueFrame } from "../frames.ts";
import type { VenueOrderRequest, VenueOrderResult } from "../types.ts";
import type { ContractInfo, OrderLookup, TopOfBook, Venue } from "../venue.ts";
import { RestError, SANDBOX_REST_HOST, createRestClient } from "./rest.ts";
import type { FetchLike, RestClient } from "./rest.ts";
import { SANDBOX_WS_URL, openPrivateSocket } from "./socket.ts";
import type { CloseInfo, PrivateSocket, WebSocketConstructor } from "./socket.ts";

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
const BALANCES = "/v1/balances";

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
  /** Receives the text of every socket frame, for recording. */
  onFrame?: (raw: string) => void;
  /** Called when an established connection is lost. */
  onDisconnect?: (info: CloseInfo) => void;
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

type Row = Record<string, unknown>;

/**
 * The Gemini Predictions sandbox as a `Venue`: orders over the private socket, everything else
 * over REST. The venue does not deduplicate client order ids, so an order is sent at most once
 * and never retried; when its outcome cannot be established the result is `unknown` and the
 * caller reconciles through `findOrder`.
 */
export class GeminiSandboxVenue implements Venue {
  readonly #options: GeminiSandboxVenueOptions;
  readonly #rest: RestClient;
  readonly #wsUrl: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fillTimeoutMs: number;
  readonly #flights = new Map<string, Flight>();
  readonly #eventTickers = new Map<string, string>();

  #socket: PrivateSocket | null = null;
  /** Bumped whenever the current socket stops being the current one. */
  #generation = 0;
  #connecting: Promise<void> | null = null;
  #attempts = 0;
  #nextAttemptAtMs = 0;

  constructor(options: GeminiSandboxVenueOptions) {
    this.#wsUrl = options.wsUrl ?? SANDBOX_WS_URL;
    if (this.#wsUrl !== SANDBOX_WS_URL) {
      throw new Error(`refusing socket url ${JSON.stringify(this.#wsUrl)}: this build is sandbox only`);
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#fillTimeoutMs = options.fillTimeoutMs ?? DEFAULT_FILL_TIMEOUT_MS;
    this.#rest = createRestClient({
      host: options.restHost ?? SANDBOX_REST_HOST,
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      now: this.#now,
      sleep: this.#sleep,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** True while the socket is open and all three subscriptions are acked. */
  get connected(): boolean {
    return this.#socket !== null && this.#socket.isOpen;
  }

  /** Opens the socket and subscribes, now. Concurrent calls share one attempt. */
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

  /** Closes the socket. In-flight orders end as `unknown`. */
  close(): void {
    const socket = this.#drop();
    socket?.close();
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

  async netPosition(symbol: string): Promise<bigint> {
    const body = await this.#signedRead(POSITIONS, {}, { limit: "100" });
    const wanted = symbol.toUpperCase();
    const row = rowsOf(body, "positions").find((candidate) => upper(candidate.symbol) === wanted);
    if (row === undefined) return 0n;
    const quantity = parseUnits(text(row.totalQuantity) ?? "");
    if (quantity === 0n) return 0n;
    switch (lower(row.outcome)) {
      case "yes":
        return quantity;
      case "no":
        return -quantity;
      default:
        throw new Error(`position for ${symbol} has an unknown outcome: ${String(row.outcome)}`);
    }
  }

  async cashMicros(): Promise<bigint> {
    const body = await this.#signedRead(BALANCES, {});
    if (!Array.isArray(body)) throw new Error("unexpected balances response: not a list");
    const usd: unknown = body.find((entry) => isRecord(entry) && entry.currency === "USD");
    return isRecord(usd) ? parseMicros(text(usd.available) ?? "") : 0n;
  }

  async contract(symbol: string): Promise<ContractInfo | null> {
    const wanted = symbol.toUpperCase();
    const eventTicker = this.#eventTickers.get(wanted) ?? eventTickerOf(wanted);
    if (eventTicker === null) return null;
    let body: unknown;
    try {
      body = await this.#get(`${EVENTS}/${encodeURIComponent(eventTicker)}`);
    } catch (error) {
      if (error instanceof RestError && error.status === 404) return null;
      throw error;
    }
    const contracts: unknown[] = isRecord(body) && Array.isArray(body.contracts) ? body.contracts : [];
    const row = contracts.filter(isRecord).find((candidate) => upper(candidate.instrumentSymbol) === wanted);
    return row === undefined ? null : toContractInfo(wanted, eventTicker, row);
  }

  /**
   * Active crypto contracts. Also records each symbol's event ticker, which `contract` then uses
   * instead of deriving it from the symbol. Contracts that cannot be read are left out.
   */
  async listContracts(): Promise<ContractInfo[]> {
    const body = await this.#get(`${EVENTS}?status=active&category=crypto&limit=500`);
    const contracts: ContractInfo[] = [];
    for (const event of rowsOf(body, "data")) {
      if (typeof event.ticker !== "string" || !Array.isArray(event.contracts)) continue;
      for (const row of event.contracts.filter(isRecord)) {
        const symbol = upper(row.instrumentSymbol);
        if (symbol === null) continue;
        this.#eventTickers.set(symbol, event.ticker);
        try {
          contracts.push(toContractInfo(symbol, event.ticker, row));
        } catch {
          // Not describable, so not offered.
        }
      }
    }
    return contracts;
  }

  async topOfBook(symbol: string): Promise<TopOfBook> {
    const body = await this.#get(`/v1/book/${encodeURIComponent(symbol)}?limit_bids=1&limit_asks=1`);
    if (!isRecord(body)) throw new Error(`unexpected book response for ${symbol}`);
    const bid = bestLevel(body.bids);
    const ask = bestLevel(body.asks);
    return { bidPx: bid.px, bidUnits: bid.units, askPx: ask.px, askUnits: ask.units };
  }

  async #open(): Promise<void> {
    const generation = ++this.#generation;
    const { apiKey, apiSecret, WebSocketImpl, onFrame } = this.#options;
    let socket: PrivateSocket | undefined;
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
  #drop(): PrivateSocket | null {
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

/** A price as px, or null when it is absent or not exactly a whole px. */
function wholePx(value: unknown): bigint | null {
  try {
    return parsePx(text(value) ?? "");
  } catch {
    return null;
  }
}

function bestLevel(side: unknown): { px: bigint | null; units: bigint } {
  const level: unknown = Array.isArray(side) ? side[0] : undefined;
  if (!isRecord(level)) return { px: null, units: 0n };
  return { px: parsePx(text(level.price) ?? ""), units: parseUnits(text(level.amount) ?? "") };
}

/** `GEMI-<EVENT>-<CONTRACT>` -> `<EVENT>`. */
function eventTickerOf(symbol: string): string | null {
  const match = /^GEMI-(.+)-[^-]+$/.exec(symbol);
  return match?.[1] ?? null;
}

/**
 * States and the resolution side are read leniently (unknown values pass through or become
 * null) and an unreadable date becomes an invalid Date. The price and quantity grid is not
 * guessed: an unreadable increment throws.
 */
function toContractInfo(symbol: string, eventTicker: string, row: Row): ContractInfo {
  const grid = (field: string, decimals: number): bigint => {
    try {
      return parseDecimal(text(row[field]) ?? "", decimals);
    } catch {
      throw new Error(`contract ${symbol}: unreadable ${field}`);
    }
  };
  const side = lower(row.resolutionSide);
  return {
    symbol,
    eventTicker,
    status: typeof row.status === "string" ? row.status : "unknown",
    marketState: typeof row.marketState === "string" ? row.marketState : "unknown",
    effectiveAt: new Date(String(row.effectiveDate)),
    expiresAt: new Date(String(row.expiryDate)),
    tickPx: grid("priceIncrement", 4),
    unitIncrement: grid("quantityIncrement", 2),
    minUnits: grid("quantityMinimum", 2),
    resolutionSide: side === "yes" || side === "no" ? side : null,
  };
}

/** The records of the list at `body[key]`. A body without that list is an error, not "no rows". */
function rowsOf(body: unknown, key: string): Row[] {
  const list: unknown = isRecord(body) ? body[key] : undefined;
  if (!Array.isArray(list)) throw new Error(`unexpected response: no "${key}" list`);
  return list.filter(isRecord);
}

/** A string, or a number that survived JSON parsing exactly, as text. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function lower(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function upper(value: unknown): string | null {
  return typeof value === "string" ? value.toUpperCase() : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
