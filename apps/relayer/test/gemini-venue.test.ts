import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSandboxVenue } from "../src/venue/gemini/venue.ts";
import type { GeminiSandboxVenueOptions } from "../src/venue/gemini/venue.ts";
import type { VenueOrderRequest } from "../src/venue/types.ts";

// Everything here is synthetic: invented ids and an invented symbol, in the shape of the frames
// and REST rows the sandbox sends (ids as bare JSON integers, decimals as strings).
const START_MS = 1_794_624_000_250; // 2026-11-14T02:40:00.250Z
const SYMBOL = "GEMI-DEMO15M2611140300-UP";
const EVENT = "DEMO15M2611140300";
const CLIENT_ID = "o-0123456789abcdef0123456789abcdef";
const ORDER_ID = "700000000000000001";
const TRADE_ID = "5000000000000001";

const REQUEST: VenueOrderRequest = {
  clientOrderId: CLIENT_ID,
  symbol: SYMBOL,
  outcome: "YES",
  units: 100n,
  limitPx: 1_700n,
  timeInForce: "FOK",
};

interface Sent {
  id: string;
  method: string;
  params: unknown;
}

/** Stands in for the `ws` client. Opens by itself and acks SUBSCRIBE; a test plays the rest. */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static refuseUpgrade = false;
  static subscribeStatus = 200;
  readonly createdAt = Date.now();
  readyState = 0;
  sent: Sent[] = [];
  terminated = false;

  constructor(_url: string, _options: { headers: Record<string, string> }) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.refuseUpgrade) this.emit("unexpected-response", {}, { statusCode: 503 });
      else {
        this.readyState = 1;
        this.emit("open");
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    const message = JSON.parse(data) as Sent;
    this.sent.push(message);
    if (message.method === "SUBSCRIBE") {
      queueMicrotask(() => this.serverFrame(JSON.stringify({ id: message.id, status: FakeWebSocket.subscribeStatus })));
    }
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
}

interface HttpCall {
  method: string;
  path: string;
  query: string;
  /** The decoded signed payload, or null for a public call. */
  payload: Record<string, unknown> | null;
  at: number;
}

