import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VenueFrame } from "../src/venue/frames.ts";
import { RequestTimeoutError, SocketClosedError, openPrivateSocket } from "../src/venue/gemini/socket.ts";
import type { CloseInfo, PrivateSocketOptions } from "../src/venue/gemini/socket.ts";

const URL = "wss://ws.sandbox.gemini.com";
const API_KEY = "account-TESTKEY";
const API_SECRET = "test-secret";
const START_MS = 1_794_624_000_250;

/** Stands in for the `ws` client: records what is sent and lets a test play the server. */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly headers: Record<string, string>;
  readyState = 0;
  sent: string[] = [];
  terminated = false;

  constructor(url: string, options: { headers: Record<string, string> }) {
    super();
    this.url = url;
    this.headers = options.headers;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this.sent.push(data);
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  close(): void {
    this.serverClose(1005);
  }

  serverOpen(): void {
    this.readyState = 1;
    this.emit("open");
  }

  /** Text frames reach `ws` listeners as a Buffer. */
  serverFrame(value: unknown): void {
    this.emit("message", Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), false);
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(""));
  }
}

interface Harness {
  frames: string[];
  messages: VenueFrame[];
  closes: CloseInfo[];
  options: PrivateSocketOptions;
}

function harness(extra: Partial<PrivateSocketOptions> = {}): Harness {
  const frames: string[] = [];
  const messages: VenueFrame[] = [];
  const closes: CloseInfo[] = [];
  return {
    frames,
    messages,
    closes,
    options: {
      url: URL,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      WebSocketImpl: FakeWebSocket,
      onFrame: (raw) => frames.push(raw),
      onMessage: (frame) => messages.push(frame),
      onClose: (info) => closes.push(info),
      ...extra,
    },
  };
}

/** Opens a socket and plays the server side of the upgrade. */
async function opened(extra: Partial<PrivateSocketOptions> = {}) {
  const h = harness(extra);
  const pending = openPrivateSocket(h.options);
  await vi.advanceTimersByTimeAsync(0);
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.serverOpen();
  return { ...h, ws, socket: await pending };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openPrivateSocket: upgrade", () => {
  it.each(["wss://ws.gemini.com", "wss://ws.sandbox.gemini.com/", "ws://ws.sandbox.gemini.com", ""])(
    "refuses the url %j",
    async (url) => {
      await expect(openPrivateSocket(harness({ url }).options)).rejects.toThrow("this build is sandbox only");
      expect(FakeWebSocket.instances).toHaveLength(0);
    },
  );

  it("sends exactly the four signed upgrade headers", async () => {
    const { ws } = await opened();
    const nonce = "1794624000";
    const payload = Buffer.from(nonce).toString("base64");

    expect(ws.url).toBe(URL);
    expect(ws.headers).toEqual({
      "X-GEMINI-APIKEY": API_KEY,
      "X-GEMINI-NONCE": nonce,
      "X-GEMINI-PAYLOAD": payload,
      "X-GEMINI-SIGNATURE": createHmac("sha384", API_SECRET).update(payload).digest("hex"),
    });
  });

  it("awaits beforeConnect and takes the nonce after it", async () => {
    let release!: () => void;
    const h = harness({ beforeConnect: () => new Promise<void>((resolve) => (release = resolve)) });
    const pending = openPrivateSocket(h.options);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeWebSocket.instances).toHaveLength(0);

    release();
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.headers["X-GEMINI-NONCE"]).toBe("1794624003");
    ws.serverOpen();
    await expect(pending).resolves.toMatchObject({ isOpen: true });
  });

  it("rejects when the upgrade fails, without calling onClose", async () => {
    const h = harness();
    const pending = openPrivateSocket(h.options);
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0]!.emit("unexpected-response", {}, { statusCode: 401 });

    expect(await outcome).toBeInstanceOf(SocketClosedError);
    expect(((await outcome) as Error).message).toBe("socket upgrade failed: HTTP 401");
    expect(FakeWebSocket.instances[0]!.terminated).toBe(true);
    expect(h.closes).toEqual([]);
  });

  it("gives up and terminates when the socket does not open in time", async () => {
    const h = harness({ openTimeoutMs: 4_000 });
    const outcome = openPrivateSocket(h.options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(((await outcome) as Error).message).toBe("socket did not open within 4000 ms");
    expect(FakeWebSocket.instances[0]!.terminated).toBe(true);
  });
});

describe("frames", () => {
  it("hands every raw frame to onFrame as a string before parsing, including a Buffer and malformed text", async () => {
    const { ws, frames, messages } = await opened();
    const order: string[] = [];
    const h = { frames, messages };
    ws.emit("message", Buffer.from('{"e":"balanceUpdate","B":[{"a":"USD","f":"1.00","c":"1.00"}]}'), false);
    ws.emit("message", [Buffer.from('{"id":"77",'), Buffer.from('"status":200}')], false);
    ws.emit("message", "not json", false);
    order.push(...h.frames);

    expect(order).toEqual(['{"e":"balanceUpdate","B":[{"a":"USD","f":"1.00","c":"1.00"}]}', '{"id":"77","status":200}', "not json"]);
    expect(frames.every((raw) => typeof raw === "string")).toBe(true);
    expect(messages).toEqual([
      { kind: "balanceUpdate", balances: [{ asset: "USD", free: "1.00", current: "1.00" }] },
      { kind: "ack", id: "77", status: 200 },
      { kind: "malformed", raw: "not json" },
    ]);
  });

  it("calls onFrame before onMessage for the same frame", async () => {
    const seen: string[] = [];
    const { ws } = await opened({ onFrame: () => seen.push("raw"), onMessage: () => seen.push("parsed") });
    ws.serverFrame({ id: "9", status: 200 });
    expect(seen).toEqual(["raw", "parsed"]);
  });
});

