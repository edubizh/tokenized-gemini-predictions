// Deterministic in-memory venue for tests and offline demos. One book per contract, quoted in YES
// prices; orders are BUYs of either outcome that execute immediately or not at all.

import { PAYOUT_PER_UNIT, PX_MAX, PX_MIN } from "../money.ts";
import type { VenueFill, VenueOrderRequest, VenueOrderResult } from "./types.ts";
import type { ContractInfo, Depth, EventInfo, OrderLookup, PricePoint, TopOfBook, Venue, VenueTrade } from "./venue.ts";

/** A price level: `[px, units]`, px in YES space. */
export type MockLevel = [px: bigint, units: bigint];
export interface MockBook {
  /** Best (highest) first. */
  bids: MockLevel[];
  /** Best (lowest) first. */
  asks: MockLevel[];
}

/** What the mock is told about an event; its contracts, status and volume come from its own state. */
export type MockEvent = Omit<EventInfo, "contracts" | "status" | "volumeUnits">;

export type FaultMode = "unknown_after_fill" | "unknown_no_fill" | "throw";

export interface MockVenueOptions {
  /** Fee of one fill in micro-dollars, `px` in the order's own space. Default: zero. */
  feeFor?: (units: bigint, px: bigint) => bigint;
  /** Unix milliseconds: the time of every trade and book change. Default `Date.now`. */
  now?: () => number;
}

interface RecordedOrder {
  venueOrderId: string;
  symbol: string;
  filledUnits: bigint;
  costMicros: bigint;
}

export class MockVenue implements Venue {
  /** Every request passed to `placeOrder`, in order, including rejected and faulted ones. */
  readonly requests: VenueOrderRequest[] = [];

  private readonly feeFor: (units: bigint, px: bigint) => bigint;
  private readonly now: () => number;
  private readonly events = new Map<string, MockEvent>();
  private readonly contracts = new Map<string, ContractInfo>();
  /** Each book with the time it last changed. */
  private readonly books = new Map<string, { book: MockBook; atMs: number }>();
  /** Signed units held per contract, YES positive; never zero. */
  private readonly held = new Map<string, bigint>();
  /** The fills of each contract as trades in YES price space, oldest first. */
  private readonly tapes = new Map<string, VenueTrade[]>();
  /** What `resolve` paid for each position that was not flat. */
  private readonly settledPayouts = new Map<string, bigint>();
  /** Orders the venue accepted, by client order id. */
  private readonly orders = new Map<string, RecordedOrder>();
  private readonly faults: FaultMode[] = [];
  /** Client order ids `findOrder` reports as not closed yet. */
  private readonly heldOpen = new Set<string>();
  private cash = 0n;
  private nextOrderId = 73_000_000_000_000_000n;
  private nextTradeId = 5_000_000_000_000_000n;

  constructor(options: MockVenueOptions = {}) {
    this.feeFor = options.feeFor ?? (() => 0n);
    this.now = options.now ?? Date.now;
  }

  /** Describes an event. Its contracts are added with `addContract`. */
  addEvent(event: MockEvent): void {
    this.events.set(event.ticker, { ...event });
  }

  /** Adds or replaces a contract. One whose event was never described gets a plain event of its own. */
  addContract(info: ContractInfo): void {
    this.contracts.set(info.symbol, { ...info });
    if (this.events.has(info.eventTicker)) return;
    this.addEvent({
      ticker: info.eventTicker,
      title: info.eventTicker,
      category: "Other",
      subcategory: [],
      underlying: info.eventTicker,
      shape: "binary",
      cadence: "other",
      description: "",
      source: null,
      termsUrl: null,
      listedAt: info.effectiveAt,
      expiresAt: info.expiresAt,
    });
  }

  /** Forgets an event, its contracts and their books. What the account did in them stays: orders, trades, payouts. */
  protected forget(ticker: string, symbols: string[]): void {
    this.events.delete(ticker);
    for (const symbol of symbols) {
      this.contracts.delete(symbol);
      this.books.delete(symbol);
    }
  }

  setBook(symbol: string, book: MockBook): void {
    this.books.set(symbol, {
      book: {
        bids: book.bids.map(([px, units]): MockLevel => [px, units]),
        asks: book.asks.map(([px, units]): MockLevel => [px, units]),
      },
      atMs: this.now(),
    });
  }

  setCash(micros: bigint): void {
    this.cash = micros;
  }

  /** Sets the net position directly (YES positive), as if earlier orders had built it. */
  setPosition(symbol: string, signedUnits: bigint): void {
    if (signedUnits === 0n) this.held.delete(symbol);
    else this.held.set(symbol, signedUnits);
  }

  /** Makes the next `placeOrder` misbehave. Faults queue up and each applies to one order. */
  failNext(mode: FaultMode): void {
    this.faults.push(mode);
  }

  /**
   * Makes `findOrder` report the order with this client id as found but not closed, as a venue
   * does while an order is still working. `holdOpen(id, false)` closes it again.
   */
  holdOpen(clientOrderId: string, open = true): void {
    if (open) this.heldOpen.add(clientOrderId);
    else this.heldOpen.delete(clientOrderId);
  }

