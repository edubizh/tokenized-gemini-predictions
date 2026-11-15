import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../src/journal.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import type { ContractInfo, EventInfo } from "../src/venue/venue.ts";
import { eventOf } from "./helpers/events.ts";

// Synthetic events and contracts in the shape the venue adapters produce.
const SYMBOL = "TEST-BTC15M2611140300-UP";
const TICKER = "BTC15M2611140300";
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const LISTED = Date.parse("2026-11-14T02:41:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function info(overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    symbol: SYMBOL,
    eventTicker: TICKER,
    status: "active",
    marketState: "open",
    effectiveAt: new Date(EFFECTIVE),
    expiresAt: new Date(EXPIRY),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
    label: "Up",
    sortOrder: 0,
    rules: "Resolves to Yes if the price is above the price at the start of the window.",
    strike: "64000.50",
    settlementValue: null,
    lastPx: null,
    ...overrides,
  };
}

function event(overrides: Partial<EventInfo> = {}): EventInfo {
  return eventOf([info()], {
    title: "BTC price at 3am",
    description: "Interval BTC price prediction event",
    source: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
    termsUrl: "https://example.test/terms.pdf",
    listedAt: new Date(LISTED),
    volumeUnits: 4_800n,
    ...overrides,
  });
}

/** A strike ladder expiring an hour after the binary event. */
const LADDER = "BTC2611140400";
function ladder(strikes: number[] = [64_000, 64_500, 65_000], overrides: Partial<ContractInfo> = {}): EventInfo {
  const contracts = strikes.map((strike, sortOrder) =>
    info({
      symbol: `TEST-${LADDER}-HI${strike}`,
      eventTicker: LADDER,
      effectiveAt: new Date(EXPIRY),
      expiresAt: new Date(EXPIRY + HOUR),
      label: `$${strike.toLocaleString("en-US")} or above`,
      sortOrder,
      strike: String(strike),
      ...overrides,
    }),
  );
  return eventOf(contracts, { title: "BTC price today at 4am", cadence: "hourly", shape: "ladder" });
}

