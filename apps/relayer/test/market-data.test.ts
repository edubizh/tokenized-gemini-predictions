import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarketData } from "../src/api/market-data.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { eventOf } from "./helpers/events.ts";

// A synthetic 15-minute contract, window 02:45 to 03:00; the clock starts at 02:50.
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const NOW = Date.parse("2026-11-14T02:50:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BTC = "TEST-BTC15M2611140300-UP";
const ETH = "TEST-ETH15M2611140300-UP";

function info(symbol: string, overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    symbol,
    eventTicker: symbol.split("-")[1]!,
    status: "active",
    marketState: "open",
    effectiveAt: new Date(EFFECTIVE),
    expiresAt: new Date(EXPIRY),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
    ...overrides,
  };
}

const registries: Registry[] = [];
afterEach(() => {
  while (registries.length > 0) registries.pop()?.close();
});

/** The BTC and ETH contracts in the registry and at the venue; BTC has a book and three trades. */
async function world() {
  const clock = { ms: NOW };
  const venue = new MockVenue({ now: () => clock.ms });
  const registry = openRegistry(":memory:");
  registries.push(registry);
  /** Lists a contract at the venue and in the registry. */
  const list = (contract: ContractInfo) => {
    venue.addContract(contract);
    registry.storeEvents([eventOf([contract])], clock.ms);
  };
  list(info(BTC));
  list(info(ETH));
  venue.setCash(1_000_000_000n);
  venue.setBook(BTC, { bids: [[4_000n, 500n], [3_900n, 800n]], asks: [[4_500n, 700n], [4_600n, 900n]] });
  const buy = (clientOrderId: string, units: bigint) => venue.placeOrder({ clientOrderId, symbol: BTC, outcome: "YES", units, limitPx: 4_500n, timeInForce: "FOK" });
  await buy("a", 100n);
  clock.ms += 30_000;
  await buy("b", 200n);
  clock.ms += 60_000;
  await venue.placeOrder({ clientOrderId: "c", symbol: BTC, outcome: "NO", units: 50n, limitPx: 6_000n, timeInForce: "FOK" });
  const data = createMarketData({ venue, registry, now: () => clock.ms });
  const calls = { depth: vi.spyOn(venue, "depth"), trades: vi.spyOn(venue, "trades"), history: vi.spyOn(venue, "history") };
  return { venue, registry, clock, data, calls, list };
}

describe("depth", () => {
  it("answers with ten levels a side in the API's shape and the time of the read", async () => {
    const { data, calls, clock } = await world();
    expect(await data.depth(BTC)).toEqual({
      bids: [{ px: "4000", units: "450" }, { px: "3900", units: "800" }],
      asks: [{ px: "4500", units: "400" }, { px: "4600", units: "900" }],
      at: clock.ms,
    });
    expect(calls.depth).toHaveBeenCalledExactlyOnceWith(BTC, 10);
    expect(await data.depth(ETH)).toEqual({ bids: [], asks: [], at: clock.ms });
  });

  it("keeps an answer for three seconds per symbol and shares it between callers", async () => {
    const { venue, data, calls, clock } = await world();
    const [first, second] = await Promise.all([data.depth(BTC), data.depth(BTC)]);
    expect(second).toBe(first);
    expect(calls.depth).toHaveBeenCalledTimes(1);

    venue.setBook(BTC, { bids: [], asks: [[4_700n, 100n]] });
    clock.ms += 2_999;
    expect(await data.depth(BTC)).toBe(first);
    await data.depth(ETH); // another symbol has an answer of its own
    expect(calls.depth).toHaveBeenCalledTimes(2);

    clock.ms += 1;
    expect(await data.depth(BTC)).toEqual({ bids: [], asks: [{ px: "4700", units: "100" }], at: clock.ms });
    expect(calls.depth).toHaveBeenCalledTimes(3);
  });

  it("counts the three seconds from the answer, and one slow read serves everyone who asked meanwhile", async () => {
    const { data, calls, clock } = await world();
    let release: () => void = () => {};
    calls.depth.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return { bids: [{ px: 4_000n, units: 1n }], asks: [] };
    });
    const early = data.depth(BTC);
    clock.ms += 5_000; // the venue's queue was long
    const late = data.depth(BTC);
    release();
    expect(await late).toEqual({ bids: [{ px: "4000", units: "1" }], asks: [], at: NOW + 95_000 });
    expect(await early).toBe(await late);
    clock.ms += 2_999;
    await data.depth(BTC);
    expect(calls.depth).toHaveBeenCalledTimes(1);
  });

  it("does not keep a read that failed: the next caller asks the venue again", async () => {
    const { data, calls } = await world();
    calls.depth.mockRejectedValueOnce(new Error("book unavailable"));
    await expect(data.depth(BTC)).rejects.toThrow("book unavailable");
    expect(await data.depth(BTC)).toMatchObject({ bids: [{ px: "4000" }, { px: "3900" }] });
    expect(calls.depth).toHaveBeenCalledTimes(2);
  });
});

