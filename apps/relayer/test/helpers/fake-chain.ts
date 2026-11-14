import type { Chain, ChainOrder } from "../../src/chain/chain.ts";

export type ChainMethod = "fillBuy" | "fillSell" | "cancel";

export interface ChainFill {
  address: string;
  kind: "buy" | "sell";
  fillUnits: bigint;
  /** Cost of a buy, proceeds of a sell. */
  amountMicros: bigint;
  feeMicros: bigint;
  signature: string;
}

/**
 * In-memory stand-in for the program: open order accounts, a settable clock, call counts and
 * injectable failures. Like the program, a fill or a cancel closes the order account, a fill is
 * refused after the order's deadline, and a cancel is always possible while the account exists.
 */
export class FakeChain implements Chain {
  /** Cluster time in unix seconds; tests move it directly. */
  nowSecs: number;
  /** Fills that landed, in order. */
  readonly fills: ChainFill[] = [];
  /** Addresses of the cancels that landed, in order. */
  readonly cancels: string[] = [];
  /** Every attempt, including the failed ones. */
  readonly calls: Record<ChainMethod, number> = { fillBuy: 0, fillSell: 0, cancel: 0 };

  private readonly orders = new Map<string, ChainOrder>();
  private readonly failures: Record<ChainMethod, number> = { fillBuy: 0, fillSell: 0, cancel: 0 };
  private nextSignature = 1;

  constructor(nowSecs: number) {
    this.nowSecs = nowSecs;
  }

  addOrder(order: ChainOrder): void {
    this.orders.set(order.address, order);
  }

  /** Closes the order account behind the relayer's back, as a user cancel after expiry would. */
  removeOrder(address: string): void {
    this.orders.delete(address);
  }

  /** The next `times` calls of `method` reject without landing. Default: every later call. */
  fail(method: ChainMethod, times: number = Number.POSITIVE_INFINITY): void {
    this.failures[method] = times;
  }

  /** Units minted (buys) or burned (sells) for the order. */
  filledUnits(address: string): bigint {
    return this.fills.filter((fill) => fill.address === address).reduce((sum, fill) => sum + fill.fillUnits, 0n);
  }

  async now(): Promise<number> {
    return this.nowSecs;
  }

  async openOrders(): Promise<ChainOrder[]> {
    return [...this.orders.values()];
  }

  async orderExists(address: string): Promise<boolean> {
    return this.orders.has(address);
  }

  async fillBuy(order: ChainOrder, args: { fillUnits: bigint; costMicros: bigint; feeMicros: bigint }): Promise<string> {
    return this.fill("fillBuy", order, args.fillUnits, args.costMicros, args.feeMicros);
  }

  async fillSell(order: ChainOrder, args: { fillUnits: bigint; proceedsMicros: bigint; feeMicros: bigint }): Promise<string> {
    return this.fill("fillSell", order, args.fillUnits, args.proceedsMicros, args.feeMicros);
  }

  async cancel(order: ChainOrder): Promise<string> {
    this.enter("cancel", order);
    this.orders.delete(order.address);
    this.cancels.push(order.address);
    return this.signature();
  }

  private fill(method: "fillBuy" | "fillSell", order: ChainOrder, fillUnits: bigint, amountMicros: bigint, feeMicros: bigint): string {
    this.enter(method, order);
    const kind = method === "fillBuy" ? "buy" : "sell";
    if (order.kind !== kind) throw new Error(`${method} on a ${order.kind} order`);
    if (this.nowSecs > order.expiresAt) throw new Error(`order ${order.address} expired`);
    const signature = this.signature();
    this.orders.delete(order.address);
    this.fills.push({ address: order.address, kind, fillUnits, amountMicros, feeMicros, signature });
    return signature;
  }

  /** Counts the call, then applies an injected failure and the account check. */
  private enter(method: ChainMethod, order: ChainOrder): void {
    this.calls[method] += 1;
    if (this.failures[method] > 0) {
      this.failures[method] -= 1;
      throw new Error(`injected failure: ${method}`);
    }
    if (!this.orders.has(order.address)) throw new Error(`order account ${order.address} not found`);
  }

  private signature(): string {
    return `sig-${this.nextSignature++}`;
  }
}
