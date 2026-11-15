// Stand-ins shared by the sandbox adapter tests. Everything is synthetic: invented ids, symbols
// and urls, in the shape of the frames and REST rows the sandbox sends (ids as bare JSON
// integers, decimals as strings).
import { EventEmitter } from "node:events";
import { vi } from "vitest";

export const START_MS = 1_794_624_000_250; // 2026-11-14T02:40:00.250Z
export const EVENT = "DEMO15M2611140300";
export const SYMBOL = "GEMI-DEMO15M2611140300-UP";
export const LADDER = "DEMO2611140400";
export const TERMS_URL = "https://assets.example.org/terms/demo.pdf";

export type Row = Record<string, unknown>;

export interface Sent {
  id: string;
  method: string;
  params: unknown;
}

/**
 * Stands in for the `ws` client. Opens by itself and acks SUBSCRIBE and UNSUBSCRIBE as the venue
 * does; a test plays the rest. The authenticated socket is the one opened with upgrade headers.
 */
export class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static refuseUpgrade = false;
  static subscribeStatus = 200;
  /** Streams the venue does not know: it refuses a whole SUBSCRIBE that names one of them. */
  static unknownStreams = new Set<string>();
  /** The frame the venue sends for a stream as soon as it is subscribed, ahead of the ack. */
  static snapshots = new Map<string, string>();
  /** Answers any other request: the fields of the ack, or undefined for no answer. */
  static answer: (message: Sent) => Row | undefined = () => undefined;
  /** While set, no request is answered at all. */
  static silent = false;

  readonly createdAt = Date.now();
  readonly headers: Record<string, string>;
  readyState = 0;
  sent: Sent[] = [];
  terminated = false;

  constructor(_url: string, options: { headers: Record<string, string> }) {
    super();
    this.headers = options.headers;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.refuseUpgrade) this.emit("unexpected-response", {}, { statusCode: 503 });
      else {
        this.readyState = 1;
        this.emit("open");
      }
    });
  }

  static reset(): void {
    FakeWebSocket.instances = [];
    FakeWebSocket.refuseUpgrade = false;
    FakeWebSocket.subscribeStatus = 200;
    FakeWebSocket.unknownStreams = new Set();
    FakeWebSocket.snapshots = new Map();
    FakeWebSocket.answer = () => undefined;
    FakeWebSocket.silent = false;
  }

  /** The sockets opened without credentials, oldest first. */
  static publicSockets(): FakeWebSocket[] {
    return FakeWebSocket.instances.filter((socket) => Object.keys(socket.headers).length === 0);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    const message = JSON.parse(data) as Sent;
    this.sent.push(message);
    const ack = FakeWebSocket.silent ? undefined : this.#ackFor(message);
    if (ack === undefined) return;
    queueMicrotask(() => {
      if (message.method === "SUBSCRIBE" && ack.status === 200) {
        for (const stream of message.params as string[]) {
          const snapshot = FakeWebSocket.snapshots.get(stream);
          if (snapshot !== undefined) this.serverFrame(snapshot);
        }
      }
      this.serverFrame(JSON.stringify({ id: message.id, ...ack }));
    });
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  close(): void {
    this.serverClose(1005);
  }

  /** Text frames reach `ws` listeners as a Buffer. */
  serverFrame(raw: string): void {
    this.emit("message", Buffer.from(raw), false);
  }

  serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }

  placed(): Sent[] {
    return this.sent.filter((message) => message.method === "order.place");
  }

  /** The stream names of every request of one method, in the order sent. */
  streams(method: "SUBSCRIBE" | "UNSUBSCRIBE"): string[][] {
    return this.sent.filter((message) => message.method === method).map((message) => message.params as string[]);
  }

  #ackFor(message: Sent): Row | undefined {
    if (message.method === "UNSUBSCRIBE") return { status: 200 };
    if (message.method !== "SUBSCRIBE") return FakeWebSocket.answer(message);
    const unknown = (message.params as string[]).find((stream) => FakeWebSocket.unknownStreams.has(stream));
    if (unknown !== undefined) return { status: 400, error: { code: -1013, msg: `Invalid stream name: ${unknown}` } };
    return { status: FakeWebSocket.subscribeStatus };
  }
}

export interface HttpCall {
  method: string;
  path: string;
  query: string;
  /** The decoded signed payload, or null for a public call. */
  payload: Record<string, unknown> | null;
  at: number;
}

export function httpFake() {
  const calls: HttpCall[] = [];
  let handler: (call: HttpCall, index: number) => unknown = () => ({});
  return {
    calls,
    /** The handler returns a JSON body, a ready Response, or an Error to throw. */
    respond(next: (call: HttpCall, index: number) => unknown) {
      handler = next;
    },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const parsed = new URL(url);
      const headers = init.headers as Record<string, string> | undefined;
      const call: HttpCall = {
        method: String(init.method),
        path: parsed.pathname,
        query: parsed.search,
        payload: headers ? (JSON.parse(Buffer.from(headers["X-GEMINI-PAYLOAD"]!, "base64").toString()) as Record<string, unknown>) : null,
        at: Date.now(),
      };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      if (result instanceof Error) throw result;
      return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 });
    },
  };
}