describe("request", () => {
  it("sends { id, method, params } and resolves with the ack carrying that id, whatever arrives in between", async () => {
    const { ws, socket } = await opened();
    const first = socket.request("SUBSCRIBE", ["orders@account"]);
    const second = socket.request("SUBSCRIBE", ["positions@account"]);

    expect(ws.sent.map((raw) => JSON.parse(raw))).toEqual([
      { id: "1", method: "SUBSCRIBE", params: ["orders@account"] },
      { id: "2", method: "SUBSCRIBE", params: ["positions@account"] },
    ]);

    // Snapshots arrive before the acks, and the acks out of order.
    ws.serverFrame({ e: "positionReport", A: 1, P: [] });
    ws.serverFrame({ id: "2", status: 200 });
    ws.serverFrame({ e: "balanceUpdate", B: [] });
    ws.serverFrame({ id: "1", status: 400, error: { code: -1013, msg: "limit price is out of range" } });

    await expect(second).resolves.toEqual({ kind: "ack", id: "2", status: 200 });
    await expect(first).resolves.toEqual({
      kind: "ack",
      id: "1",
      status: 400,
      error: { code: -1013, msg: "limit price is out of range" },
    });
  });

  it("keeps an 18-digit order id in the ack result as a string", async () => {
    const { ws, socket } = await opened();
    const pending = socket.request("order.place", { symbol: "DEMO-BTC15M-UP" });
    ws.serverFrame('{"id":"1","status":200,"result":{"orderId":700000000000000001,"status":"NEW"}}');
    await expect(pending).resolves.toMatchObject({ result: { orderId: "700000000000000001", status: "NEW" } });
  });

  it("omits params when none are given", async () => {
    const { ws, socket } = await opened();
    void socket.request("conninfo").catch(() => {});
    expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "1", method: "conninfo" });
  });

  it("rejects after the timeout (default 10 s) and ignores a late ack", async () => {
    const { ws, socket } = await opened();
    const outcome = socket.request("SUBSCRIBE", ["orders@account"]).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(9_999);
    ws.serverFrame({ e: "balanceUpdate", B: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
    expect(((await outcome) as Error).message).toBe("no ack for SUBSCRIBE (id 1) within 10000 ms");
    expect(() => ws.serverFrame({ id: "1", status: 200 })).not.toThrow();
  });

  it("honours a per-request timeout", async () => {
    const { socket } = await opened();
    const outcome = socket.request("order.place", {}, 2_000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toBeInstanceOf(RequestTimeoutError);
  });

  it("rejects when the send itself fails", async () => {
    const { ws, socket } = await opened();
    ws.send = () => {
      throw new Error("write EPIPE");
    };
    await expect(socket.request("SUBSCRIBE", ["orders@account"])).rejects.toThrow("write EPIPE");
  });
});

describe("close handling", () => {
  it("reports a server close once and rejects every pending request immediately", async () => {
    const { ws, socket, closes } = await opened();
    const first = socket.request("SUBSCRIBE", ["orders@account"]).catch((error: unknown) => error);
    const second = socket.request("order.place", {}).catch((error: unknown) => error);
    ws.serverClose(1006);
    ws.serverClose(1006);

    expect(await first).toBeInstanceOf(SocketClosedError);
    expect(await second).toBeInstanceOf(SocketClosedError);
    expect(closes).toEqual([{ reason: "closed", code: 1006 }]);
    expect(socket.isOpen).toBe(false);
  });

  it("rejects a request made after the socket closed and sends nothing", async () => {
    const { ws, socket } = await opened();
    ws.serverClose(1006);
    await expect(socket.request("order.place", {})).rejects.toBeInstanceOf(SocketClosedError);
    expect(ws.sent).toEqual([]);
  });

  it("reports an error event as a close and terminates the socket", async () => {
    const { ws, closes } = await opened();
    ws.emit("error", new Error("read ECONNRESET"));
    expect(closes).toEqual([{ reason: "error", detail: "read ECONNRESET" }]);
    expect(ws.terminated).toBe(true);
  });

  it("close() closes the socket and reports it", async () => {
    const { socket, closes } = await opened();
    socket.close();
    expect(closes).toEqual([{ reason: "closed", code: 1005 }]);
    expect(socket.isOpen).toBe(false);
  });
});

describe("liveness watchdog", () => {
  it("stays alive while frames or pings keep arriving", async () => {
    const { ws, closes } = await opened();
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(40_000);
      if (i % 2 === 0) ws.emit("ping", Buffer.from("7d0f0f4e"));
      else ws.serverFrame({ e: "balanceUpdate", B: [] });
    }
    expect(closes).toEqual([]);
    expect(ws.terminated).toBe(false);
  });

  it("terminates and reports liveness when nothing arrives for 60 s, rejecting pending requests", async () => {
    const { ws, socket, closes } = await opened({ requestTimeoutMs: 300_000 });
    ws.emit("ping", Buffer.from("7d0f0f4e"));
    await vi.advanceTimersByTimeAsync(30_000);
    const pending = socket.request("order.place", {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(closes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminated).toBe(true);
    expect(closes).toEqual([{ reason: "liveness" }]);
    expect(await pending).toBeInstanceOf(SocketClosedError);
    expect(socket.isOpen).toBe(false);

    // The close event that follows terminate() is not reported a second time.
    ws.serverClose(1006);
    expect(closes).toEqual([{ reason: "liveness" }]);
  });

  it("uses the configured timeout and stops watching after a close", async () => {
    const { ws, closes } = await opened({ livenessTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    ws.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closes).toEqual([{ reason: "closed", code: 1000 }]);
    expect(ws.terminated).toBe(false);
  });
});