  /** Settles the contract: a winning net position is paid out, any position is cleared. */
  resolve(symbol: string, side: "yes" | "no"): void {
    const contract = this.contracts.get(symbol);
    if (contract === undefined) throw new Error(`unknown contract: ${symbol}`);
    this.contracts.set(symbol, { ...contract, status: "settled", marketState: "closed", resolutionSide: side });
    const position = this.held.get(symbol) ?? 0n;
    const winningUnits = side === "yes" ? position : -position;
    const payout = winningUnits > 0n ? winningUnits * PAYOUT_PER_UNIT : 0n;
    this.cash += payout;
    if (position !== 0n) this.settledPayouts.set(symbol, payout);
    this.held.delete(symbol);
  }

  async placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult> {
    this.requests.push({ ...request });
    const fault = this.faults.shift();
    if (fault === "throw") throw new Error("injected fault: throw");
    if (fault === "unknown_no_fill") {
      return { kind: "unknown", venueOrderId: null, reason: "injected fault: unknown_no_fill" };
    }
    const result = this.execute(request);
    if (fault === "unknown_after_fill") {
      return { kind: "unknown", venueOrderId: null, reason: "injected fault: unknown_after_fill" };
    }
    return result;
  }

  /** `sinceMs` is ignored: the mock keeps every order it ever accepted. */
  async findOrder(clientOrderId: string, symbol: string, _sinceMs: number): Promise<OrderLookup> {
    const order = this.orders.get(clientOrderId);
    if (order === undefined || order.symbol !== symbol) return { found: false };
    const exact = order.filledUnits > 0n && order.costMicros % order.filledUnits === 0n;
    return {
      found: true,
      venueOrderId: order.venueOrderId,
      closed: !this.heldOpen.has(clientOrderId),
      filledUnits: order.filledUnits,
      avgPx: exact ? order.costMicros / order.filledUnits : null,
    };
  }

  async positions(): Promise<Map<string, bigint>> {
    return new Map(this.held);
  }

  async cashMicros(): Promise<bigint> {
    return this.cash;
  }

  async contract(symbol: string): Promise<ContractInfo | null> {
    const contract = this.contracts.get(symbol);
    return contract === undefined ? null : this.quoted(contract);
  }

  /** Every event with a contract that is approved or active, with all of its contracts. */
  async listEvents(): Promise<EventInfo[]> {
    const byEvent = new Map<string, ContractInfo[]>();
    for (const contract of this.contracts.values()) {
      const siblings = byEvent.get(contract.eventTicker);
      if (siblings === undefined) byEvent.set(contract.eventTicker, [contract]);
      else siblings.push(contract);
    }
    const listed: EventInfo[] = [];
    for (const [ticker, contracts] of byEvent) {
      const event = this.events.get(ticker);
      const active = contracts.some((contract) => contract.status === "active");
      if (event === undefined || (!active && !contracts.some((contract) => contract.status === "approved"))) continue;
      listed.push({
        ...event,
        status: active ? "active" : "approved",
        volumeUnits: contracts.reduce((sum, contract) => sum + this.tape(contract.symbol).reduce((units, trade) => units + trade.units, 0n), 0n),
        contracts: contracts.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((contract) => this.quoted(contract)),
      });
    }
    return listed;
  }

  async settledPayoutMicros(symbol: string): Promise<bigint | null> {
    return this.settledPayouts.get(symbol) ?? null;
  }

  async topOfBook(symbol: string): Promise<TopOfBook> {
    return topOf(this.books.get(symbol)?.book);
  }

  /** The top of the book and when the book last changed; undefined for a symbol without a book. */
  liveTop(symbol: string): { top: TopOfBook; atMs: number } | undefined {
    const entry = this.books.get(symbol);
    return entry === undefined ? undefined : { top: topOf(entry.book), atMs: entry.atMs };
  }

  async depth(symbol: string, levels: number): Promise<Depth> {
    const book = this.books.get(symbol)?.book;
    const side = (rows: MockLevel[] | undefined) => (rows ?? []).slice(0, levels).map(([px, units]) => ({ px, units }));
    return { bids: side(book?.bids), asks: side(book?.asks) };
  }

  async trades(symbol: string, limit: number): Promise<VenueTrade[]> {
    const tape = this.tape(symbol);
    return tape.slice(Math.max(0, tape.length - limit)).reverse().map((trade) => ({ ...trade }));
  }

  /**
   * From the step of the first trade to the current one, or to the contract's last one once it has
   * expired; a step without a trade repeats the price before it.
   */
  async history(symbol: string, stepSecs: number): Promise<PricePoint[]> {
    const tape = this.tape(symbol);
    const first = tape[0];
    if (first === undefined) return [];
    const stepMs = stepSecs * 1_000;
    const expiresAt = this.contracts.get(symbol)?.expiresAt.getTime() ?? Number.POSITIVE_INFINITY;
    const points: PricePoint[] = [];
    let px = first.px;
    let next = 0;
    for (let atMs = Math.floor(first.atMs / stepMs) * stepMs; atMs <= this.now() && atMs < expiresAt; atMs += stepMs) {
      while (next < tape.length && tape[next]!.atMs < atMs + stepMs) px = tape[next++]!.px;
      points.push({ atMs, px });
    }
    return points;
  }

