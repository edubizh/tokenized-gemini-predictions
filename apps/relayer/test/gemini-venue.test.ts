import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiSandboxVenue } from "../src/venue/gemini/venue.ts";
import type { GeminiSandboxVenueOptions } from "../src/venue/gemini/venue.ts";
import type { VenueOrderRequest } from "../src/venue/types.ts";
import { EVENT, FakeWebSocket, LADDER, START_MS, SYMBOL, contractRow, drive, eventRow, httpFake, ladderRow, strikeRow } from "./gemini-fakes.ts";
import type { HttpCall, Row } from "./gemini-fakes.ts";

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

async function connected(extra: Partial<GeminiSandboxVenueOptions> = {}) {
  const http = httpFake();
  const venue = new GeminiSandboxVenue({
    apiKey: "account-TESTKEY",
    apiSecret: "test-secret",
    WebSocketImpl: FakeWebSocket,
    fetch: http.fetch,
    log: () => {},
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
  FakeWebSocket.reset();
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

const POSITIONS = "/v1/prediction-markets/positions";
const SETTLED = "/v1/prediction-markets/positions/settled";
const EVENTS = "/v1/prediction-markets/events";
const LOW = `GEMI-${LADDER}-HI0D82`;
const HIGH = `GEMI-${LADDER}-HI0D84`;

/** The value of one query parameter of a recorded call. */
function param(call: HttpCall, name: string): string | null {
  return new URLSearchParams(call.query).get(name);
}

/** One page of the event list, as the venue wraps it. */
function listPage(data: unknown[], total = data.length): Row {
  return { data, pagination: { limit: 500, offset: 0, total } };
}

describe("positions and cashMicros", () => {
  const position = (symbol: string, totalQuantity: string, outcome: string): Row => ({
    symbol,
    instrumentId: 33_000_001,
    totalQuantity,
    quantityOnHold: "0",
    avgPrice: "0.17",
    outcome,
  });

  it("reads every open position in one call as signed units: yes positive, no negative, flat left out", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [position(SYMBOL, "12", "yes"), position(LOW, "0.5", "no"), position(HIGH, "0", "yes")], total: 3 }));

    await expect(drive(venue.positions(), 3_000)).resolves.toEqual(
      new Map([
        [SYMBOL, 1_200n],
        [LOW, -50n],
      ]),
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ method: "POST", path: POSITIONS, query: "?limit=100&offset=0", payload: { request: POSITIONS } });

    http.respond(() => ({ positions: [], total: 0 }));
    await expect(drive(venue.positions(), 3_000)).resolves.toEqual(new Map());
  });

  it("pages on the total, one signed call at a time", async () => {
    const { venue, http } = await connected();
    // The venue hands out two rows a page here, whatever limit is asked for.
    const rows = ["A", "B", "C", "D", "E"].map((name, index) => position(`GEMI-${name}2611140300-UP`, String(index + 1), index % 2 === 0 ? "yes" : "no"));
    http.respond((call) => {
      const offset = Number(param(call, "offset"));
      return { positions: rows.slice(offset, offset + 2), total: rows.length };
    });

    const positions = await drive(venue.positions(), 10_000);
    expect([...positions]).toEqual([
      ["GEMI-A2611140300-UP", 100n],
      ["GEMI-B2611140300-UP", -200n],
      ["GEMI-C2611140300-UP", 300n],
      ["GEMI-D2611140300-UP", -400n],
      ["GEMI-E2611140300-UP", 500n],
    ]);
    expect(http.calls.map((call) => call.query)).toEqual(["?limit=100&offset=0", "?limit=100&offset=2", "?limit=100&offset=4"]);
    expect(http.calls.map((call) => call.at - http.calls[0]!.at)).toEqual([0, 1_100, 2_200]);
  });

  it("nets a yes row against a no row of the same contract", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [position(SYMBOL, "5", "yes"), position(SYMBOL, "2", "no"), position(LOW, "3", "no"), position(LOW, "3", "yes")], total: 4 }));
    await expect(drive(venue.positions(), 3_000)).resolves.toEqual(new Map([[SYMBOL, 300n]]));
  });

  it("rejects a position with an unknown outcome instead of guessing its sign", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [position(SYMBOL, "12", "maybe")], total: 1 }));
    await expect(drive(venue.positions(), 3_000)).rejects.toThrow(`position for ${SYMBOL} has an unknown outcome`);

    http.respond(() => ({ positions: [position(SYMBOL, "a dozen", "yes")], total: 1 }));
    await expect(drive(venue.positions(), 3_000)).rejects.toThrow(`position for ${SYMBOL}: unreadable quantity`);
    http.respond(() => ({ positions: [{ totalQuantity: "12", outcome: "yes" }], total: 1 }));
    await expect(drive(venue.positions(), 3_000)).rejects.toThrow("position without a symbol");
    http.respond(() => ({ total: 0 }));
    await expect(drive(venue.positions(), 3_000)).rejects.toThrow('unexpected response: no "positions" list');
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
  const settledRow = (fields: Row = {}): Row => ({
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
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      method: "POST",
      path: SETTLED,
      query: `?eventTicker=${EVENT}&limit=100&offset=0`,
      payload: { request: SETTLED },
    });

    http.respond(() => ({ positions: [settledRow({ outcome: "no", payout: "0" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(0n);
    http.respond(() => ({ positions: [settledRow({ payout: "0.5" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(500_000n);
  });

  it("sums the payouts of every settled row of the symbol", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [settledRow({ payout: "5" }), settledRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN", payout: "3" }), settledRow({ payout: "7.5" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBe(12_500_000n);
  });

  it("returns null when the venue has no settled position for the symbol", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ positions: [settledRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" })] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBeNull();
    http.respond(() => ({ positions: [] }));
    await expect(drive(venue.settledPayoutMicros(SYMBOL), 3_000)).resolves.toBeNull();
  });

  it("reads on past a full page: the venue sends no total for one event", async () => {
    const { venue, http } = await connected();
    const others = Array.from({ length: 100 }, (_unused, index) => settledRow({ instrumentSymbol: `GEMI-${EVENT}-X${index}`, payout: "1" }));
    http.respond((call) => ({ positions: param(call, "offset") === "0" ? others : [settledRow({ payout: "7" })] }));

    await expect(drive(venue.settledPayoutMicros(SYMBOL), 5_000)).resolves.toBe(7_000_000n);
    expect(http.calls.map((call) => call.query)).toEqual([`?eventTicker=${EVENT}&limit=100&offset=0`, `?eventTicker=${EVENT}&limit=100&offset=100`]);
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

describe("contract", () => {
  it("reads one contract from the event its symbol names", async () => {
    const { venue, http } = await connected();
    http.respond(() => eventRow({ contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" }), contractRow()] }));

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
      label: "Up",
      sortOrder: 0,
      rules: "If the price of Demo is at or above the reference price, this market resolves to Yes. View the full rules.",
      strike: null,
      settlementValue: null,
      bestBidPx: null,
      bestAskPx: null,
      lastPx: null,
    });
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `${EVENTS}/${EVENT}`, query: "", payload: null });
  });

  it("reads the result of a settled contract from its own fields, whatever the event says", async () => {
    const { venue, http } = await connected();
    const settled = { status: "settled", marketState: "closed", resolutionSide: "yes", resolvedAt: "2026-11-14T04:00:07.000Z", settlementValue: "0.8431" };
    // One contract of the ladder is settled, its sibling is stuck, and the event is still under review.
    http.respond(() => ladderRow([strikeRow("0.82", 0, settled), strikeRow("0.84", 1, { status: "under_review", marketState: "closed" })], { status: "under_review" }));

    await expect(drive(venue.contract(LOW), 1_000)).resolves.toMatchObject({ status: "settled", marketState: "closed", resolutionSide: "yes", settlementValue: "0.8431", strike: "0.82" });
    await expect(drive(venue.contract(HIGH), 1_000)).resolves.toMatchObject({ status: "under_review", resolutionSide: null, settlementValue: null });
  });

  it("returns null for an unknown event, a missing contract, or a symbol with no event part", async () => {
    const { venue, http } = await connected();
    http.respond(() => new Response('{"error":"Event not found"}', { status: 404 }));
    await expect(drive(venue.contract(SYMBOL), 3_000)).resolves.toBeNull();

    http.respond(() => eventRow({ contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140300-DOWN" })] }));
    await expect(drive(venue.contract(SYMBOL), 3_000)).resolves.toBeNull();

    const before = http.calls.length;
    await expect(venue.contract("NOEVENT")).resolves.toBeNull();
    expect(http.calls).toHaveLength(before);
  });

  it("rejects a contract whose price grid cannot be read", async () => {
    const { venue, http } = await connected();
    http.respond(() => eventRow({ contracts: [contractRow({ priceIncrement: "a cent" })] }));
    await expect(drive(venue.contract(SYMBOL), 1_000)).rejects.toThrow(`contract ${SYMBOL}: unreadable priceIncrement`);
  });

  it("shares one event read between the contracts of a ladder for two seconds", async () => {
    const { venue, http } = await connected();
    http.respond(() => ladderRow([strikeRow("0.82", 0), strikeRow("0.84", 1)]));

    // Asked for together, they wait for the same read.
    const [low, high] = await drive(Promise.all([venue.contract(LOW), venue.contract(HIGH)]), 0);
    expect([low?.strike, high?.strike]).toEqual(["0.82", "0.84"]);
    expect(http.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    await expect(venue.contract(HIGH)).resolves.toMatchObject({ symbol: HIGH });
    expect(http.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(drive(venue.contract(LOW), 0)).resolves.toMatchObject({ symbol: LOW });
    expect(http.calls).toHaveLength(2);
  });

  it("does not keep a failed event read, and keeps one read per event", async () => {
    const { venue, http } = await connected();
    http.respond(() => new Error("fetch failed"));
    await expect(drive(venue.contract(LOW), 5_000)).rejects.toThrow("fetch failed");
    expect(http.calls).toHaveLength(2); // the read and its one retry

    http.respond((call) => (call.path.endsWith(LADDER) ? ladderRow([strikeRow("0.82", 0)]) : eventRow()));
    await expect(drive(venue.contract(LOW), 1_000)).resolves.toMatchObject({ symbol: LOW });
    await expect(drive(venue.contract(SYMBOL), 1_000)).resolves.toMatchObject({ symbol: SYMBOL });
    expect(http.calls.slice(2).map((call) => call.path)).toEqual([`${EVENTS}/${LADDER}`, `${EVENTS}/${EVENT}`]);
  });
});

describe("listEvents", () => {
  it("asks for every active and approved event and maps both shapes", async () => {
    const { venue, http } = await connected();
    const approved = { status: "approved", marketState: "post_only" };
    http.respond(() => listPage([eventRow({ volume: "48" }), ladderRow([strikeRow("0.84", 1, approved), strikeRow("0.82", 0, approved)], { status: "approved", category: "Commodities" })]));

    const events = await drive(venue.listEvents(), 1_000);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({ method: "GET", path: EVENTS, query: "?status=active&status=approved&limit=500&offset=0", payload: null });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ ticker: EVENT, shape: "binary", cadence: "15m", category: "Crypto", status: "active", volumeUnits: 4_800n });
    expect(events[0]!.contracts.map((contract) => contract.symbol)).toEqual([SYMBOL]);
    expect(events[1]).toMatchObject({ ticker: LADDER, shape: "ladder", cadence: "hourly", category: "Commodities", status: "approved" });
    expect(events[1]!.contracts.map((contract) => [contract.symbol, contract.status, contract.marketState, contract.strike])).toEqual([
      [LOW, "approved", "post_only", "0.82"],
      [HIGH, "approved", "post_only", "0.84"],
    ]);
  });

  it("pages on the total and lists each event and each contract once", async () => {
    const { venue, http } = await connected();
    const later = eventRow({ ticker: "DEMO15M2611140315", contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140315-UP" })] });
    // The venue hands out two events a page here; the list moved between two pages, so one event
    // comes twice, and two other events repeat a contract that is already listed.
    const pages: Record<string, unknown[]> = {
      "0": [eventRow(), ladderRow([strikeRow("0.82", 0), strikeRow("0.84", 1)])],
      "2": [ladderRow([strikeRow("0.82", 0)]), later],
      "4": [
        eventRow({ ticker: "COPY15M2611140300", contracts: [contractRow(), contractRow({ instrumentSymbol: "GEMI-COPY15M2611140300-UP" })] }),
        eventRow({ ticker: "TWIN15M2611140300" }),
      ],
    };
    http.respond((call) => {
      const offset = param(call, "offset") ?? "";
      return { data: pages[offset] ?? [], pagination: { limit: 2, offset: Number(offset), total: 6 } };
    });

    const events = await drive(venue.listEvents(), 5_000);
    expect(http.calls.map((call) => call.query)).toEqual([
      "?status=active&status=approved&limit=500&offset=0",
      "?status=active&status=approved&limit=500&offset=2",
      "?status=active&status=approved&limit=500&offset=4",
    ]);
    expect(events.map((event) => [event.ticker, event.contracts.map((contract) => contract.symbol)])).toEqual([
      [EVENT, [SYMBOL]],
      [LADDER, [LOW, HIGH]],
      ["DEMO15M2611140315", ["GEMI-DEMO15M2611140315-UP"]],
      ["COPY15M2611140300", ["GEMI-COPY15M2611140300-UP"]],
    ]);
  });

  it("stops at an empty page even when the total promises more", async () => {
    const { venue, http } = await connected();
    http.respond((call) => ({ data: param(call, "offset") === "0" ? [eventRow()] : [], pagination: { limit: 500, offset: 0, total: 3 } }));
    await expect(drive(venue.listEvents(), 3_000)).resolves.toHaveLength(1);
    expect(http.calls).toHaveLength(2);
  });

  it("answers from its last read for ten seconds, and callers that overlap share one read", async () => {
    const { venue, http } = await connected();
    http.respond(() => listPage([eventRow()]));
    const first = await drive(venue.listEvents(), 0);

    await vi.advanceTimersByTimeAsync(9_999);
    await expect(venue.listEvents()).resolves.toBe(first);
    expect(http.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    const [second, third] = await drive(Promise.all([venue.listEvents(), venue.listEvents()]), 0);
    expect(http.calls).toHaveLength(2);
    expect(second).toBe(third);
    expect(second).not.toBe(first);
  });

  // Measured on the sandbox: the list comes from caches that disagree, so a read can return a
  // page that is minutes older than the one before it.
  it("keeps the list it holds when the venue answers with an older page, and asks again at the next call", async () => {
    const { venue, http } = await connected();
    const later = (minute: string): Row => {
      const contracts = [contractRow({ instrumentSymbol: `GEMI-DEMO15M26111403${minute}-UP` })];
      return eventRow({ ticker: `DEMO15M26111403${minute}`, createdAt: `2026-11-14T02:${minute}:00.000Z`, contracts });
    };
    http.respond(() => listPage([eventRow(), later("41")]));
    const held = await drive(venue.listEvents(), 20_000);
    expect(held).toHaveLength(2);

    // A page from before the newest event it knows was listed.
    http.respond(() => listPage([eventRow({ volume: "1" })]));
    await expect(drive(venue.listEvents(), 5_000)).resolves.toBe(held);
    http.respond(() => listPage([]));
    await expect(drive(venue.listEvents(), 5_000)).resolves.toBe(held);
    expect(http.calls).toHaveLength(3);

    // A page of the same age or newer replaces it.
    http.respond(() => listPage([eventRow({ volume: "2" }), later("41")]));
    const same = await drive(venue.listEvents(), 20_000);
    expect(same[0]!.volumeUnits).toBe(200n);
    http.respond(() => listPage([eventRow({ volume: "3" }), later("41"), later("45")]));
    await expect(drive(venue.listEvents(), 20_000)).resolves.toHaveLength(3);
    expect(http.calls).toHaveLength(5);
  });

  it("takes an older page after five minutes without a newer one: the newest event may be gone", async () => {
    const { venue, http } = await connected();
    const newest = eventRow({ ticker: "DEMO15M2611140315", createdAt: "2026-11-14T02:41:00.000Z", contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO15M2611140315-UP" })] });
    http.respond(() => listPage([eventRow(), newest]));
    const held = await drive(venue.listEvents(), 299_999);

    http.respond(() => listPage([eventRow()]));
    await expect(drive(venue.listEvents(), 1)).resolves.toBe(held);
    await expect(drive(venue.listEvents(), 1_000)).resolves.toHaveLength(1);
  });

  // Seen at a start: the first page was half an hour behind, without the newest fifteen-minute
  // events; a minute later the list was complete.
  it("before it holds a list, reads again while the page has no event from the last ten minutes, three reads at most, and keeps the newest", async () => {
    const { venue, http } = await connected();
    const listed = (minute: string): Row => {
      const contracts = [contractRow({ instrumentSymbol: `GEMI-DEMO15M26111403${minute}-UP` })];
      return eventRow({ ticker: `DEMO15M26111403${minute}`, createdAt: `2026-11-14T02:${minute}:00.000Z`, contracts });
    };
    // The clock reads 02:40:00.250.
    const pages = [[listed("05")], [listed("05"), listed("31")], [listed("05"), listed("31"), listed("30")]];
    http.respond((_call, index) => listPage(pages[index] ?? []));
    const events = await drive(venue.listEvents(), 5_000);
    expect(http.calls).toHaveLength(2); // 02:31 is within ten minutes
    expect(events.map((event) => event.ticker)).toEqual(["DEMO15M2611140305", "DEMO15M2611140331"]);

    const { venue: other, http: otherHttp } = await connected();
    const stale = [[listed("05"), listed("12")], [listed("05"), listed("20")], [listed("05")], [listed("05"), listed("29")]];
    otherHttp.respond((_call, index) => listPage(stale[index] ?? []));
    const best = await drive(other.listEvents(), 5_000);
    expect(otherHttp.calls).toHaveLength(3);
    expect(best.map((event) => event.ticker)).toEqual(["DEMO15M2611140305", "DEMO15M2611140320"]);
  });

  it("fails when the venue cannot be read, rather than answering from its last read", async () => {
    const { venue, http } = await connected();
    http.respond(() => listPage([eventRow()]));
    await drive(venue.listEvents(), 20_000);

    http.respond(() => new Response("Bad Gateway", { status: 502 }));
    await expect(drive(venue.listEvents(), 5_000)).rejects.toThrow(`HTTP 502 from GET ${EVENTS}`);
    http.respond(() => ({ events: [] }));
    await expect(drive(venue.listEvents(), 5_000)).rejects.toThrow('unexpected response: no "data" list');

    http.respond(() => listPage([eventRow()]));
    await expect(drive(venue.listEvents(), 5_000)).resolves.toHaveLength(1);
  });

  it("skips a row it cannot read, says why once, and lists the rest", async () => {
    const lines: string[] = [];
    const { venue, http } = await connected({ log: (line) => lines.push(line) });
    const broken = strikeRow("0.84", 1, { priceIncrement: "?" });
    const data = [null, eventRow({ ticker: undefined }), ladderRow([strikeRow("0.82", 0), broken]), eventRow({ ticker: "VOID15M2611140300", contracts: [] }), eventRow()];
    http.respond(() => listPage(data));

    const events = await drive(venue.listEvents(), 20_000);
    expect(events.map((event) => [event.ticker, event.contracts.map((contract) => contract.symbol)])).toEqual([
      [LADDER, [LOW]],
      [EVENT, [SYMBOL]],
    ]);
    const reasons = [
      "venue list: skipped event without a ticker",
      `venue list: skipped contract ${HIGH}: unreadable priceIncrement`,
      "venue list: skipped event VOID15M2611140300: no readable contract",
    ];
    expect(lines).toEqual(reasons);

    // The same rows on the next read are not reported again; a new one is.
    data.push(eventRow({ ticker: "LATE15M2611140300", expiryDate: "later", contracts: [contractRow({ instrumentSymbol: "GEMI-LATE15M2611140300-UP" })] }));
    await expect(drive(venue.listEvents(), 20_000)).resolves.toHaveLength(2);
    expect(lines).toEqual([...reasons, "venue list: skipped event LATE15M2611140300: unreadable expiryDate"]);
  });

  it("keeps the event ticker the list gave with each contract, whatever the symbol looks like", async () => {
    const { venue, http } = await connected();
    const odd = "GEMI-ODD-2611140300-AAA-BBB-M-AAA1.5";
    const oddEvent = "ODD-2611140300-AAA-BBB";
    http.respond((call) => {
      if (call.path === EVENTS) return listPage([eventRow(), eventRow({ ticker: oddEvent, contracts: [contractRow({ instrumentSymbol: odd })] })]);
      if (call.path === SETTLED) return { positions: [{ instrumentSymbol: odd, payout: "2" }] };
      return eventRow({ ticker: oddEvent, contracts: [contractRow({ instrumentSymbol: odd })] });
    });

    const events = await drive(venue.listEvents(), 1_000);
    expect(events[1]!.contracts[0]).toMatchObject({ symbol: odd, eventTicker: oddEvent });

    // The ticker from the list wins over the one the symbol's last dash would give.
    await expect(drive(venue.contract(odd), 1_000)).resolves.toMatchObject({ symbol: odd, eventTicker: oddEvent });
    expect(http.calls.at(-1)!.path).toBe(`${EVENTS}/${oddEvent}`);
    await expect(drive(venue.settledPayoutMicros(odd), 3_000)).resolves.toBe(2_000_000n);
    expect(http.calls.at(-1)!.query).toBe(`?eventTicker=${oddEvent}&limit=100&offset=0`);

    // A symbol no list has shown is split at its last dash.
    await drive(venue.contract("GEMI-NEW-2611140300-CCC-DDD-M-CCC"), 1_000);
    expect(http.calls.at(-1)!.path).toBe(`${EVENTS}/NEW-2611140300-CCC-DDD-M`);
  });

  it("keeps the event ticker of a symbol for a week after its contract expired: settlement asks for it then", async () => {
    const { venue, http } = await connected();
    const odd = "GEMI-ODD-2611140300-AAA-BBB-M-AAA1.5";
    const oddEvent = "ODD-2611140300-AAA-BBB";
    const longLived = eventRow({ ticker: "DEMO2612140300", contracts: [contractRow({ instrumentSymbol: "GEMI-DEMO2612140300-HI1", expiryDate: "2026-12-14T03:00:00.000Z" })] });
    let listed = [eventRow({ ticker: oddEvent, contracts: [contractRow({ instrumentSymbol: odd })] }), longLived];
    http.respond((call) => (call.path === EVENTS ? listPage(listed) : eventRow()));
    await drive(venue.listEvents(), 1_000);

    // Delisted at its expiry, and still known six days and more later.
    listed = [longLived];
    const expiryMs = Date.parse("2026-11-14T03:00:00.000Z");
    vi.setSystemTime(expiryMs + 7 * 86_400_000 - 60_000);
    await drive(venue.listEvents(), 1_000);
    await drive(venue.contract(odd), 1_000);
    expect(http.calls.at(-1)!.path).toBe(`${EVENTS}/${oddEvent}`);

    // After a week it is forgotten, and the event is taken from the symbol.
    vi.setSystemTime(expiryMs + 7 * 86_400_000);
    await drive(venue.listEvents(), 1_000);
    await drive(venue.contract(odd), 1_000);
    expect(http.calls.at(-1)!.path).toBe(`${EVENTS}/ODD-2611140300-AAA-BBB-M`);
  });

  it("stays within the request budget: asked every 20 s it reads the list three times a minute, and a burst of calls costs no more than six", async () => {
    const { venue, http } = await connected();
    http.respond(() => listPage([eventRow({ expiryDate: "2026-11-14T04:00:00.000Z" })]));
    for (let call = 0; call < 30; call++) await drive(venue.listEvents(), 20_000);
    expect(http.calls.filter((call) => call.path === EVENTS)).toHaveLength(30);

    http.calls.length = 0;
    for (let call = 0; call < 60; call++) await drive(venue.listEvents(), 1_000);
    expect(http.calls.filter((call) => call.path === EVENTS)).toHaveLength(6);
  });
});

/** What the venue answers for a symbol its market data routes do not know. */
function unknownSymbol(symbol: string, json = true): Response {
  const message = `Supplied value '${symbol}' is not a valid symbol`;
  return new Response(json ? JSON.stringify({ result: "error", reason: "Bad Request", message }) : message, { status: 400 });
}

/** A book ticker frame: lower-case symbol, no event name, long bare integers, "" for an empty side. */
function ticker(symbol: string, bid: [price: string, size: string] | null, ask: [price: string, size: string] | null): string {
  const [b, B] = bid ?? ["", ""];
  const [a, A] = ask ?? ["", ""];
  return `{"u":1793265913394827,"E":1794693166237111319,"s":"${symbol.toLowerCase()}","b":"${b}","B":"${B}","a":"${a}","A":"${A}"}`;
}

/** A venue whose last list read showed the ladder: one strike active, one approved. */
async function listed(extra: Partial<GeminiSandboxVenueOptions> = {}) {
  const made = await connected(extra);
  made.http.respond(() => listPage([ladderRow([strikeRow("0.82", 0), strikeRow("0.84", 1, { status: "approved", marketState: "post_only" })])]));
  await drive(made.venue.listEvents(), 1_000);
  made.http.calls.length = 0;
  return { ...made, feed: FakeWebSocket.publicSockets().at(-1)! };
}

describe("liveTop", () => {
  it("serves the top of book of every contract the list shows as active, from the public socket", async () => {
    const { venue, feed, ws } = await listed();
    expect(FakeWebSocket.instances).toEqual([ws, feed]);
    expect(feed.streams("SUBSCRIBE")).toEqual([["contractStatus"], [`${LOW}@bookTicker`]]);
    expect(venue.liveTop(LOW)).toBeUndefined();

    feed.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    feed.serverFrame(ticker(HIGH, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(venue.liveTop(LOW)).toEqual({ top: { bidPx: 300n, bidUnits: 3_300n, askPx: 900n, askUnits: 1_000n }, atMs: START_MS + 8_000 });
    expect(venue.liveTop(HIGH)).toBeUndefined();
    expect(venue.liveTop("GEMI-NOSUCH-UP")).toBeUndefined();
  });

  it("subscribes a contract when a later list read shows it active, and drops one that closed", async () => {
    const { venue, http, feed } = await listed();
    feed.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    http.respond(() => listPage([ladderRow([strikeRow("0.82", 0, { status: "settled", marketState: "closed" }), strikeRow("0.84", 1)])]));
    await drive(venue.listEvents(), 20_000);
    await drive(venue.listEvents(), 1_000);

    expect(feed.streams("SUBSCRIBE").at(-1)).toEqual([`${HIGH}@bookTicker`]);
    expect(feed.streams("UNSUBSCRIBE")).toEqual([[`${LOW}@bookTicker`]]);
    expect(venue.liveTop(LOW)).toBeUndefined();
    feed.serverFrame(ticker(HIGH, ["0.0200", "8.34"], null));
    expect(venue.liveTop(HIGH)?.top).toEqual({ bidPx: 200n, bidUnits: 834n, askPx: null, askUnits: 0n });
  });

  it("serves nothing after the public socket is lost, until the next list read has subscribed again", async () => {
    const lines: string[] = [];
    const { venue, feed } = await listed({ log: (line) => lines.push(line) });
    feed.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    feed.serverClose(1006);
    expect(venue.liveTop(LOW)).toBeUndefined();
    expect(lines).toEqual(["market data socket closed: closed"]);
    // Orders do not depend on it.
    expect(venue.connected).toBe(true);

    await vi.advanceTimersByTimeAsync(20_000);
    FakeWebSocket.snapshots.set(`${LOW}@bookTicker`, ticker(LOW, ["0.0200", "8.34"], null));
    await drive(venue.listEvents(), 1_000);
    expect(FakeWebSocket.publicSockets()).toHaveLength(2);
    expect(venue.liveTop(LOW)?.top).toEqual({ bidPx: 200n, bidUnits: 834n, askPx: null, askUnits: 0n });
  });

  it("close() closes both sockets", async () => {
    const { venue, feed, ws } = await listed();
    feed.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    venue.close();
    expect([ws.readyState, feed.readyState]).toEqual([3, 3]);
    expect(venue.liveTop(LOW)).toBeUndefined();
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

  // For its first minutes as an instrument the book route answers "not a valid symbol" for an
  // active contract on about half the calls, while the socket has its book from the first second.
  it("reads the book of an active contract over the public socket when the book route does not know it yet", async () => {
    const { venue, http, feed } = await listed();
    http.respond(() => unknownSymbol(LOW));
    FakeWebSocket.answer = (message) =>
      message.method === "depth" ? { status: 200, result: { lastUpdateId: "1793265913744426", bids: [["0.8800", "11.00"]], asks: [["0.9700", "21.00"]] } } : undefined;

    await expect(drive(venue.topOfBook(LOW), 1_000)).resolves.toEqual({ bidPx: 8_800n, bidUnits: 1_100n, askPx: 9_700n, askUnits: 2_100n });
    expect(http.calls.map((call) => call.path)).toEqual([`/v1/book/${LOW}`]);
    expect(feed.sent.at(-1)).toMatchObject({ method: "depth", params: { symbol: LOW, limit: 1 } });

    // A side the socket reports as empty is empty: that is the book, read now.
    FakeWebSocket.answer = () => ({ status: 200, result: { lastUpdateId: "1793265913744427", bids: [], asks: [["0.9700", "21.00"]] } });
    await expect(drive(venue.topOfBook(LOW), 1_000)).resolves.toEqual({ bidPx: null, bidUnits: 0n, askPx: 9_700n, askUnits: 2_100n });
  });

  // For its first minutes the book route can also answer an active contract with an empty book.
  it("takes the streamed top over an empty book read, and believes an empty book only when nothing is streamed", async () => {
    const { venue, http, feed } = await listed();
    http.respond(() => ({ bids: [], asks: [] }));
    feed.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    await expect(drive(venue.topOfBook(LOW), 1_000)).resolves.toEqual({ bidPx: 300n, bidUnits: 3_300n, askPx: 900n, askUnits: 1_000n });
    await expect(drive(venue.topOfBook(HIGH), 1_000)).resolves.toEqual({ bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n });
  });

  it("fails, for the caller to try again, when the socket cannot answer either: it never reports an empty book", async () => {
    const { venue, http, feed } = await listed();
    http.respond(() => unknownSymbol(LOW));

    // No answer from the socket within three seconds.
    const silent = venue.topOfBook(LOW).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(String(await silent)).toContain("no ack for depth");

    FakeWebSocket.answer = () => ({ status: 400, error: { code: -1013, msg: `Unknown symbol: ${LOW}` } });
    await expect(drive(venue.topOfBook(LOW), 1_000)).rejects.toThrow(`the book of ${LOW} was refused with status 400`);

    feed.serverClose(1006);
    await expect(drive(venue.topOfBook(LOW), 1_000)).rejects.toThrow(`no market data connection to read the book of ${LOW}`);
  });

  it("passes the refusal on for a contract that is not active: one only listed, or one no list has shown", async () => {
    const { venue, http, feed } = await listed();
    FakeWebSocket.answer = () => ({ status: 200, result: { bids: [], asks: [] } });
    for (const symbol of [HIGH, SYMBOL]) {
      http.respond(() => unknownSymbol(symbol));
      await expect(drive(venue.topOfBook(symbol), 1_000)).rejects.toThrow(`HTTP 400 from GET /v1/book/${symbol}`);
    }
    expect(feed.sent.filter((message) => message.method === "depth")).toEqual([]);

    // Any other refusal of an active contract's book is passed on too.
    http.respond(() => new Response('{"result":"error","reason":"Bad Request","message":"Invalid limit"}', { status: 400 }));
    await expect(drive(venue.topOfBook(LOW), 1_000)).rejects.toThrow(`HTTP 400 from GET /v1/book/${LOW}`);
    expect(feed.sent.filter((message) => message.method === "depth")).toEqual([]);
  });

  it("reads depth the same way, and answers no levels only for a contract that is not active", async () => {
    const { venue, http } = await listed();
    FakeWebSocket.answer = (message) =>
      message.method === "depth" ? { status: 200, result: { bids: [["0.8800", "11.00"], ["0.8600", "11.00"]], asks: [["0.9700", "21.00"]] } } : undefined;
    http.respond(() => unknownSymbol(LOW));
    await expect(drive(venue.depth(LOW, 10), 1_000)).resolves.toEqual({
      bids: [
        { px: 8_800n, units: 1_100n },
        { px: 8_600n, units: 1_100n },
      ],
      asks: [{ px: 9_700n, units: 2_100n }],
    });
    http.respond(() => unknownSymbol(HIGH));
    await expect(drive(venue.depth(HIGH, 10), 1_000)).resolves.toEqual({ bids: [], asks: [] });

    FakeWebSocket.answer = () => ({ status: 400, error: { code: -1013, msg: `Unknown symbol: ${LOW}` } });
    http.respond(() => unknownSymbol(LOW));
    await expect(drive(venue.depth(LOW, 10), 1_000)).rejects.toThrow(`the book of ${LOW} was refused with status 400`);
  });
});

describe("depth, trades and history", () => {
  it("reads the levels of each side of the book", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({
      bids: [
        { price: "0.03", amount: "33.0", timestamp: "1794693211" },
        { price: "0.02", amount: "11.0", timestamp: "1794693211" },
      ],
      asks: [{ price: "0.1", amount: "21.89", timestamp: "1794693211" }],
    }));
    await expect(drive(venue.depth(SYMBOL, 10), 1_000)).resolves.toEqual({
      bids: [
        { px: 300n, units: 3_300n },
        { px: 200n, units: 1_100n },
      ],
      asks: [{ px: 1_000n, units: 2_189n }],
    });
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `/v1/book/${SYMBOL}`, query: "?limit_bids=10&limit_asks=10", payload: null });
  });

  it("answers an empty book, and a contract that is not an instrument yet, with no levels", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ bids: [], asks: [] }));
    await expect(drive(venue.depth(SYMBOL, 10), 1_000)).resolves.toEqual({ bids: [], asks: [] });
    http.respond(() => unknownSymbol(SYMBOL));
    await expect(drive(venue.depth(SYMBOL, 10), 1_000)).resolves.toEqual({ bids: [], asks: [] });
    expect(http.calls).toHaveLength(2);
  });

  it("answers display reads empty without a venue call while order reads wait in the public queue", async () => {
    const { venue, http } = await connected();
    http.respond(() => ({ bids: [{ price: "0.03", amount: "1" }], asks: [{ price: "0.17", amount: "1" }] }));
    // Six order reads: the first goes out at once, five wait a second apart.
    const orderReads = [1, 2, 3, 4, 5, 6].map(() => venue.topOfBook(SYMBOL));
    await expect(venue.depth(SYMBOL, 10)).resolves.toEqual({ bids: [], asks: [] });
    await expect(venue.trades(SYMBOL, 50)).resolves.toEqual([]);
    await expect(venue.history(SYMBOL, 60)).resolves.toEqual([]);
    await drive(Promise.all(orderReads), 6_000);
    expect(http.calls.map((call) => call.path)).toEqual(Array(6).fill(`/v1/book/${SYMBOL}`));
  });

  it("never asks the venue for a whole book: zero levels would mean all of them", async () => {
    const { venue, http } = await connected();
    await expect(venue.depth(SYMBOL, 0)).rejects.toThrow(RangeError);
    await expect(venue.depth(SYMBOL, 2.5)).rejects.toThrow(RangeError);
    await expect(venue.trades(SYMBOL, 0)).rejects.toThrow(RangeError);
    expect(http.calls).toEqual([]);
  });

  it("reads the most recent trades, newest first", async () => {
    const { venue, http } = await connected();
    // The trade id is a bare integer of 16 digits on the wire.
    const tape = '[{"timestamp":1794693909,"timestampms":1794693909020,"tid":1893456305647143,"price":"0.17","amount":"1","exchange":"demo","type":"buy"},{"timestamp":1794693904,"timestampms":1794693904893,"tid":1893456305647139,"price":"0.03","amount":"22.89","exchange":"demo","type":"sell"}]';
    http.respond(() => new Response(tape, { status: 200 }));
    await expect(drive(venue.trades(SYMBOL, 50), 1_000)).resolves.toEqual([
      { id: "1893456305647143", atMs: 1794693909020, px: 1_700n, units: 100n, taker: "buy" },
      { id: "1893456305647139", atMs: 1794693904893, px: 300n, units: 2_289n, taker: "sell" },
    ]);
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `/v1/trades/${SYMBOL}`, query: "?limit_trades=50", payload: null });
  });

  it("asks for at most 500 trades and returns at most the number asked for", async () => {
    const { venue, http } = await connected();
    const trade = (index: number): Row => ({ timestampms: 1794693909020 - index, tid: 7_000 - index, price: "0.17", amount: "1", type: "buy" });
    http.respond(() => [trade(0), trade(1), trade(2)]);
    await expect(drive(venue.trades(SYMBOL, 2), 1_000)).resolves.toHaveLength(2);
    await drive(venue.trades(SYMBOL, 5_000), 1_000);
    expect(http.calls.map((call) => call.query)).toEqual(["?limit_trades=2", "?limit_trades=500"]);
  });

  it("answers an empty tape, and a contract the venue does not know yet, with no trades", async () => {
    const { venue, http } = await connected();
    http.respond(() => []);
    await expect(drive(venue.trades(SYMBOL, 50), 1_000)).resolves.toEqual([]);
    http.respond(() => unknownSymbol(SYMBOL));
    await expect(drive(venue.trades(SYMBOL, 50), 1_000)).resolves.toEqual([]);
  });

  it.each([
    [60, "1m"],
    [300, "5m"],
    [900, "15m"],
    [1_800, "30m"],
    [3_600, "1hr"],
    [21_600, "6hr"],
    [86_400, "1day"],
  ])("reads the closing prices of %i-second candles, oldest first", async (stepSecs, frame) => {
    const { venue, http } = await connected();
    http.respond(() => [
      [1794693900000, 0.16, 0.17, 0.02, 0.17, 47.78],
      [1794693840000, 0.16, 0.16, 0.16, 0.16, 0],
    ]);
    await expect(drive(venue.history(SYMBOL, stepSecs), 1_000)).resolves.toEqual([
      { atMs: 1794693840000, px: 1_600n },
      { atMs: 1794693900000, px: 1_700n },
    ]);
    expect(http.calls[0]).toMatchObject({ method: "GET", path: `/v2/candles/${SYMBOL}/${frame}`, query: "", payload: null });
  });

  it("answers a contract that never traded, and one the venue does not know yet, with an empty history", async () => {
    const { venue, http } = await connected();
    http.respond(() => new Response('{"result":"error","reason":"NoDataFound","message":"Candles are empty for given symbol or time_frame"}', { status: 400 }));
    await expect(drive(venue.history(SYMBOL, 60), 1_000)).resolves.toEqual([]);
    // This route answers an unknown symbol in plain text.
    http.respond(() => unknownSymbol(SYMBOL, false));
    await expect(drive(venue.history(SYMBOL, 60), 1_000)).resolves.toEqual([]);
    expect(http.calls).toHaveLength(2);
  });

  it("rejects a step the venue has no candles for, without asking", async () => {
    const { venue, http } = await connected();
    await expect(venue.history(SYMBOL, 120)).rejects.toThrow("no candles of 120 seconds");
    expect(http.calls).toEqual([]);
  });

  it("passes any other refusal on as an error", async () => {
    const { venue, http } = await connected();
    http.respond(() => new Response('{"result":"error","reason":"InvalidParameterValue","message":"time_frame expects one of the following"}', { status: 400 }));
    await expect(drive(venue.history(SYMBOL, 60), 1_000)).rejects.toThrow(`HTTP 400 from GET /v2/candles/${SYMBOL}/1m`);
    http.respond(() => new Response('{"result":"error","reason":"BadRequest","message":"Invalid `limit_trades` parameter"}', { status: 400 }));
    await expect(drive(venue.trades(SYMBOL, 50), 1_000)).rejects.toThrow(`HTTP 400 from GET /v1/trades/${SYMBOL}`);
    await expect(drive(venue.depth(SYMBOL, 10), 1_000)).rejects.toThrow(`HTTP 400 from GET /v1/book/${SYMBOL}`);
  });

  it("sends every public read through one queue, a second apart", async () => {
    const { venue, http } = await connected();
    http.respond((call) => {
      if (call.path === EVENTS) return listPage([eventRow()]);
      if (call.path.startsWith(EVENTS)) return eventRow();
      if (call.path.startsWith("/v1/book")) return { bids: [], asks: [] };
      return [];
    });
    await drive(Promise.all([venue.depth(SYMBOL, 10), venue.trades(SYMBOL, 50), venue.history(SYMBOL, 60), venue.listEvents(), venue.contract(SYMBOL), venue.topOfBook(SYMBOL)]), 10_000);
    expect(http.calls.map((call) => call.at - http.calls[0]!.at)).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000]);
    expect(http.calls.every((call) => call.payload === null)).toBe(true);
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