function httpFake() {
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
async function drive<T>(promise: Promise<T>, ms = 0): Promise<T> {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const settled = await outcome;
  if (settled.ok) return settled.value;
  throw settled.error;
}

async function connected(extra: Partial<GeminiSandboxVenueOptions> = {}) {
  const http = httpFake();
  const venue = new GeminiSandboxVenue({
    apiKey: "account-TESTKEY",
    apiSecret: "test-secret",
    WebSocketImpl: FakeWebSocket,
    fetch: http.fetch,
    ...extra,
  });
  await drive(venue.connect());
  return { venue, http, ws: FakeWebSocket.instances.at(-1)! };
}

/** An order update as raw text, with the order and trade ids written as bare integers. */
function update(status: string, fields: Record<string, string | boolean> = {}): string {
  const frame = {
    e: "orderUpdate",
    E: "1794624005000000000",
    s: SYMBOL,
    i: ORDER_ID,
    h: "hA5h0000001a",
    c: CLIENT_ID,
    S: "BUY",
    o: "LIMIT",
    X: status,
    p: "0.1700",
    q: "1.00",
    z: "0.00",
    T: "1794624005000000000",
    O: "YES",
    ...fields,
  };
  return JSON.stringify(frame).replace(/"(i|t)":"(\d+)"/g, '"$1":$2');
}

const FILL = { Z: "1.00", L: "0.1700", a: "0.1700", t: TRADE_ID, n: "0.0000", m: false };
const REFUSAL = { z: "1.00", Z: "0.00", a: "0.0000", r: "FillOrKillWouldNotFill" };

function acceptAck(id: string): string {
  return `{"id":"${id}","status":200,"result":{"symbol":"${SYMBOL}","orderId":${ORDER_ID},"transactTime":"1794624005000000000","price":"0.1700","status":"NEW","type":"LIMIT","side":"BUY"}}`;
}

/** Starts an order and returns it with the `order.place` message the venue sent. */
async function place(venue: GeminiSandboxVenue, ws: FakeWebSocket, request: VenueOrderRequest = REQUEST) {
  const pending = venue.placeOrder(request);
  await vi.advanceTimersByTimeAsync(0);
  return { pending, sent: ws.placed().at(-1)! };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.refuseUpgrade = false;
  FakeWebSocket.subscribeStatus = 200;
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connect", () => {
  it("subscribes to the three account streams in three separate requests", async () => {
    const { venue, ws } = await connected();
    expect(ws.sent).toEqual([
      { id: "1", method: "SUBSCRIBE", params: ["orders@account"] },
      { id: "2", method: "SUBSCRIBE", params: ["positions@account"] },
      { id: "3", method: "SUBSCRIBE", params: ["balances@account"] },
    ]);
    expect(venue.connected).toBe(true);
  });

  it("fails and stays disconnected when a subscription is not acked with 200", async () => {
    FakeWebSocket.subscribeStatus = 400;
    const venue = new GeminiSandboxVenue({ apiKey: "k", apiSecret: "s", WebSocketImpl: FakeWebSocket, fetch: httpFake().fetch });
    await expect(drive(venue.connect())).rejects.toThrow("subscription to orders@account was refused with status 400");

    expect(venue.connected).toBe(false);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.readyState).toBe(3);
    await expect(venue.placeOrder(REQUEST)).resolves.toEqual({ kind: "rejected", code: null, message: "venue disconnected" });
    expect(ws.placed()).toEqual([]);
  });

  it("queues the socket upgrade with signed REST calls: the next signed call waits a nonce second", async () => {
    const { venue, http } = await connected();
    http.respond(() => [{ currency: "USD", available: "5.00" }]);
    await drive(venue.cashMicros(), 1_100);
    expect(http.calls[0]!.at - START_MS).toBe(1_100);
  });

  it("refuses hosts other than the sandbox", () => {
    const options = { apiKey: "k", apiSecret: "s", WebSocketImpl: FakeWebSocket, fetch: httpFake().fetch };
    expect(() => new GeminiSandboxVenue({ ...options, restHost: "https://api.gemini.com" })).toThrow("sandbox only");
    expect(() => new GeminiSandboxVenue({ ...options, wsUrl: "wss://ws.gemini.com" })).toThrow("sandbox only");
  });
});