describe("trades", () => {
  it("answers with the fifty most recent trades, newest first, kept for ten seconds", async () => {
    const { venue, data, calls, clock } = await world();
    const trades = await data.trades(BTC);
    expect(trades).toEqual([
      { id: expect.stringMatching(/^\d{16}$/), at: NOW + 90_000, px: "4000", units: "50", taker: "sell" },
      { id: expect.stringMatching(/^\d{16}$/), at: NOW + 30_000, px: "4500", units: "200", taker: "buy" },
      { id: expect.stringMatching(/^\d{16}$/), at: NOW, px: "4500", units: "100", taker: "buy" },
    ]);
    expect(calls.trades).toHaveBeenCalledExactlyOnceWith(BTC, 50);

    await venue.placeOrder({ clientOrderId: "d", symbol: BTC, outcome: "YES", units: 10n, limitPx: 4_500n, timeInForce: "FOK" });
    clock.ms += 9_999;
    expect(await data.trades(BTC)).toBe(trades);
    clock.ms += 1;
    expect(await data.trades(BTC)).toHaveLength(4);
    expect(calls.trades).toHaveBeenCalledTimes(2);
    expect(await data.trades(ETH)).toEqual([]);
  });
});

describe("history", () => {
  it("answers with the last trade price of each step, oldest first, kept for sixty seconds", async () => {
    const { data, calls, clock } = await world();
    const history = await data.history(BTC);
    expect(history).toEqual({
      stepSecs: 60,
      points: [
        { at: NOW, px: "4500" },
        { at: NOW + 60_000, px: "4000" },
      ],
    });
    expect(calls.history).toHaveBeenCalledExactlyOnceWith(BTC, 60);

    clock.ms += 59_999;
    expect(await data.history(BTC)).toBe(history);
    clock.ms += 1;
    expect((await data.history(BTC))?.points).toHaveLength(3);
    expect(calls.history).toHaveBeenCalledTimes(2);
    expect(await data.history(ETH)).toEqual({ stepSecs: 60, points: [] }); // never traded
  });

  it("picks the step from how long the contract runs", async () => {
    const { data, calls, list } = await world();
    const lives: Array<[number, number]> = [
      [5 * MINUTE, 60],
      [2 * HOUR, 60],
      [2 * HOUR + 1, 900],
      [36 * HOUR, 900],
      [36 * HOUR + 1, 3_600],
      [10 * DAY, 3_600],
      [10 * DAY + 1, 21_600],
      [30 * DAY, 21_600],
    ];
    for (const [index, [lifeMs, stepSecs]] of lives.entries()) {
      const symbol = `TEST-LIFE${index}-UP`;
      list(info(symbol, { effectiveAt: new Date(EXPIRY - lifeMs) }));
      expect(await data.history(symbol)).toEqual({ stepSecs, points: [] });
      expect(calls.history).toHaveBeenLastCalledWith(symbol, stepSecs);
    }
  });
});

describe("contracts the venue has no data for", () => {
  it("answers undefined for a symbol the registry does not know, without asking the venue", async () => {
    const { venue, data, calls } = await world();
    venue.addContract(info("TEST-UNLISTED-UP")); // at the venue, but never listed to the relayer
    expect(await data.depth("TEST-UNLISTED-UP")).toBeUndefined();
    expect(await data.trades("TEST-UNLISTED-UP")).toBeUndefined();
    expect(await data.history("TEST-UNLISTED-UP")).toBeUndefined();
    expect(calls.depth).not.toHaveBeenCalled();
    expect(calls.trades).not.toHaveBeenCalled();
    expect(calls.history).not.toHaveBeenCalled();
  });

  it("answers empty for a contract that is not an instrument yet, without asking the venue", async () => {
    const { data, calls, clock, list } = await world();
    const hourly = { effectiveAt: new Date(EXPIRY), expiresAt: new Date(EXPIRY + HOUR) };
    list(info("TEST-BTC2611140400-HI64000", { status: "approved", marketState: "post_only", ...hourly }));
    expect(await data.depth("TEST-BTC2611140400-HI64000")).toEqual({ bids: [], asks: [], at: clock.ms });
    expect(await data.trades("TEST-BTC2611140400-HI64000")).toEqual([]);
    expect(await data.history("TEST-BTC2611140400-HI64000")).toEqual({ stepSecs: 60, points: [] });
    expect(calls.depth).not.toHaveBeenCalled();
    expect(calls.trades).not.toHaveBeenCalled();
    expect(calls.history).not.toHaveBeenCalled();

    // Once it trades, the venue is asked.
    list(info("TEST-BTC2611140400-HI64000", hourly));
    await data.depth("TEST-BTC2611140400-HI64000");
    expect(calls.depth).toHaveBeenCalledTimes(1);
  });

  it("answers empty for a contract that expired more than a day ago, without asking the venue", async () => {
    const { data, calls, clock } = await world();
    clock.ms = EXPIRY + DAY;
    expect((await data.trades(BTC))?.length).toBe(3); // a day after expiry the tape is still read
    expect(await data.history(BTC)).toMatchObject({ stepSecs: 60 });
    expect((await data.depth(BTC))?.bids).toHaveLength(2);

    clock.ms += 60_001; // every kept answer has aged out, and the day has passed
    expect(await data.depth(BTC)).toEqual({ bids: [], asks: [], at: clock.ms });
    expect(await data.trades(BTC)).toEqual([]);
    expect(await data.history(BTC)).toEqual({ stepSecs: 60, points: [] });
    expect(calls.depth).toHaveBeenCalledTimes(1);
    expect(calls.trades).toHaveBeenCalledTimes(1);
    expect(calls.history).toHaveBeenCalledTimes(1);
  });
});