  private tape(symbol: string): VenueTrade[] {
    return this.tapes.get(symbol) ?? [];
  }

  /** A copy of the contract with the best bid and ask of its book and the price of its last trade. */
  private quoted(contract: ContractInfo): ContractInfo {
    const top = topOf(this.books.get(contract.symbol)?.book);
    return { ...contract, bestBidPx: top.bidPx, bestAskPx: top.askPx, lastPx: this.tape(contract.symbol).at(-1)?.px ?? null };
  }

  private execute(request: VenueOrderRequest): VenueOrderResult {
    const { symbol, outcome, units, limitPx } = request;
    const contract = this.contracts.get(symbol);
    if (contract === undefined) return rejected(`unknown contract: ${symbol}`);
    if (contract.status !== "active" || contract.marketState !== "open") {
      return rejected(`contract not tradable: ${contract.status}/${contract.marketState}`);
    }
    if (limitPx < PX_MIN || limitPx > PX_MAX || limitPx % contract.tickPx !== 0n) {
      return rejected(`invalid price: ${limitPx}`);
    }
    if (units <= 0n || units < contract.minUnits || units % contract.unitIncrement !== 0n) {
      return rejected(`invalid quantity: ${units}`);
    }
    if (this.orders.has(request.clientOrderId)) return rejected(`duplicate client order id: ${request.clientOrderId}`);

    // Plan the fills against the side this order takes from, without touching the book yet.
    const entry = this.books.get(symbol);
    const levels = (outcome === "YES" ? entry?.book.asks : entry?.book.bids) ?? [];
    const planned: Array<{ level: MockLevel; units: bigint; px: bigint }> = [];
    let remaining = units;
    for (const level of levels) {
      if (remaining === 0n) break;
      const px = outcome === "YES" ? level[0] : PAYOUT_PER_UNIT - level[0];
      if (px > limitPx) break;
      const take = level[1] < remaining ? level[1] : remaining;
      if (take > 0n) planned.push({ level, units: take, px });
      remaining -= take;
    }
    const filledUnits = units - remaining;
    const venueOrderId = (this.nextOrderId++).toString();
    if (filledUnits === 0n || (request.timeInForce === "FOK" && remaining > 0n)) {
      this.orders.set(request.clientOrderId, { venueOrderId, symbol, filledUnits: 0n, costMicros: 0n });
      return { kind: "not_filled", venueOrderId, reason: `${request.timeInForce} order found no fill within its limit` };
    }

    const costMicros = planned.reduce((sum, fill) => sum + fill.units * fill.px, 0n);
    const fees = planned.map((fill) => this.feeFor(fill.units, fill.px));
    const feeMicros = fees.reduce((sum, fee) => sum + fee, 0n);
    // Every unit that offsets an existing opposite position closes a pair and releases its payout.
    const position = this.held.get(symbol) ?? 0n;
    const opposite = outcome === "YES" ? -position : position;
    const offset = opposite <= 0n ? 0n : opposite < filledUnits ? opposite : filledUnits;
    const cashAfter = this.cash - costMicros - feeMicros + offset * PAYOUT_PER_UNIT;
    if (cashAfter < 0n) return rejected("insufficient funds");

    const atMs = this.now();
    const tape = this.tape(symbol);
    this.tapes.set(symbol, tape);
    const fills: VenueFill[] = planned.map((fill, i) => {
      const tradeId = (this.nextTradeId++).toString();
      // Buying NO takes a YES bid: in YES terms the taker sold at the level's price.
      tape.push({ id: tradeId, atMs, px: fill.level[0], units: fill.units, taker: outcome === "YES" ? "buy" : "sell" });
      fill.level[1] -= fill.units;
      return { tradeId, units: fill.units, px: fill.px, feeMicros: fees[i]!, feeSource: "reported" };
    });
    const emptied = levels.filter((level) => level[1] > 0n);
    levels.length = 0;
    levels.push(...emptied);
    if (entry !== undefined) entry.atMs = atMs;
    this.cash = cashAfter;
    this.setPosition(symbol, outcome === "YES" ? position + filledUnits : position - filledUnits);
    this.orders.set(request.clientOrderId, { venueOrderId, symbol, filledUnits, costMicros });
    return { kind: "filled", venueOrderId, fills, filledUnits, costMicros, feeMicros };
  }
}

function topOf(book: MockBook | undefined): TopOfBook {
  const bid = book?.bids[0];
  const ask = book?.asks[0];
  return { bidPx: bid?.[0] ?? null, bidUnits: bid?.[1] ?? 0n, askPx: ask?.[0] ?? null, askUnits: ask?.[1] ?? 0n };
}

function rejected(message: string): VenueOrderResult {
  return { kind: "rejected", code: null, message };
}