describe("placeOrder", () => {
  it("sends order.place with formatted price and quantity and reports a fill-or-kill fill", async () => {
    const raw: string[] = [];
    const { venue, ws } = await connected({ onFrame: (frame) => raw.push(frame) });
    const { pending, sent } = await place(venue, ws);

    expect(sent.params).toEqual({
      symbol: SYMBOL,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "FOK",
      price: "0.17",
      quantity: "1.00",
      eventOutcome: "YES",
      clientOrderId: CLIENT_ID,
    });

    ws.serverFrame(acceptAck(sent.id));
    ws.serverFrame(update("NEW"));
    ws.serverFrame(update("FILLED", FILL));

    await expect(drive(pending)).resolves.toEqual({
      kind: "filled",
      venueOrderId: ORDER_ID,
      fills: [{ tradeId: TRADE_ID, units: 100n, px: 1_700n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: 100n,
      costMicros: 170_000n,
      feeMicros: 0n,
    });
    // The frames were pushed as Buffers and reached the raw hook as text.
    expect(raw.at(-1)).toBe(update("FILLED", FILL));
    expect(raw.every((frame) => typeof frame === "string")).toBe(true);
    expect(ws.placed()).toHaveLength(1);
  });

  it("formats a sub-cent NO limit with four decimals", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws, { ...REQUEST, outcome: "NO", limitPx: 9_725n, units: 250n, timeInForce: "IOC" });
    expect(sent.params).toMatchObject({ price: "0.9725", quantity: "2.50", eventOutcome: "NO", timeInForce: "IOC" });
    ws.serverClose(1006);
    await drive(pending);
  });

  it("reports a fill-or-kill refusal as not_filled with the venue's reason", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(acceptAck(sent.id));
    ws.serverFrame(update("NEW"));
    ws.serverFrame(update("CANCELED", REFUSAL));

    await expect(drive(pending)).resolves.toEqual({ kind: "not_filled", venueOrderId: ORDER_ID, reason: "FillOrKillWouldNotFill" });
  });

  it("reports a rejection ack as rejected with the venue's code and message", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(JSON.stringify({ id: sent.id, status: 400, error: { code: -1013, msg: "limit price is out of range" } }));

    await expect(drive(pending)).resolves.toEqual({ kind: "rejected", code: -1013, message: "limit price is out of range" });
  });

  it("handles order events that arrive before the ack", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(update("NEW"));
    ws.serverFrame(update("FILLED", FILL));
    await vi.advanceTimersByTimeAsync(50);
    ws.serverFrame(acceptAck(sent.id));

    await expect(drive(pending)).resolves.toMatchObject({ kind: "filled", venueOrderId: ORDER_ID, filledUnits: 100n, costMicros: 170_000n });
  });

  it("reports inconsistent order events as unknown", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(acceptAck(sent.id));
    ws.serverFrame(update("NEW"));
    // A cancel whose cumulative quantity is not matched by any fill event.
    ws.serverFrame(update("CANCELED", { ...REFUSAL, Z: "1.00" }));

    await expect(drive(pending)).resolves.toEqual({
      kind: "unknown",
      venueOrderId: ORDER_ID,
      reason: "inconsistent order events: CANCELED reports 100 units filled but the fills seen add up to 0",
    });
  });

  it("reports unknown when a rejection ack contradicts order events already received", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(update("NEW"));
    ws.serverFrame(JSON.stringify({ id: sent.id, status: 500, error: { code: -1000, msg: "internal error" } }));

    await expect(drive(pending)).resolves.toEqual({
      kind: "unknown",
      venueOrderId: ORDER_ID,
      reason: "ack status 500 after order events were received",
    });
  });

  it("reports unknown when no final order event arrives within 5 s of the ack, and never resends", async () => {
    const { venue, ws } = await connected();
    const { pending, sent } = await place(venue, ws);
    ws.serverFrame(acceptAck(sent.id));
    ws.serverFrame(update("NEW"));
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await expect(drive(pending, 1)).resolves.toEqual({
      kind: "unknown",
      venueOrderId: ORDER_ID,
      reason: "no final order event within 5000 ms",
    });
    expect(ws.placed()).toHaveLength(1);

    // A late fill for the abandoned order is ignored, and the client id can be used again.
    expect(() => ws.serverFrame(update("FILLED", FILL))).not.toThrow();
  });

  it("reports unknown when the ack never arrives", async () => {
    const { venue, ws } = await connected();
    const { pending } = await place(venue, ws);
    await expect(drive(pending, 10_000)).resolves.toEqual({
      kind: "unknown",
      venueOrderId: null,
      reason: "no ack: no ack for order.place (id 4) within 10000 ms",
    });
    expect(ws.placed()).toHaveLength(1);
  });

  it("refuses a request it cannot format, and a duplicate in-flight client id, without sending", async () => {
    const { venue, ws } = await connected();
    await expect(venue.placeOrder({ ...REQUEST, limitPx: 10_000n })).resolves.toEqual({
      kind: "rejected",
      code: null,
      message: "limit px out of range 1..=9999: 10000",
    });
    expect(ws.placed()).toEqual([]);

    const first = await place(venue, ws);
    await expect(venue.placeOrder(REQUEST)).resolves.toEqual({
      kind: "rejected",
      code: null,
      message: `an order with client order id ${CLIENT_ID} is already in flight`,
    });
    expect(ws.placed()).toHaveLength(1);
    ws.serverClose(1006);
    await drive(first.pending);
  });
});

