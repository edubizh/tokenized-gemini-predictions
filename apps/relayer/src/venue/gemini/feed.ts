// Live top of book of every active contract, from the venue's public socket.
//
// A contract is followed from the first list read that shows it active until it closes: its
// expiry passes, the status stream reports it, or a list read shows it under review or settled.
// Missing from a list read does not end it, because a list page can be minutes old.
//
// The socket is opened by a list read and never reconnects by itself: after a loss every entry
// is gone, and the next list read connects and subscribes again.

import { parsePx, parseUnits } from "../../money.ts";
import type { VenueFrame } from "../frames.ts";
import type { ContractInfo, Depth, TopOfBook } from "../venue.ts";
import { isRecord, text, toDepth } from "./payloads.ts";
import { openPublicSocket } from "./socket.ts";
import type { CloseInfo, VenueSocket, WebSocketConstructor } from "./socket.ts";

const STATUS_STREAM = "contractStatus";
/** Streams per SUBSCRIBE or UNSUBSCRIBE request. */
const BATCH = 80;
/** A book asked of the socket answers in tens of milliseconds, or not at all. */
const DEPTH_TIMEOUT_MS = 3_000;

export interface MarketFeedOptions {
  /** Only the sandbox url is accepted. */
  url: string;
  WebSocketImpl?: WebSocketConstructor;
  /** Epoch milliseconds. */
  now: () => number;
  log: (line: string) => void;
}

export class MarketFeed {
  readonly #options: MarketFeedOptions;
  /** Followed contracts and their expiry in epoch milliseconds. */
  readonly #following = new Map<string, number>();
  /** Contracts whose stream is subscribed on the current connection. */
  readonly #subscribed = new Set<string>();
  /** Followed contracts whose stream the venue refused on the current connection. */
  readonly #refused = new Set<string>();
  readonly #tops = new Map<string, TopOfBook>();
  #socket: VenueSocket | null = null;
  #syncing = false;
  /** A list read arrived while the previous one was still being applied. */
  #behind = false;
  #closed = false;

  constructor(options: MarketFeedOptions) {
    this.#options = options;
  }

