// Deterministic in-memory venue for tests and offline demos. One book per contract, quoted in YES
// prices; orders are BUYs of either outcome that execute immediately or not at all.

import { PAYOUT_PER_UNIT, PX_MAX, PX_MIN } from "../money.ts";
import type { VenueFill, VenueOrderRequest, VenueOrderResult } from "./types.ts";
import type { ContractInfo, OrderLookup, TopOfBook, Venue } from "./venue.ts";

/** A price level: `[px, units]`, px in YES space. */
export type BookLevel = [px: bigint, units: bigint];
export interface MockBook {
  /** Best (highest) first. */
  bids: BookLevel[];
  /** Best (lowest) first. */
  asks: BookLevel[];
}

export type FaultMode = "unknown_after_fill" | "unknown_no_fill" | "throw";

export interface MockVenueOptions {
  /** Fee of one fill in micro-dollars, `px` in the order's own space. Default: zero. */
  feeFor?: (units: bigint, px: bigint) => bigint;
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
  private readonly contracts = new Map<string, ContractInfo>();
  private readonly books = new Map<string, MockBook>();
  private readonly positions = new Map<string, bigint>();
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
  }

  addContract(info: ContractInfo): void {
    this.contracts.set(info.symbol, { ...info });
  }

  setBook(symbol: string, book: MockBook): void {
    this.books.set(symbol, {
      bids: book.bids.map(([px, units]): BookLevel => [px, units]),
      asks: book.asks.map(([px, units]): BookLevel => [px, units]),
    });
  }

  setCash(micros: bigint): void {
    this.cash = micros;
  }

  /** Sets the net position directly (YES positive), as if earlier orders had built it. */
  setPosition(symbol: string, signedUnits: bigint): void {
    if (signedUnits === 0n) this.positions.delete(symbol);
    else this.positions.set(symbol, signedUnits);
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
    const position = this.positions.get(symbol) ?? 0n;
    const winningUnits = side === "yes" ? position : -position;
    const payout = winningUnits > 0n ? winningUnits * PAYOUT_PER_UNIT : 0n;
    this.cash += payout;
    if (position !== 0n) this.settledPayouts.set(symbol, payout);
    this.positions.delete(symbol);
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

  async netPosition(symbol: string): Promise<bigint> {
    return this.positions.get(symbol) ?? 0n;
  }

  async cashMicros(): Promise<bigint> {
    return this.cash;
  }

  async contract(symbol: string): Promise<ContractInfo | null> {
    const contract = this.contracts.get(symbol);
    return contract === undefined ? null : this.quoted(contract);
  }

  async listContracts(): Promise<ContractInfo[]> {
    return [...this.contracts.values()].filter((contract) => contract.status === "active").map((contract) => this.quoted(contract));
  }

  async settledPayoutMicros(symbol: string): Promise<bigint | null> {
    return this.settledPayouts.get(symbol) ?? null;
  }

  async topOfBook(symbol: string): Promise<TopOfBook> {
    const bid = this.books.get(symbol)?.bids[0];
    const ask = this.books.get(symbol)?.asks[0];
    return { bidPx: bid?.[0] ?? null, bidUnits: bid?.[1] ?? 0n, askPx: ask?.[0] ?? null, askUnits: ask?.[1] ?? 0n };
  }

  /** A copy of the contract with the best bid and ask of its book. */
  private quoted(contract: ContractInfo): ContractInfo {
    const book = this.books.get(contract.symbol);
    return { ...contract, bestBidPx: book?.bids[0]?.[0] ?? null, bestAskPx: book?.asks[0]?.[0] ?? null };
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
    const book = this.books.get(symbol) ?? { bids: [], asks: [] };
    const levels = outcome === "YES" ? book.asks : book.bids;
    const planned: Array<{ level: BookLevel; units: bigint; px: bigint }> = [];
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
    const position = this.positions.get(symbol) ?? 0n;
    const opposite = outcome === "YES" ? -position : position;
    const offset = opposite <= 0n ? 0n : opposite < filledUnits ? opposite : filledUnits;
    const cashAfter = this.cash - costMicros - feeMicros + offset * PAYOUT_PER_UNIT;
    if (cashAfter < 0n) return rejected("insufficient funds");

    const fills: VenueFill[] = planned.map((fill, i) => {
      fill.level[1] -= fill.units;
      return { tradeId: (this.nextTradeId++).toString(), units: fill.units, px: fill.px, feeMicros: fees[i]!, feeSource: "reported" };
    });
    const emptied = levels.filter((level) => level[1] > 0n);
    levels.length = 0;
    levels.push(...emptied);
    this.cash = cashAfter;
    this.positions.set(symbol, outcome === "YES" ? position + filledUnits : position - filledUnits);
    this.orders.set(request.clientOrderId, { venueOrderId, symbol, filledUnits, costMicros });
    return { kind: "filled", venueOrderId, fills, filledUnits, costMicros, feeMicros };
  }
}

function rejected(message: string): VenueOrderResult {
  return { kind: "rejected", code: null, message };
}