const open: Registry[] = [];
function memory(): Registry {
  const registry = openRegistry(":memory:");
  open.push(registry);
  return registry;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

const symbols = (rows: Array<{ symbol: string }>) => rows.map((row) => row.symbol);

describe("storeEvents", () => {
  it("stores a new event and its contract with empty on-chain fields and settle state open", () => {
    const registry = memory();
    expect(registry.storeEvents([event()], 1_000)).toEqual([]);

    const market = {
      symbol: SYMBOL,
      eventTicker: TICKER,
      title: "BTC price at 3am",
      label: "Up",
      sortOrder: 0,
      rules: "Resolves to Yes if the price is above the price at the start of the window.",
      effectiveAt: EFFECTIVE,
      expiresAt: EXPIRY,
      strike: "64000.50",
      venueStatus: "active",
      marketState: "open",
      tickPx: 100n,
      unitIncrement: 1n,
      minUnits: 1n,
      lastPx: null,
      resolution: null,
      settlementValue: null,
      marketAddress: null,
      yesMint: null,
      noMint: null,
      settleState: "open",
      settleSignature: null,
      detail: null,
      updatedAt: 1_000,
    };
    expect(registry.get(SYMBOL)).toEqual(market);
    expect(registry.get("TEST-NOPE")).toBeUndefined();
    expect(registry.event(TICKER)).toEqual({
      ticker: TICKER,
      title: "BTC price at 3am",
      category: "Crypto",
      subcategory: ["Bitcoin"],
      underlying: "BTC",
      shape: "binary",
      cadence: "15m",
      description: "Interval BTC price prediction event",
      source: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
      termsUrl: "https://example.test/terms.pdf",
      listedAt: LISTED,
      expiresAt: EXPIRY,
      venueStatus: "active",
      volumeUnits: 4_800n,
      updatedAt: 1_000,
      markets: [market],
    });
    expect(registry.event("NOPE")).toBeUndefined();
  });

  it("stores a ladder as one event whose contracts come back ascending by sort order", () => {
    const registry = memory();
    const listed = ladder();
    listed.contracts.reverse(); // the registry orders by sort order, not by arrival
    registry.storeEvents([listed], 1_000);
    const stored = registry.event(LADDER);
    expect(stored).toMatchObject({ shape: "ladder", cadence: "hourly", source: null, termsUrl: null });
    expect(stored?.markets.map((market) => [market.symbol, market.sortOrder, market.strike, market.title])).toEqual([
      [`TEST-${LADDER}-HI64000`, 0, "64000", "BTC price today at 4am"],
      [`TEST-${LADDER}-HI64500`, 1, "64500", "BTC price today at 4am"],
      [`TEST-${LADDER}-HI65000`, 2, "65000", "BTC price today at 4am"],
    ]);
  });

  it("uses the last part of the symbol, no rule and position zero for what the venue left out", () => {
    const registry = memory();
    const { label: _label, sortOrder: _sortOrder, rules: _rules, strike: _strike, lastPx: _lastPx, ...bare } = info();
    registry.storeEvents([eventOf([bare])], 1);
    expect(registry.get(SYMBOL)).toMatchObject({ label: "UP", sortOrder: 0, rules: "", strike: null, lastPx: null });
  });

  it("updates what the venue says and never clears on-chain or settle fields", () => {
    const registry = memory();
    registry.storeEvents([event()], 1_000);
    registry.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
    registry.setSettle(SYMBOL, "awaiting_result");

    const changed = info({ marketState: "closed", tickPx: 1n, minUnits: 5n, unitIncrement: 5n, label: "Higher", sortOrder: 3, rules: "New rule.", lastPx: 4_200n });
    registry.storeEvents([event({ title: "BTC at 3am", category: "Coins", subcategory: ["Majors", "Bitcoin"], volumeUnits: 9_900n, contracts: [changed] })], 2_000);

    expect(registry.get(SYMBOL)).toMatchObject({
      title: "BTC at 3am",
      label: "Higher",
      sortOrder: 3,
      rules: "New rule.",
      marketState: "closed",
      tickPx: 1n,
      minUnits: 5n,
      unitIncrement: 5n,
      lastPx: 4_200n,
      marketAddress: "MarketA",
      yesMint: "YesA",
      noMint: "NoA",
      settleState: "awaiting_result",
      updatedAt: 2_000,
    });
    expect(registry.event(TICKER)).toMatchObject({ title: "BTC at 3am", category: "Coins", subcategory: ["Majors", "Bitcoin"], volumeUnits: 9_900n, updatedAt: 2_000 });
  });

  it("never moves a venue status backwards; the market state is taken as read", () => {
    const registry = memory();
    const read = (status: string, marketState: string, eventStatus = status) =>
      registry.storeEvents([event({ status: eventStatus, contracts: [info({ status, marketState })] })], 1);
    const stored = () => [registry.get(SYMBOL)?.venueStatus, registry.get(SYMBOL)?.marketState, registry.event(TICKER)?.venueStatus];

    read("approved", "post_only");
    expect(stored()).toEqual(["approved", "post_only", "approved"]);
    read("active", "open");
    read("approved", "post_only"); // a page older than the one already seen
    expect(stored()).toEqual(["active", "post_only", "active"]);
    read("under_review", "closed", "active");
    read("active", "open");
    expect(stored()).toEqual(["under_review", "open", "active"]);
    read("settled", "closed");
    read("under_review", "closed");
    expect(stored()).toEqual(["settled", "closed", "settled"]);
  });

  it("stores a status it does not know as read, in both directions", () => {
    const registry = memory();
    registry.storeEvents([event()], 1);
    registry.storeEvents([event({ contracts: [info({ status: "invalid" })] })], 2);
    expect(registry.get(SYMBOL)?.venueStatus).toBe("invalid");
    registry.storeEvents([event()], 3);
    expect(registry.get(SYMBOL)?.venueStatus).toBe("active");
  });

  it("keeps a contract and an event that are missing from a later list read", () => {
    const registry = memory();
    const listed = ladder();
    registry.storeEvents([event(), listed], 1_000);
    registry.storeEvents([{ ...listed, contracts: listed.contracts.slice(0, 2) }], 2_000);

    expect(registry.get(SYMBOL)).toMatchObject({ venueStatus: "active", updatedAt: 1_000 });
    expect(registry.event(LADDER)?.markets.map((market) => market.updatedAt)).toEqual([2_000, 2_000, 1_000]);
    expect(registry.liveEvents(EXPIRY - 1).map((stored) => stored.ticker)).toEqual([TICKER, LADDER]);
  });

  it("keeps a strike, a resolution, a settlement value and a last price the venue stops sending", () => {
    const registry = memory();
    registry.storeEvents([event({ contracts: [info({ status: "settled", resolutionSide: "yes", settlementValue: "64100.125", lastPx: 9_700n })] })], 1);
    registry.storeEvents([event({ contracts: [info({ strike: null })] })], 2);
    expect(registry.get(SYMBOL)).toMatchObject({ strike: "64000.50", resolution: "yes", settlementValue: "64100.125", lastPx: 9_700n });
  });

  it("reports what it cannot store and stores the rest", () => {
    const registry = memory();
    const listed = ladder();
    listed.contracts[1] = { ...listed.contracts[1]!, expiresAt: new Date("nope") };
    const undated = eventOf([info({ symbol: "TEST-ETH15M2611140300-UP", eventTicker: "ETH15M2611140300" })], { listedAt: new Date("nope") });

    const problems = registry.storeEvents([listed, undated, event()], 1);
    expect(problems.map((problem) => problem.message)).toEqual([
      `contract TEST-${LADDER}-HI64500: unreadable effective or expiry date`,
      "event ETH15M2611140300: unreadable listing or expiry date",
    ]);
    expect(symbols(registry.event(LADDER)?.markets ?? [])).toEqual([`TEST-${LADDER}-HI64000`, `TEST-${LADDER}-HI65000`]);
    expect(registry.event("ETH15M2611140300")).toBeUndefined();
    expect(registry.get("TEST-ETH15M2611140300-UP")).toBeUndefined(); // no contract without its event
    expect(registry.get(SYMBOL)).toBeDefined();
  });
});

describe("updateContract", () => {
  it("stores a single read of a known contract and keeps what the read left out", () => {
    const registry = memory();
    registry.storeEvents([event()], 1_000);
    registry.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });

    const { label: _label, sortOrder: _sortOrder, rules: _rules, strike: _strike, lastPx: _lastPx, ...bare } = info({
      eventTicker: "SOMETHING-ELSE",
      status: "settled",
      marketState: "closed",
      resolutionSide: "yes",
      settlementValue: "64100.125",
    });
    expect(registry.updateContract(bare, 2_000)).toMatchObject({
      eventTicker: TICKER,
      title: "BTC price at 3am",
      label: "Up",
      rules: "Resolves to Yes if the price is above the price at the start of the window.",
      strike: "64000.50",
      venueStatus: "settled",
      marketState: "closed",
      resolution: "yes",
      settlementValue: "64100.125",
      marketAddress: "MarketA",
      updatedAt: 2_000,
    });
    // A later read that fell back does not undo the status or erase the resolution.
    expect(registry.updateContract(info({ status: "under_review", marketState: "closed" }), 3_000)).toMatchObject({
      venueStatus: "settled",
      resolution: "yes",
      settlementValue: "64100.125",
    });
    expect(registry.get(SYMBOL)?.updatedAt).toBe(3_000);
  });

  it("throws for a contract that is not in the registry or whose dates cannot be read", () => {
    const registry = memory();
    expect(() => registry.updateContract(info(), 1)).toThrow(`unknown market ${SYMBOL}`);
    registry.storeEvents([event()], 1);
    expect(() => registry.updateContract(info({ expiresAt: new Date("nope") }), 2)).toThrow(`contract ${SYMBOL}: unreadable effective or expiry date`);
    expect(registry.get(SYMBOL)?.updatedAt).toBe(1);
  });
});

