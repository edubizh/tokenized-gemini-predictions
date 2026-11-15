import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketFeed } from "../src/venue/gemini/feed.ts";
import { FakeWebSocket, LADDER, START_MS, SYMBOL } from "./gemini-fakes.ts";

const URL = "wss://ws.sandbox.gemini.com";
const EXPIRY = new Date("2026-11-14T03:00:00.000Z");
const LOW = `GEMI-${LADDER}-HI0D82`;
const HIGH = `GEMI-${LADDER}-HI0D84`;

function listed(symbol: string, status = "active", expiresAt = EXPIRY) {
  return { symbol, status, expiresAt };
}

function started() {
  const lines: string[] = [];
  const feed = new MarketFeed({ url: URL, WebSocketImpl: FakeWebSocket, now: Date.now, log: (line) => lines.push(line) });
  return { feed, lines };
}

/** Hands a list read to the feed and lets it finish connecting and subscribing. */
async function follow(feed: MarketFeed, contracts: Array<ReturnType<typeof listed>>): Promise<FakeWebSocket> {
  feed.follow(contracts);
  await vi.advanceTimersByTimeAsync(0);
  return FakeWebSocket.instances.at(-1)!;
}

/** A book ticker frame: lower-case symbol, no event name, long bare integers, "" for an empty side. */
function ticker(symbol: string, bid: [price: string, size: string] | null, ask: [price: string, size: string] | null): string {
  const [b, B] = bid ?? ["", ""];
  const [a, A] = ask ?? ["", ""];
  return `{"u":1793265913394827,"E":1794693166237111319,"s":"${symbol.toLowerCase()}","b":"${b}","B":"${B}","a":"${a}","A":"${A}"}`;
}

function status(symbol: string, from: string, to: string): string {
  return JSON.stringify({ e: "contractStatus", E: 1794693600766, s: symbol.toLowerCase(), k: "demo", c: "UP", i: 700001, o: from, n: to });
}

const QUOTE = { bidPx: 300n, bidUnits: 3_300n, askPx: 900n, askUnits: 1_000n };

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
  vi.setSystemTime(START_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscriptions", () => {
  it("opens one connection without credentials and subscribes the status stream, then the active contracts in batches of 80", async () => {
    const { feed } = started();
    const active = Array.from({ length: 170 }, (_unused, index) => listed(`GEMI-DEMO2611140300-HI${index}`));
    const ws = await follow(feed, [...active, listed(LOW, "approved"), listed(HIGH, "settled")]);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.headers).toEqual({});
    const sent = ws.streams("SUBSCRIBE");
    expect(sent.map((streams) => streams.length)).toEqual([1, 80, 80, 10]);
    expect(sent[0]).toEqual(["contractStatus"]);
    expect(sent[1]![0]).toBe("GEMI-DEMO2611140300-HI0@bookTicker");
    expect(sent.flat()).toHaveLength(171);
    expect(sent.flat()).not.toContain(`${LOW}@bookTicker`);
    expect(feed.follows("GEMI-DEMO2611140300-HI169")).toBe(true);
    expect(feed.follows(LOW)).toBe(false);
  });

  it("opens no connection while nothing is active", async () => {
    const { feed } = started();
    await follow(feed, [listed(LOW, "approved")]);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("subscribes a newly active contract at the next list read, and nothing twice", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW, "approved")]);
    await follow(feed, [listed(SYMBOL), listed(LOW)]);
    await follow(feed, [listed(SYMBOL), listed(LOW)]);
    expect(ws.streams("SUBSCRIBE")).toEqual([["contractStatus"], [`${SYMBOL}@bookTicker`], [`${LOW}@bookTicker`]]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("takes up a list read that arrives while it is still subscribing", async () => {
    const { feed } = started();
    feed.follow([listed(SYMBOL)]);
    feed.follow([listed(SYMBOL), listed(LOW)]);
    await vi.advanceTimersByTimeAsync(0);
    const ws = FakeWebSocket.instances[0]!;
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.streams("SUBSCRIBE").flat().sort()).toEqual([`${LOW}@bookTicker`, `${SYMBOL}@bookTicker`, "contractStatus"].sort());
  });

  it("subscribes the streams of a refused batch one by one and leaves out the one the venue does not know", async () => {
    const { feed, lines } = started();
    FakeWebSocket.unknownStreams.add(`${LOW}@bookTicker`);
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW), listed(HIGH)]);
    expect(ws.streams("SUBSCRIBE")).toEqual([
      ["contractStatus"],
      [`${SYMBOL}@bookTicker`, `${LOW}@bookTicker`, `${HIGH}@bookTicker`],
      [`${SYMBOL}@bookTicker`],
      [`${LOW}@bookTicker`],
      [`${HIGH}@bookTicker`],
    ]);
    expect(lines).toEqual([`market data socket: no book ticker for ${LOW}`]);

    // It is not asked for again on this connection, and the others are served.
    await follow(feed, [listed(SYMBOL), listed(LOW), listed(HIGH)]);
    expect(ws.streams("SUBSCRIBE")).toHaveLength(5);
    ws.serverFrame(ticker(HIGH, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    expect(feed.top(HIGH)?.top).toEqual(QUOTE);
    expect(lines).toHaveLength(1);
  });

  it("tries again at the next list read when the venue refuses a request for any other reason", async () => {
    const { feed, lines } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    FakeWebSocket.subscribeStatus = 429;
    await follow(feed, [listed(SYMBOL), listed(LOW), listed(HIGH)]);
    expect(lines).toEqual(["market data socket: subscription was refused with status 429"]);
    expect(ws.streams("SUBSCRIBE")).toHaveLength(3);

    FakeWebSocket.subscribeStatus = 200;
    await follow(feed, [listed(SYMBOL), listed(LOW), listed(HIGH)]);
    expect(ws.streams("SUBSCRIBE").at(-1)).toEqual([`${LOW}@bookTicker`, `${HIGH}@bookTicker`]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });
});