  /** Takes the contracts of a list read, then connects and subscribes as needed, in the background. */
  follow(contracts: Iterable<Pick<ContractInfo, "symbol" | "status" | "expiresAt">>): void {
    if (this.#closed) return;
    const now = this.#options.now();
    for (const [symbol, expiresAtMs] of this.#following) if (expiresAtMs <= now) this.#unfollow(symbol);
    for (const { symbol, status, expiresAt } of contracts) {
      if (status === "active") {
        if (expiresAt.getTime() > now) this.#following.set(symbol, expiresAt.getTime());
      } else if (status !== "approved") {
        this.#unfollow(symbol);
      }
    }
    this.#apply();
  }

  /** Whether the contract is active as far as the lists and the status stream have shown. */
  follows(symbol: string): boolean {
    return this.#options.now() < (this.#following.get(symbol) ?? 0);
  }

  /**
   * The top of book of a followed contract. The stream reports every change, so an entry is the
   * book as it is now, not a past reading: `atMs` is the time of the call.
   */
  top(symbol: string): { top: TopOfBook; atMs: number } | undefined {
    const top = this.#tops.get(symbol);
    return top !== undefined && this.follows(symbol) ? { top, atMs: this.#options.now() } : undefined;
  }

  /** The book of one contract, asked of the socket now. Rejects when the socket cannot answer. */
  async depth(symbol: string, levels: number): Promise<Depth> {
    const socket = this.#socket;
    if (socket === null || !socket.isOpen) throw new Error(`no market data connection to read the book of ${symbol}`);
    const ack = await socket.request("depth", { symbol, limit: levels }, DEPTH_TIMEOUT_MS);
    if (ack.status !== 200) throw new Error(`the book of ${symbol} was refused with status ${ack.status}`);
    return toDepth(ack.result, levels);
  }

  close(): void {
    this.#closed = true;
    this.#socket?.close();
  }

  /** Runs one sync at a time; a list read that arrives meanwhile is applied right after. */
  #apply(): void {
    if (this.#syncing) {
      this.#behind = true;
      return;
    }
    this.#syncing = true;
    void this.#sync()
      .catch((error: unknown) => {
        if (!this.#closed) this.#options.log(`market data socket: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#syncing = false;
        if (!this.#behind) return;
        this.#behind = false;
        this.#apply();
      });
  }

  /** Brings the subscriptions of the connection in line with the followed contracts. */
  async #sync(): Promise<void> {
    if (this.#closed || (this.#socket === null && this.#following.size === 0)) return;
    const socket = this.#socket ?? (await this.#connect());

    const ended = [...this.#subscribed].filter((symbol) => !this.#following.has(symbol));
    for (const batch of batches(ended)) {
      await socket.request("UNSUBSCRIBE", batch.map(streamOf));
      for (const symbol of batch) this.#subscribed.delete(symbol);
    }
    const missing = [...this.#following.keys()].filter((symbol) => !this.#subscribed.has(symbol) && !this.#refused.has(symbol));
    for (const batch of batches(missing)) {
      if (await this.#subscribe(socket, batch)) continue;
      // One unknown stream is enough for the venue to refuse a whole request.
      for (const symbol of batch) {
        if (batch.length > 1 && (await this.#subscribe(socket, [symbol]))) continue;
        this.#refused.add(symbol);
        this.#options.log(`market data socket: no book ticker for ${symbol}`);
      }
    }
  }

  /** False when the venue refuses the request as invalid (status 400). Any other refusal is an error. */
  async #subscribe(socket: VenueSocket, symbols: string[]): Promise<boolean> {
    const ack = await socket.request("SUBSCRIBE", symbols.map(streamOf));
    if (ack.status === 400) return false;
    if (ack.status !== 200) throw new Error(`subscription was refused with status ${ack.status}`);
    for (const symbol of symbols) this.#subscribed.add(symbol);
    return true;
  }

  async #connect(): Promise<VenueSocket> {
    const { url, WebSocketImpl } = this.#options;
    const socket = await openPublicSocket({
      url,
      onMessage: (frame) => this.#onMessage(frame),
      onClose: (info) => this.#onClose(info),
      ...(WebSocketImpl === undefined ? {} : { WebSocketImpl }),
    });
    try {
      const ack = await socket.request("SUBSCRIBE", [STATUS_STREAM]);
      if (ack.status !== 200) throw new Error(`subscription to ${STATUS_STREAM} was refused with status ${ack.status}`);
      if (this.#closed) throw new Error("closed while connecting");
    } catch (error) {
      socket.close();
      throw error;
    }
    this.#socket = socket;
    return socket;
  }

  #onMessage(frame: VenueFrame): void {
    if (frame.kind === "contractStatus") {
      // Every status but "Active" is before or after trading, and a followed contract was active.
      if (frame.to !== "Active") this.#unfollow(frame.symbol);
      return;
    }
    // A book ticker frame carries no event name: `{ s, b, B, a, A }`, with "" for an empty side.
    if (frame.kind !== "unknown" || !isRecord(frame.value)) return;
    const { s, b, B, a, A } = frame.value;
    if (typeof s !== "string" || typeof b !== "string" || typeof a !== "string") return;
    const symbol = s.toUpperCase();
    if (!this.#following.has(symbol)) return;
    try {
      const [bid, ask] = [sideOf(b, B), sideOf(a, A)];
      this.#tops.set(symbol, { bidPx: bid.px, bidUnits: bid.units, askPx: ask.px, askUnits: ask.units });
    } catch {
      // The book changed and the change cannot be read: no top is better than the old one.
      this.#tops.delete(symbol);
    }
  }

  /** A closed connection takes every entry with it: none of them is kept up to date any more. */
  #onClose(info: CloseInfo): void {
    const wasConnected = this.#socket !== null;
    this.#socket = null;
    this.#subscribed.clear();
    this.#refused.clear();
    this.#tops.clear();
    if (wasConnected && !this.#closed) this.#options.log(`market data socket closed: ${info.reason}`);
  }

  #unfollow(symbol: string): void {
    this.#following.delete(symbol);
    this.#refused.delete(symbol);
    this.#tops.delete(symbol);
  }
}

function streamOf(symbol: string): string {
  return `${symbol}@bookTicker`;
}

function sideOf(price: string, size: unknown): { px: bigint | null; units: bigint } {
  return price === "" ? { px: null, units: 0n } : { px: parsePx(price), units: parseUnits(text(size) ?? "") };
}

function batches<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += BATCH) out.push(items.slice(start, start + BATCH));
  return out;
}