describe("setOnchain and setSettle", () => {
  it("record the addresses, the state, the signature and the detail", () => {
    const registry = memory();
    registry.storeEvents([event()], 1);
    registry.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
    registry.setSettle(SYMBOL, "needs_review", { detail: "payout mismatch" });
    expect(registry.get(SYMBOL)).toMatchObject({ marketAddress: "MarketA", settleState: "needs_review", settleSignature: null, detail: "payout mismatch" });
    registry.setSettle(SYMBOL, "settled", { signature: "SigA" });
    expect(registry.get(SYMBOL)).toMatchObject({ settleState: "settled", settleSignature: "SigA", detail: "payout mismatch" });
  });

  it("throw for a symbol that is not in the registry", () => {
    const registry = memory();
    expect(() => registry.setOnchain("TEST-NOPE", { marketAddress: "M", yesMint: "Y", noMint: "N" })).toThrow("unknown market TEST-NOPE");
    expect(() => registry.setSettle("TEST-NOPE", "settled")).toThrow("unknown market TEST-NOPE");
  });
});

describe("queries", () => {
  /** Four binary events: A expires first, then C and D together, then B. */
  function seeded(): Registry {
    const registry = memory();
    const one = (letter: string, minutes: number, status = "active") => {
      const expiresAt = new Date(EXPIRY + minutes * 60_000);
      return eventOf([info({ symbol: `TEST-${letter}`, eventTicker: `EVENT-${letter}`, expiresAt, status })], { status });
    };
    registry.storeEvents([one("B", 30), one("D", 15, "approved"), one("A", 0), one("C", 15)], 1);
    return registry;
  }
  const onchain = (registry: Registry, symbol: string) => registry.setOnchain(symbol, { marketAddress: `M-${symbol}`, yesMint: "Y", noMint: "N" });

  it("liveEvents: the events that have not expired with their contracts, soonest expiry first, approved ones included", () => {
    const registry = seeded();
    const tickers = (nowMs: number) => registry.liveEvents(nowMs).map((stored) => stored.ticker);
    expect(tickers(EXPIRY - 1)).toEqual(["EVENT-A", "EVENT-C", "EVENT-D", "EVENT-B"]);
    expect(tickers(EXPIRY)).toEqual(["EVENT-C", "EVENT-D", "EVENT-B"]);
    expect(tickers(EXPIRY + 30 * 60_000)).toEqual([]);
    expect(registry.liveEvents(EXPIRY).map((stored) => symbols(stored.markets))).toEqual([["TEST-C"], ["TEST-D"], ["TEST-B"]]);
    expect(registry.liveEvents(EXPIRY)[1]).toMatchObject({ venueStatus: "approved", markets: [{ venueStatus: "approved" }] });
  });

  it("event: one event with its contracts, expired or not", () => {
    const registry = seeded();
    registry.storeEvents([ladder()], 1);
    expect(registry.event("EVENT-A")).toMatchObject({ ticker: "EVENT-A", expiresAt: EXPIRY, markets: [{ symbol: "TEST-A" }] });
    expect(symbols(registry.event(LADDER)?.markets ?? [])).toHaveLength(3);
  });

  it("onchain: the markets that exist on-chain, newest expiry first, limited", () => {
    const registry = seeded();
    expect(registry.onchain(10)).toEqual([]);
    for (const symbol of ["TEST-A", "TEST-B", "TEST-C"]) onchain(registry, symbol);
    registry.setSettle("TEST-C", "settled", { signature: "Sig" });
    expect(symbols(registry.onchain(10))).toEqual(["TEST-B", "TEST-C", "TEST-A"]);
    expect(symbols(registry.onchain(2))).toEqual(["TEST-B", "TEST-C"]);
    expect(registry.onchain(10)[0]).toEqual(registry.get("TEST-B"));
    expect(registry.onchain(0)).toEqual([]);
  });

  it("onchainUnsettled: markets with an address whose settle state is open or awaiting_result", () => {
    const registry = seeded();
    for (const symbol of ["TEST-A", "TEST-B", "TEST-C"]) onchain(registry, symbol);
    registry.setSettle("TEST-A", "awaiting_result");
    registry.setSettle("TEST-C", "settled", { signature: "Sig" });
    registry.setSettle("TEST-D", "awaiting_result"); // no address: not on-chain
    expect(symbols(registry.onchainUnsettled())).toEqual(["TEST-A", "TEST-B"]);
    registry.setSettle("TEST-A", "unused");
    registry.setSettle("TEST-B", "needs_review");
    expect(registry.onchainUnsettled()).toEqual([]);
  });
});