describe("connection loss", () => {
  it("fails in-flight orders as unknown, refuses new ones, and reconnects on a later call after 1 s", async () => {
    const { venue, ws } = await connected();
    await vi.advanceTimersByTimeAsync(5_000);
    const waitingForAck = await place(venue, ws);
    const waitingForFill = await place(venue, ws, { ...REQUEST, clientOrderId: "o-ffffffffffffffffffffffffffffffff" });
    ws.serverFrame(acceptAck(waitingForFill.sent.id));
    await vi.advanceTimersByTimeAsync(0);

    ws.serverClose(1006);
    await expect(drive(waitingForAck.pending)).resolves.toMatchObject({ kind: "unknown", venueOrderId: null });
    await expect(drive(waitingForFill.pending)).resolves.toEqual({
      kind: "unknown",
      venueOrderId: ORDER_ID,
      reason: "socket closed before the final order event",
    });
    expect(venue.connected).toBe(false);

    // Inside the back-off window nothing is opened and nothing is sent.
    await vi.advanceTimersByTimeAsync(999);
    await expect(venue.placeOrder(REQUEST)).resolves.toEqual({ kind: "rejected", code: null, message: "venue disconnected" });
    expect(FakeWebSocket.instances).toHaveLength(1);

    // After it, the next call reconnects, subscribes again and sends.
    await vi.advanceTimersByTimeAsync(1);
    const pending = venue.placeOrder(REQUEST);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    expect(second.sent.map((message) => message.method)).toEqual(["SUBSCRIBE", "SUBSCRIBE", "SUBSCRIBE", "order.place"]);
    expect(venue.connected).toBe(true);
    second.serverFrame(acceptAck(second.placed()[0]!.id));
    second.serverFrame(update("FILLED", FILL));
    await expect(drive(pending)).resolves.toMatchObject({ kind: "filled" });
  });

  it("ensureConnected retries with a back-off of 1 s, 2 s, 5 s, then every 10 s", async () => {
    const { venue, ws } = await connected();
    await vi.advanceTimersByTimeAsync(5_000);
    ws.serverClose(1006);
    const closedAt = Date.now();
    FakeWebSocket.refuseUpgrade = true;

    // Each call is made right after the previous failure and settles exactly when its wait ends.
    for (const waitMs of [1_000, 2_000, 5_000, 10_000, 10_000]) {
      const attempt = venue.ensureConnected();
      let settled = false;
      void attempt.catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(settled).toBe(false);
      await expect(drive(attempt, 1)).rejects.toThrow("socket upgrade failed: HTTP 503");
    }
    const attempts = FakeWebSocket.instances.slice(1).map((instance) => instance.createdAt - closedAt);
    expect(attempts).toEqual([1_000, 3_000, 8_000, 18_000, 28_000]);

    FakeWebSocket.refuseUpgrade = false;
    await drive(venue.ensureConnected(), 10_000);
    expect(venue.connected).toBe(true);
    expect(FakeWebSocket.instances.at(-1)!.createdAt - closedAt).toBe(38_000);
    await expect(venue.ensureConnected()).resolves.toBeUndefined();
    expect(FakeWebSocket.instances).toHaveLength(7);
  });

  it("close() disconnects", async () => {
    const { venue, ws } = await connected();
    venue.close();
    expect(ws.readyState).toBe(3);
    expect(venue.connected).toBe(false);
  });
});

function historyRow(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: ORDER_ID,
    clientOrderId: CLIENT_ID,
    status: "filled",
    symbol: SYMBOL,
    side: "buy",
    outcome: "yes",
    orderType: "limit",
    timeInForce: "fill-or-kill",
    quantity: "1",
    filledQuantity: "1",
    remainingQuantity: "0",
    price: "0.17",
    avgExecutionPrice: "0.17",
    createdAt: "2026-11-14T02:40:05.000Z",
    ...fields,
  };
}

const HISTORY = "/v1/prediction-markets/orders/history";
const ACTIVE = "/v1/prediction-markets/orders/active";

/** Answers the two lookup endpoints. */
function lookups(history: unknown[], active: unknown[] = []) {
  return (call: HttpCall) => (call.path === HISTORY ? { orders: history } : { orders: active });
}