describe("top of book", () => {
  it("serves the top of a followed contract from the frames, as of now", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW)]);
    expect(feed.top(SYMBOL)).toBeUndefined();

    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    ws.serverFrame(ticker(LOW, null, null));
    expect(feed.top(SYMBOL)).toEqual({ top: QUOTE, atMs: START_MS });
    expect(feed.top(LOW)).toEqual({ top: { bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n }, atMs: START_MS });

    ws.serverFrame(ticker(SYMBOL, ["0.0200", "8.34"], null));
    expect(feed.top(SYMBOL)?.top).toEqual({ bidPx: 200n, bidUnits: 834n, askPx: null, askUnits: 0n });

    // The stream reports every change, so while it is connected the entry is the book as it is now.
    await vi.advanceTimersByTimeAsync(30_000);
    ws.emit("ping", Buffer.from("7d0f0f4e"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(feed.top(SYMBOL)?.atMs).toBe(START_MS + 45_000);
  });

  it("takes the book the venue sends for each stream as soon as it is subscribed, ahead of the ack", async () => {
    const { feed } = started();
    FakeWebSocket.snapshots.set(`${SYMBOL}@bookTicker`, ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    FakeWebSocket.snapshots.set(`${LOW}@bookTicker`, ticker(LOW, null, null));
    await follow(feed, [listed(SYMBOL), listed(LOW)]);
    expect(feed.top(SYMBOL)?.top).toEqual(QUOTE);
    expect(feed.top(LOW)?.top).toEqual({ bidPx: null, bidUnits: 0n, askPx: null, askUnits: 0n });
  });

  it("ignores frames of contracts it does not follow and frames that are not book tickers", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    ws.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    ws.serverFrame(`{"E":1794693402234502458,"s":"${SYMBOL.toLowerCase()}","t":1893456305647066,"p":"0.0300","q":"5.00","m":true}`);
    ws.serverFrame("not json");
    expect(feed.top(LOW)).toBeUndefined();
    expect(feed.top(SYMBOL)).toBeUndefined();
  });

  it("drops the entry when a frame says the book changed but cannot be read", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "many"], ["0.0900", "10.00"]));
    expect(feed.top(SYMBOL)).toBeUndefined();
  });
});