/** Advances the fake clock, then returns the promise's outcome. */
export async function drive<T>(promise: Promise<T>, ms = 0): Promise<T> {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const settled = await outcome;
  if (settled.ok) return settled.value;
  throw settled.error;
}

/** A rule as the venue sends it: one text node under a document, with a Markdown link inside. */
export function richText(value: string): Row {
  return { nodeType: "document", data: {}, content: [{ nodeType: "text", value, marks: [], data: {} }] };
}

/** An up-or-down contract row before its window: no quote, no reference price yet. */
export function contractRow(fields: Row = {}): Row {
  return {
    id: "900001-700001",
    label: "Up",
    description: richText(`If the price of Demo is at or above the reference price, this market resolves to Yes. View the [full rules](${TERMS_URL}).`),
    prices: { buy: {}, sell: {} },
    status: "active",
    createdAt: "2026-11-14T02:38:30.000Z",
    termsAndConditionsUrl: TERMS_URL,
    ticker: "UP",
    instrumentSymbol: SYMBOL,
    marketState: "open",
    abbreviatedName: "Up",
    color: "#4CAF50",
    expiryDate: "2026-11-14T03:00:00.000Z",
    effectiveDate: "2026-11-14T02:45:00.000Z",
    sortOrder: 0,
    strike: { type: "reference", availableAt: "2026-11-14T02:45:00.000Z" },
    isCombo: false,
    quantityIncrement: "0.01",
    quantityMinimum: "0.01",
    priceIncrement: "0.01",
    quoteAssetPrecision: 2,
    priceMinimum: "0.01",
    ...fields,
  };
}

/** A 15-minute up-or-down event with its one contract. */
export function eventRow(fields: Row = {}): Row {
  return {
    id: "900001",
    title: "Demo price today at 10pm EST",
    slug: "demo-price-today-at-10pm-est",
    type: "binary",
    category: "Crypto",
    ticker: EVENT,
    status: "active",
    createdAt: "2026-11-14T02:38:30.000Z",
    contracts: [contractRow()],
    effectiveDate: "2026-11-14T02:38:30.000Z",
    isLive: true,
    participants: [],
    description: "Interval DEMO price prediction event expiring on November 13, 2026 at 10pm ET",
    series: "DEMO15M",
    volume: "0",
    volume24h: "0",
    tags: ["Demo"],
    expiryDate: "2026-11-14T03:00:00.000Z",
    startTime: "2026-11-14T02:45:00.000Z",
    termsLink: TERMS_URL,
    subcategory: { id: 901, slug: "crypto_demo", name: "Demo", path: ["Crypto", "Demo"] },
    template: "crypto-up-down",
    eventTags: [
      { id: 2, name: "Fifteen Minute", slug: "fifteen-minute" },
      { id: 9, name: "Up Down", slug: "up-down" },
    ],
    source: "DEMO-INDEX-USD",
    sourceDetails: { agency: "demo-agency", index: "DEMO-INDEX-USD" },
    volumeDelta24hPct: "0",
    ...fields,
  };
}

/** One "$X or above" contract of a ladder. `strike` is in dollars, for example "68000" or "0.84". */
export function strikeRow(strike: string, sortOrder: number, fields: Row = {}): Row {
  const code = strike.replace(".", "D");
  return contractRow({
    id: `900002-70001${sortOrder}`,
    label: `$${strike} or above`,
    ticker: `HI${code}`,
    instrumentSymbol: `GEMI-${LADDER}-HI${code}`,
    abbreviatedName: `>$${strike}`,
    expiryDate: "2026-11-14T04:00:00.000Z",
    effectiveDate: "2026-11-14T03:00:00.000Z",
    sortOrder,
    strike: { type: "above", value: strike },
    ...fields,
  });
}

/** An hourly ladder event with the given contracts. */
export function ladderRow(contracts: unknown[], fields: Row = {}): Row {
  return eventRow({
    id: "900002",
    title: "Demo price today at 11pm EST",
    slug: "demo-price-today-at-11pm-est",
    type: "categorical",
    ticker: LADDER,
    contracts,
    series: "DEMO1H",
    expiryDate: "2026-11-14T04:00:00.000Z",
    startTime: "2026-11-14T03:00:00.000Z",
    template: "prices-ladder",
    eventTags: [
      { id: 3, name: "Hourly", slug: "hourly" },
      { id: 8, name: "Reference", slug: "reference" },
    ],
    ...fields,
  });
}