describe("findOrder", () => {
  it("finds a filled order in the history by client order id", async () => {
    const { venue, http } = await connected();
    // The order id arrives as a bare 18-digit integer.
    const body = JSON.stringify({ orders: [historyRow({ clientOrderId: "o-other" }), historyRow()] }).replace(
      new RegExp(`"orderId":"${ORDER_ID}"`, "g"),
      `"orderId":${ORDER_ID}`,
    );
    http.respond(() => new Response(body, { status: 200 }));

    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({
      found: true,
      venueOrderId: ORDER_ID,
      closed: true,
      filledUnits: 100n,
      avgPx: 1_700n,
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ method: "POST", path: HISTORY, payload: { request: HISTORY, symbol: SYMBOL, limit: 50 } });
  });

  it("trusts filledQuantity over status: a filled immediate-or-cancel order reports cancelled", async () => {
    const { venue, http } = await connected();
    http.respond(lookups([historyRow({ status: "cancelled", quantity: "16", filledQuantity: "11", avgExecutionPrice: "0.09" })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({
      found: true,
      venueOrderId: ORDER_ID,
      closed: true,
      filledUnits: 1_100n,
      avgPx: 900n,
    });
  });

  it("gives a null average when it is missing or not a whole px", async () => {
    const { venue, http } = await connected();
    http.respond(lookups([historyRow({ avgExecutionPrice: "0.097654" })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toMatchObject({ filledUnits: 100n, avgPx: null });

    http.respond(lookups([historyRow({ status: "cancelled", filledQuantity: "0", avgExecutionPrice: undefined })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({
      found: true,
      venueOrderId: ORDER_ID,
      closed: true,
      filledUnits: 0n,
      avgPx: null,
    });
  });

  it("reports an order that is still open as found and not closed", async () => {
    const { venue, http } = await connected();
    http.respond(lookups([historyRow({ status: "open", filledQuantity: "0.25", avgExecutionPrice: "0.17" })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({
      found: true,
      venueOrderId: ORDER_ID,
      closed: false,
      filledUnits: 25n,
      avgPx: 1_700n,
    });

    // Absent from the history but present among the active orders.
    http.respond(lookups([], [historyRow({ status: "open", filledQuantity: "0", avgExecutionPrice: undefined })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({
      found: true,
      venueOrderId: ORDER_ID,
      closed: false,
      filledUnits: 0n,
      avgPx: null,
    });
    expect(http.calls.map((call) => call.path)).toEqual([HISTORY, HISTORY, ACTIVE]);
  });

  it("reports not found when neither endpoint knows the client order id", async () => {
    const { venue, http } = await connected();
    http.respond(lookups([historyRow({ clientOrderId: "o-other" })], [historyRow({ clientOrderId: "o-another" })]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({ found: false });
  });

  it("ignores orders created well before sinceMs and prefers the newest match", async () => {
    const { venue, http } = await connected();
    const old = historyRow({ orderId: "700000000000000009", createdAt: "2026-11-14T02:30:00.000Z" });
    http.respond(lookups([old]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toEqual({ found: false });

    // A venue clock up to a minute behind ours must not hide the order.
    const skewed = historyRow({ orderId: "700000000000000002", createdAt: "2026-11-14T02:39:30.000Z", filledQuantity: "0", status: "cancelled" });
    const newest = historyRow({ orderId: "700000000000000003", createdAt: "2026-11-14T02:40:07.000Z" });
    http.respond(lookups([old, skewed, newest]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toMatchObject({
      venueOrderId: "700000000000000003",
      filledUnits: 100n,
    });
    http.respond(lookups([old, skewed]));
    await expect(drive(venue.findOrder(CLIENT_ID, SYMBOL, START_MS), 3_000)).resolves.toMatchObject({
      venueOrderId: "700000000000000002",
      filledUnits: 0n,
    });
  });
});

describe("netPosition and cashMicros", () => {
  it("signs the position: yes positive, no negative, no row zero", async () => {
    const { venue, http } = await connected();
    const row = (outcome: string) => ({ positions: [{ symbol: "GEMI-OTHER-UP", totalQuantity: "3", outcome: "yes" }, { symbol: SYMBOL, totalQuantity: "12", outcome }], total: 2 });

    http.respond(() => row("yes"));
    await expect(drive(venue.netPosition(SYMBOL), 3_000)).resolves.toBe(1_200n);
    http.respond(() => row("no"));
    await expect(drive(venue.netPosition(SYMBOL), 3_000)).resolves.toBe(-1_200n);
    http.respond(() => ({ positions: [], total: 0 }));
    await expect(drive(venue.netPosition(SYMBOL), 3_000)).resolves.toBe(0n);

    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/prediction-markets/positions",
      query: "?limit=100",
      payload: { request: "/v1/prediction-markets/positions" },
    });
  });

  it("rejects a position with an unknown outcome instead of guessing its sign", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [{ symbol: SYMBOL, totalQuantity: "12", outcome: "maybe" }] }));
    await expect(drive(venue.netPosition(SYMBOL), 3_000)).rejects.toThrow(`position for ${SYMBOL} has an unknown outcome`);
  });

  it("reads available USD in micro-dollars", async () => {
    const { venue, http } = await connected();
    http.respond(() => [
      { type: "exchange", currency: "BTC", amount: "1000", available: "1000" },
      { type: "exchange", currency: "USD", amount: "100000.00", available: "99998.76" },
    ]);
    await expect(drive(venue.cashMicros(), 3_000)).resolves.toBe(99_998_760_000n);
    expect(http.calls[0]).toMatchObject({ method: "POST", path: "/v1/balances" });

    http.respond(() => [{ currency: "BTC", available: "1" }]);
    await expect(drive(venue.cashMicros(), 3_000)).resolves.toBe(0n);
  });
});

describe("settledPayoutMicros", () => {
  const settledRow = (fields: Record<string, unknown> = {}) => ({
    instrumentSymbol: SYMBOL,
    position: 12,
    positionQuantity: "12",
    outcome: "yes",
    payout: "12",
    resolutionSide: "yes",
    settledAt: "2026-11-14T03:00:09.000Z",
    ...fields,
  });

  it("reads the payout of the symbol's settled position in micro-dollars", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [settledRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN", payout: "3" }), settledRow()] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(12_000_000n);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/prediction-markets/positions/settled",
      query: `?eventTicker=${EVENT}&limit=20`,
      payload: { request: "/v1/prediction-markets/positions/settled" },
    });

    http.respond(() => ({ positions: [settledRow({ outcome: "no", payout: "0" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(0n);
    http.respond(() => ({ positions: [settledRow({ payout: "0.5" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(500_000n);
  });

  it("returns null when the venue has no settled position for the symbol", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [settledRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBeNull();
    http.respond(() => ({ positions: [] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBeNull();
  });

  it("rejects an unreadable payout and a symbol with no event part instead of reporting nothing paid", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [settledRow({ payout: "twelve" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).rejects.toThrow(`settled position for ${SYMBOL}: unreadable payout`);
    const before = http.calls.length;
    await expect(venue.settledPayoutMicros("NOEVENT")).rejects.toThrow("no event ticker for NOEVENT");
    expect(http.calls).toHaveLength(before);
  });
});

function contractRow(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticker: "UP",
    instrumentSymbol: SYMBOL,
    status: "active",
    marketState: "open",
    expiryDate: "2026-11-14T03:00:00.000Z",
    effectiveDate: "2026-11-14T02:45:00.000Z",
    quantityIncrement: "0.01",
    quantityMinimum: "0.01",
    priceIncrement: "0.01",
    ...fields,
  };
}

describe("contract and listContracts", () => {
  it("maps a contract of the event derived from the symbol", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ ticker: EVENT, status: "active", contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" }), contractRow()] }));

    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toEqual({
      symbol: SYMBOL,
      eventTicker: EVENT,
      status: "active",
      marketState: "open",
      effectiveAt: new Date("2026-11-14T02:45:00.000Z"),
      expiresAt: new Date("2026-11-14T03:00:00.000Z"),
      tickPx: 100n,
      unitIncrement: 1n,
      minUnits: 1n,
      resolutionSide: null,
      strike: null,
      settlementValue: null,
    });
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `/v1/prediction-markets/events/${EVENT}`, payload: null });
  });

  it("fills the display fields from the event and the contract", async () => {
    const { venue, http } = await connected();
    const strike = { type: "reference", value: "64000.50", availableAt: "2026-11-14T02:45:00.000Z" };
    http.respond(() => ({
      ticker: EVENT,
      title: "Demo price today at 10pm",
      series: "DEMO15M",
      contracts: [contractRow({ label: "Up", strike, settlementValue: 64100.125, status: "settled", resolutionSide: "yes" })],
    }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toMatchObject({
      title: "Demo price today at 10pm",
      series: "DEMO15M",
      label: "Up",
      strike: "64000.50",
      settlementValue: "64100.125",
    });

    // Before the window starts the reference price is not known yet.
    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ strike: { type: "reference", value: null }, settlementValue: "64100.5" })] }));
    const early = await drive(venue.contract(SYMBOL), 1_000);
    expect(early).toMatchObject({ strike: null, settlementValue: "64100.5" });
    expect(early).not.toHaveProperty("title");
    expect(early).not.toHaveProperty("label");
    expect(early).not.toHaveProperty("series");
  });

  it("lists contracts with the display fields of their event", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({
      data: [{ ticker: EVENT, title: "Demo price today at 10pm", series: "DEMO15M", contracts: [contractRow({ label: "Up", strike: { type: "reference", value: "64000.50" } })] }],
    }));
    await expect(drive(venue.listContracts(), 1_000)).resolves.toEqual([
      expect.objectContaining({ symbol: SYMBOL, title: "Demo price today at 10pm", series: "DEMO15M", label: "Up", strike: "64000.50", settlementValue: null }),
    ]);
  });

  it("reads the top of book the event list and the single event carry, in YES price space", async () => {
    const { venue, http } = await connected();
    const quoted = { buy: { yes: "0.11", no: "0.97" }, sell: { yes: "0.03", no: "0.89" }, bestBid: "0.03", bestAsk: "0.11" };
    http.respond(() => ({
      data: [
        {
          ticker: EVENT,
          contracts: [
            contractRow({ prices: quoted }),
            contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN", prices: { buy: {}, sell: {} } }),
            contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-FLAT", prices: { buy: {}, sell: {}, bestBid: "0.4", bestAsk: "soon" } }),
            contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-BARE" }),
          ],
        },
      ],
    }));
    const listed = await drive(venue.listContracts(), 1_000);
    expect(listed.map((contract) => [contract.bestBidPx, contract.bestAskPx])).toEqual([
      [300n, 1_100n],
      [null, null],
      [4_000n, null],
      [undefined, undefined],
    ]);
    expect(listed[3]).not.toHaveProperty("bestBidPx");

    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ prices: quoted })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toMatchObject({ bestBidPx: 300n, bestAskPx: 1_100n });
  });

  it("passes unknown states through and reads the resolution side leniently", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ status: "settled", marketState: "closed", resolutionSide: "YES" })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toMatchObject({ status: "settled", marketState: "closed", resolutionSide: "yes" });

    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ status: "under_review", marketState: 7, resolutionSide: "void" })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toMatchObject({ status: "under_review", marketState: "unknown", resolutionSide: null });
  });

  it("returns null for an unknown event, a missing contract, or a symbol with no event part", async () => {
    const { venue, http } = await connected();
    http.respond(() => new Response('{"error":"not found"}', { status: 404 }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toBeNull();

    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toBeNull();

    const before = http.calls.length;
    await expect(venue.contract("NOEVENT")).resolves.toBeNull();
    expect(http.calls).toHaveLength(before);
  });

  it("rejects a contract whose price grid cannot be read", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ ticker: EVENT, contracts: [contractRow({ priceIncrement: "a cent" })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).rejects.toThrow(`contract ${SYMBOL}: unreadable priceIncrement`);
  });

  it("lists active contracts and remembers each symbol's event ticker", async () => {
    const { venue, http } = await connected();
    const odd = "GEMI-ODD-SYMBOL-WITH-PARTS";
    http.respond((call) =>
      call.path === "/v1/prediction-markets/events"
        ? {
            data: [
              { ticker: EVENT, contracts: [contractRow()] },
              { ticker: "ODDEVENT", contracts: [contractRow({ instrumentSymbol: odd }), contractRow({ instrumentSymbol: "GEMI-BROKEN-UP", quantityIncrement: null })] },
            ],
          }
        : { ticker: "ODDEVENT", contracts: [contractRow({ instrumentSymbol: odd })] },
    );

    const listed = await drive(venue.listContracts(), 1_000);
    expect(listed.map((contract) => [contract.symbol, contract.eventTicker])).toEqual([
      [SYMBOL, EVENT],
      [odd, "ODDEVENT"],
    ]);
    expect(http.calls[0]).toMatchObject({ path: "/v1/prediction-markets/events", query: "?status=active&category=crypto&limit=500" });

    // The remembered ticker wins over the one derived from the symbol.
    await expect(drive(venue.contract(odd), 1_000)).resolves.toMatchObject({ symbol: odd, eventTicker: "ODDEVENT" });
    expect(http.calls[1]!.path).toBe("/v1/prediction-markets/events/ODDEVENT");
  });
});

describe("topOfBook", () => {
  it("reads the best bid and ask in px and units", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ bids: [{ price: "0.03", amount: "29.5" }], asks: [{ price: "0.17", amount: "24.0" }] }));
    await expect(drive(venue.topOfBook(SYMBOL), 1_000)).resolves.toEqual({ bidPx: 300n, bidUnits: 2_950n, askPx: 1_700n, askUnits: 2_400n });
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `/v1/book/${SYMBOL}`, query: "?limit_bids=1&limit_asks=1" });
  });

  it("reports an empty side as a null price and zero units", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ bids: [], asks: [{ price: "0.17", amount: "24.0" }] }));
    await expect(drive(venue.topOfBook(SYMBOL), 1_000)).resolves.toEqual({ bidPx: null, bidUnits: 0n, askPx: 1_700n, askUnits: 2_400n });
  });
});

describe("HTTP retries", () => {
  it("retries a failed GET once", async () => {
    const { venue, http } = await connected();
    http.respond((_call, index) => (index === 0 ? new Error("fetch failed") : { bids: [], asks: [] }));
    await expect(drive(venue.topOfBook(SYMBOL), 2_000)).resolves.toMatchObject({ bidPx: null, askPx: null });
    expect(http.calls).toHaveLength(2);

    http.respond(() => new Error("fetch failed"));
    await expect(drive(venue.topOfBook(SYMBOL), 5_000)).rejects.toThrow("fetch failed");
    expect(http.calls).toHaveLength(4);
  });

  it("retries a signed read once, a nonce second later, and does not retry a client error", async () => {
    const { venue, http } = await connected();
    await vi.advanceTimersByTimeAsync(5_000);
    http.respond((_call, index) => (index === 0 ? new Response("Bad Gateway", { status: 502 }) : [{ currency: "USD", available: "1.50" }]));
    await expect(drive(venue.cashMicros(), 3_000)).resolves.toBe(1_500_000n);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]!.at - http.calls[0]!.at).toBe(1_100);
    expect(http.calls[1]!.payload!.nonce).not.toBe(http.calls[0]!.payload!.nonce);

    http.respond(() => new Response('{"result":"error","reason":"InvalidNonce"}', { status: 400 }));
    await expect(drive(venue.cashMicros(), 3_000)).rejects.toThrow("HTTP 400 from POST /v1/balances");
    expect(http.calls).toHaveLength(3);
  });
});