describe("a contract that stops being active", () => {
  it("is dropped at once when the status stream reports it, and unsubscribed at the next list read", async () => {
    const { feed } = started();
    const later = new Date("2026-11-14T04:00:00.000Z");
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW, "active", later)]);
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    ws.serverFrame(ticker(LOW, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    // The reference price of an up-or-down contract arrives as a change from Active to Active.
    ws.serverFrame(status(SYMBOL, "Active", "Active"));
    expect(feed.top(SYMBOL)?.top).toEqual(QUOTE);

    ws.serverFrame(status(SYMBOL, "Active", "Under Review"));
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(feed.follows(SYMBOL)).toBe(false);
    expect(feed.top(LOW)?.top).toEqual(QUOTE);
    // A late frame of the closed contract does not bring it back.
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));
    expect(feed.top(SYMBOL)).toBeUndefined();

    // The list is behind and still shows it as active.
    await follow(feed, [listed(SYMBOL), listed(LOW, "active", later)]);
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(feed.top(LOW)?.top).toEqual(QUOTE);

    vi.setSystemTime(EXPIRY.getTime() + 5_000);
    await follow(feed, [listed(LOW, "active", later)]);
    expect(ws.streams("UNSUBSCRIBE")).toEqual([[`${SYMBOL}@bookTicker`]]);
    expect(ws.streams("SUBSCRIBE")).toHaveLength(2);
  });

  it("is dropped at its expiry, whatever the list still says", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    vi.setSystemTime(EXPIRY.getTime() - 1);
    expect(feed.top(SYMBOL)?.top).toEqual(QUOTE);
    vi.setSystemTime(EXPIRY.getTime());
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(feed.follows(SYMBOL)).toBe(false);

    // A list page can be minutes old and still show it as active.
    await follow(feed, [listed(SYMBOL)]);
    expect(ws.streams("UNSUBSCRIBE")).toEqual([[`${SYMBOL}@bookTicker`]]);
    expect(feed.top(SYMBOL)).toBeUndefined();
  });

  it("is dropped when a list read shows it under review or settled", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW), listed(HIGH)]);
    for (const symbol of [SYMBOL, LOW, HIGH]) ws.serverFrame(ticker(symbol, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    await follow(feed, [listed(SYMBOL, "under_review"), listed(LOW, "settled"), listed(HIGH)]);
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(feed.top(LOW)).toBeUndefined();
    expect(feed.top(HIGH)?.top).toEqual(QUOTE);
    expect(ws.streams("UNSUBSCRIBE")).toEqual([[`${SYMBOL}@bookTicker`, `${LOW}@bookTicker`]]);
  });

  it("is kept when one list read misses it or shows an older state: list pages can be minutes old", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL), listed(LOW)]);
    for (const symbol of [SYMBOL, LOW]) ws.serverFrame(ticker(symbol, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    await follow(feed, [listed(LOW, "approved")]);
    expect(feed.top(SYMBOL)?.top).toEqual(QUOTE);
    expect(feed.top(LOW)?.top).toEqual(QUOTE);
    expect(ws.streams("UNSUBSCRIBE")).toEqual([]);
  });
});