describe("prune", () => {
  it("deletes contracts that expired more than a day ago and were never created on-chain, with the events left empty", () => {
    const registry = memory();
    registry.storeEvents([event(), ladder()], 1);

    registry.prune(EXPIRY + DAY); // exactly a day after the binary event expired
    expect(registry.get(SYMBOL)).toBeDefined();
    registry.prune(EXPIRY + DAY + 1);
    expect(registry.get(SYMBOL)).toBeUndefined();
    expect(registry.event(TICKER)).toBeUndefined();
    expect(registry.event(LADDER)?.markets).toHaveLength(3); // expired an hour later

    registry.prune(EXPIRY + HOUR + DAY + 1);
    expect(registry.event(LADDER)).toBeUndefined();
  });

  it("never deletes a market with an on-chain address, whatever its settle state, nor its event", () => {
    const registry = memory();
    const listed = ladder();
    registry.storeEvents([listed], 1);
    const [first, second, third] = symbols(listed.contracts) as [string, string, string];
    registry.setOnchain(first, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
    registry.setOnchain(third, { marketAddress: "MarketC", yesMint: "YesC", noMint: "NoC" });
    registry.setSettle(third, "settled", { signature: "Sig" });

    registry.prune(EXPIRY + 400 * DAY);
    expect(registry.get(second)).toBeUndefined();
    expect(symbols(registry.event(LADDER)?.markets ?? [])).toEqual([first, third]);
    expect(symbols(registry.onchain(10))).toEqual([first, third]);
  });

  it("keeps an event that has not expired even when it lists no contract", () => {
    const registry = memory();
    registry.storeEvents([{ ...event(), contracts: [] }], 1);
    registry.prune(EXPIRY - 1);
    expect(registry.event(TICKER)).toMatchObject({ markets: [] });
    registry.prune(EXPIRY + DAY + 1);
    expect(registry.event(TICKER)).toBeUndefined();
  });
});

describe("persistence", () => {
  it("keeps events and markets across a reopen and shares the file with the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const path = join(dir, "relayer.sqlite");
    try {
      const journal = openJournal(path);
      const first = openRegistry(path);
      first.storeEvents([event(), ladder()], 1_000);
      first.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
      first.setSettle(SYMBOL, "settled", { signature: "SigA" });
      const before = first.get(SYMBOL);
      const ladderBefore = first.event(LADDER);
      journal.recordSeen({
        orderAddress: "OrderA",
        clientOrderId: "client-a",
        user: "UserA",
        kind: "buy",
        side: "YES",
        symbol: SYMBOL,
        units: 100n,
        limitPx: 4_500n,
        maxFeeMicros: 50_000n,
        expiresAt: 1_800_000_000,
      });
      first.close();
      journal.close();

      const again = openRegistry(path);
      const journalAgain = openJournal(path);
      try {
        expect(again.get(SYMBOL)).toEqual(before);
        expect(again.get(SYMBOL)).toMatchObject({ marketAddress: "MarketA", settleState: "settled", settleSignature: "SigA", tickPx: 100n });
        expect(again.event(LADDER)).toEqual(ladderBefore);
        expect(journalAgain.get("OrderA")?.symbol).toBe(SYMBOL);
      } finally {
        again.close();
        journalAgain.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