describe("connection loss", () => {
  it("drops every entry when the connection is lost and subscribes everything again at the next list read", async () => {
    const { feed, lines } = started();
    const first = await follow(feed, [listed(SYMBOL), listed(LOW)]);
    for (const symbol of [SYMBOL, LOW]) first.serverFrame(ticker(symbol, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    first.serverClose(1006);
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(feed.top(LOW)).toBeUndefined();
    expect(lines).toEqual(["market data socket closed: closed"]);

    // It does not reconnect by itself.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.snapshots.set(`${SYMBOL}@bookTicker`, ticker(SYMBOL, ["0.0200", "8.34"], null));
    const second = await follow(feed, [listed(SYMBOL), listed(LOW)]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(second.streams("SUBSCRIBE")).toEqual([["contractStatus"], [`${SYMBOL}@bookTicker`, `${LOW}@bookTicker`]]);
    expect(feed.top(SYMBOL)?.top).toEqual({ bidPx: 200n, bidUnits: 834n, askPx: null, askUnits: 0n });
    expect(feed.top(LOW)).toBeUndefined();
  });

  it("drops every entry when the connection goes silent for a minute", async () => {
    const { feed, lines } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    await vi.advanceTimersByTimeAsync(59_999);
    expect(feed.top(SYMBOL)?.top).toEqual(QUOTE);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminated).toBe(true);
    expect(feed.top(SYMBOL)).toBeUndefined();
    expect(lines).toEqual(["market data socket closed: liveness"]);
  });

  it("makes one connection attempt per list read and says why one failed", async () => {
    const { feed, lines } = started();
    FakeWebSocket.refuseUpgrade = true;
    await follow(feed, [listed(SYMBOL)]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lines).toEqual(["market data socket: socket upgrade failed: HTTP 503"]);

    FakeWebSocket.refuseUpgrade = false;
    const ws = await follow(feed, [listed(SYMBOL)]);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(ws.streams("SUBSCRIBE")).toEqual([["contractStatus"], [`${SYMBOL}@bookTicker`]]);
  });

  it("gives up a connection whose status stream is refused or not answered", async () => {
    const { feed, lines } = started();
    FakeWebSocket.subscribeStatus = 400;
    const refused = await follow(feed, [listed(SYMBOL)]);
    expect(refused.readyState).toBe(3);
    expect(lines).toEqual(["market data socket: subscription to contractStatus was refused with status 400"]);
    expect(feed.top(SYMBOL)).toBeUndefined();

    FakeWebSocket.silent = true;
    const silent = await follow(feed, [listed(SYMBOL)]);
    expect(silent.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(silent.readyState).toBe(3);
    expect(lines).toEqual([lines[0], "market data socket: no ack for SUBSCRIBE (id 1) within 10000 ms"]);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("close() closes the connection for good", async () => {
    const { feed, lines } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    ws.serverFrame(ticker(SYMBOL, ["0.0300", "33.00"], ["0.0900", "10.00"]));

    feed.close();
    expect(ws.readyState).toBe(3);
    expect(feed.top(SYMBOL)).toBeUndefined();
    await follow(feed, [listed(SYMBOL)]);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});

describe("depth", () => {
  it("asks the socket for the book of a contract, now", async () => {
    const { feed } = started();
    const ws = await follow(feed, [listed(SYMBOL)]);
    FakeWebSocket.answer = (message) =>
      message.method === "depth" ? { status: 200, result: { lastUpdateId: "1793265913744426", bids: [["0.8800", "11.00"], ["0.8600", "11.00"]], asks: [["0.9700", "21.00"]] } } : undefined;

    await expect(feed.depth(SYMBOL, 2)).resolves.toEqual({
      bids: [
        { px: 8_800n, units: 1_100n },
        { px: 8_600n, units: 1_100n },
      ],
      asks: [{ px: 9_700n, units: 2_100n }],
    });
    expect(ws.sent.at(-1)).toMatchObject({ method: "depth", params: { symbol: SYMBOL, limit: 2 } });
  });

  it("rejects when the socket cannot answer: not connected, refused, or silent for three seconds", async () => {
    const { feed } = started();
    await expect(feed.depth(SYMBOL, 1)).rejects.toThrow(`no market data connection to read the book of ${SYMBOL}`);

    const ws = await follow(feed, [listed(SYMBOL)]);
    FakeWebSocket.answer = () => ({ status: 400, error: { code: -1013, msg: `Unknown symbol: ${SYMBOL}` } });
    await expect(feed.depth(SYMBOL, 1)).rejects.toThrow(`the book of ${SYMBOL} was refused with status 400`);

    FakeWebSocket.answer = () => undefined;
    const silent = feed.depth(SYMBOL, 1).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(String(await silent)).toContain("no ack for depth");

    ws.serverClose(1006);
    await expect(feed.depth(SYMBOL, 1)).rejects.toThrow("no market data connection");
  });
});
