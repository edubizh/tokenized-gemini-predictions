import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../src/journal.ts";
import { createMarketManager } from "../src/markets.ts";
import { openRegistry } from "../src/registry.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { eventOf } from "./helpers/events.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";
import { columnsOf, createFirstReleaseDatabase } from "./helpers/first-release-db.ts";
import type { FirstReleaseMarket } from "./helpers/first-release-db.ts";

// A database as the first release left it: synthetic 15-minute contracts in every settle state.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.parse("2026-11-14T00:00:00Z");

function firstRelease(underlying: string, expiresAt: number, overrides: Partial<FirstReleaseMarket> = {}): FirstReleaseMarket {
  const stamp = new Date(expiresAt).toISOString().replace(/\D/g, "").slice(2, 12);
  const symbol = `TEST-${underlying}15M${stamp}-UP`;
  return {
    symbol,
    eventTicker: `${underlying}15M${stamp}`,
    series: `${underlying}15M`,
    underlying,
    title: `${underlying} price today at ${new Date(expiresAt).toISOString().slice(11, 16)}`,
    label: "Up",
    effectiveAt: expiresAt - 15 * MINUTE,
    expiresAt,
    strike: "64000.50",
    venueStatus: "active",
    marketState: "open",
    resolution: null,
    settlementValue: null,
    marketAddress: `market:${symbol}`,
    yesMint: `yes:${symbol}`,
    noMint: `no:${symbol}`,
    settleState: "open",
    settleSignature: null,
    detail: null,
    updatedAt: expiresAt - 60_000,
    ...overrides,
  };
}

const SETTLED = firstRelease("BTC", T0, { venueStatus: "settled", marketState: "closed", resolution: "yes", settlementValue: "64100.125", settleState: "settled", settleSignature: "SigSettled" });
const REVIEW = firstRelease("ETH", T0 + 15 * MINUTE, { venueStatus: "under_review", marketState: "closed", settleState: "needs_review", detail: "no resolution 600 s after expiry" });
const UNUSED = firstRelease("SOL", T0 + 15 * MINUTE, { venueStatus: "settled", marketState: "closed", resolution: "no", settleState: "unused" });
const AWAITING = firstRelease("XRP", T0 + 30 * MINUTE, { settleState: "awaiting_result" });
const OPEN = firstRelease("BTC", T0 + 45 * MINUTE);
const NEVER_ONCHAIN = firstRelease("ETH", T0 + 45 * MINUTE, { marketAddress: null, yesMint: null, noMint: null, strike: null });
/** A simulated contract of three minutes, as the mock venue lists with a short window. */
const SHORT = firstRelease("SOL", T0 + 45 * MINUTE, { effectiveAt: T0 + 42 * MINUTE });
const ALL = [SETTLED, REVIEW, UNUSED, AWAITING, OPEN, NEVER_ONCHAIN, SHORT];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The path of a fresh first-release database holding `ALL`. */
function firstReleaseFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "registry-migration-"));
  dirs.push(dir);
  const path = join(dir, "relayer.sqlite");
  createFirstReleaseDatabase(path, ALL);
  return path;
}

/** What the registry must return for a first-release row. */
function migrated(row: FirstReleaseMarket) {
  return {
    symbol: row.symbol,
    eventTicker: row.eventTicker,
    title: row.title,
    label: "Up",
    sortOrder: 0,
    rules: "",
    effectiveAt: row.effectiveAt,
    expiresAt: row.expiresAt,
    strike: row.strike,
    venueStatus: row.venueStatus,
    marketState: row.marketState,
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    lastPx: null,
    resolution: row.resolution,
    settlementValue: row.settlementValue,
    marketAddress: row.marketAddress,
    yesMint: row.yesMint,
    noMint: row.noMint,
    settleState: row.settleState,
    settleSignature: row.settleSignature,
    detail: row.detail,
    updatedAt: row.updatedAt,
  };
}

describe("a database of the first release", () => {
  it("opens with every market usable: addresses, mints and settle states as they were", () => {
    const registry = openRegistry(firstReleaseFile());
    try {
      for (const row of ALL) expect(registry.get(row.symbol)).toEqual(migrated(row));
      expect(registry.onchain(500).map((market) => market.symbol)).toEqual([OPEN.symbol, SHORT.symbol, AWAITING.symbol, REVIEW.symbol, UNUSED.symbol, SETTLED.symbol]);
      expect(registry.onchainUnsettled().map((market) => market.symbol)).toEqual([AWAITING.symbol, OPEN.symbol, SHORT.symbol]);
    } finally {
      registry.close();
    }
  });

  it("gives every old market an event made from its own columns", () => {
    const registry = openRegistry(firstReleaseFile());
    try {
      expect(registry.event(SETTLED.eventTicker)).toEqual({
        ticker: SETTLED.eventTicker,
        title: SETTLED.title,
        category: "Crypto",
        subcategory: [],
        underlying: "BTC",
        shape: "binary",
        cadence: "15m",
        description: "",
        source: null,
        termsUrl: null,
        listedAt: SETTLED.effectiveAt,
        expiresAt: SETTLED.expiresAt,
        venueStatus: "settled",
        volumeUnits: 0n,
        updatedAt: SETTLED.updatedAt,
        markets: [migrated(SETTLED)],
      });
      expect(registry.event(SHORT.eventTicker)).toMatchObject({ underlying: "SOL", cadence: "5m", markets: [{ symbol: SHORT.symbol }] });
      expect(registry.liveEvents(T0 + 40 * MINUTE).map((event) => event.ticker)).toEqual([OPEN.eventTicker, NEVER_ONCHAIN.eventTicker, SHORT.eventTicker]);
    } finally {
      registry.close();
    }
  });

  it("serves the old markets through the views, and still creates one on-chain", async () => {
    const registry = openRegistry(firstReleaseFile());
    try {
      const clock = { ms: T0 + 40 * MINUTE };
      const chain = new FakeMarketChain();
      for (const row of ALL) {
        if (row.marketAddress !== null) chain.addMarket(row.symbol, { closeTs: row.expiresAt / 1000, placeCutoffSecs: 150, yesSupply: 300n });
      }
      await chain.settleMarket(SETTLED.symbol, 10_000n, 0n);
      const manager = createMarketManager({ venue: new MockVenue({ now: () => clock.ms }), chain, registry, now: () => clock.ms });
      await manager.refresh(); // the venue lists nothing: the old rows are all there is

      expect(manager.views().map((view) => [view.symbol, view.settleState, view.onchain?.status])).toEqual([
        [OPEN.symbol, "open", "open"],
        [SHORT.symbol, "open", "open"],
        [AWAITING.symbol, "awaiting_result", "open"],
        [REVIEW.symbol, "needs_review", "open"],
        [UNUSED.symbol, "unused", "open"],
        [SETTLED.symbol, "settled", "settled"],
      ]);
      expect(manager.view(SETTLED.symbol)).toEqual({
        symbol: SETTLED.symbol,
        eventTicker: SETTLED.eventTicker,
        title: SETTLED.title,
        label: "Up",
        strike: "64000.50",
        sortOrder: 0,
        startsAt: T0 - 15 * MINUTE,
        expiresAt: T0,
        lastOrderAt: T0 - 150_000,
        venueStatus: "settled",
        marketState: "closed",
        tradable: false,
        notTradableReason: "not_active",
        tickPx: "100",
        minUnits: "1",
        unitIncrement: "1",
        book: null,
        lastPx: null,
        onchain: {
          market: SETTLED.marketAddress,
          yesMint: SETTLED.yesMint,
          noMint: SETTLED.noMint,
          status: "settled",
          closeTs: T0 / 1000,
          placeCutoffSecs: 150,
          yesSupply: "300",
          noSupply: "0",
          yesPayout: "10000",
          noPayout: "0",
          redeemAfter: T0 / 1000 + 30,
        },
        resolution: "yes",
        settlementValue: "64100.125",
        settleState: "settled",
      });
      expect(manager.eventView(SETTLED.eventTicker)).toMatchObject({
        title: SETTLED.title,
        category: "Crypto",
        underlying: "BTC",
        shape: "binary",
        cadence: "15m",
        description: "",
        source: null,
        termsUrl: null,
        rules: { [SETTLED.symbol]: "" },
        markets: [{ symbol: SETTLED.symbol, settleState: "settled" }],
      });
      expect(manager.eventViews().map((event) => [event.ticker, event.markets.map((market) => market.symbol)])).toEqual([
        [OPEN.eventTicker, [OPEN.symbol]],
        [NEVER_ONCHAIN.eventTicker, [NEVER_ONCHAIN.symbol]],
        [SHORT.eventTicker, [SHORT.symbol]],
      ]);

      await manager.ensureOnchain(NEVER_ONCHAIN.symbol);
      expect(chain.ensured).toMatchObject([{ symbol: NEVER_ONCHAIN.symbol, yes: { name: "ETH Up 15m 14Nov26 00:45 YES", ticker: "ETHY0045Q" } }]);
      expect(registry.get(NEVER_ONCHAIN.symbol)?.marketAddress).toBe(`market:${NEVER_ONCHAIN.symbol}`);
    } finally {
      registry.close();
    }
  });

  it("drops the columns that repeated event data and adds the new ones, once", () => {
    const path = firstReleaseFile();
    openRegistry(path).close();
    const columns = columnsOf(path, "markets");
    expect(columns).not.toContain("series");
    expect(columns).not.toContain("underlying");
    expect(columns).not.toContain("title");
    expect(columns).toEqual(expect.arrayContaining(["sort_order", "rules", "last_px", "market_address", "settle_state"]));

    // A second start finds the file as the first one left it.
    const again = openRegistry(path);
    try {
      expect(columnsOf(path, "markets")).toEqual(columns);
      for (const row of ALL) expect(again.get(row.symbol)).toEqual(migrated(row));
    } finally {
      again.close();
    }
  });

  it("takes list reads, settle updates and pruning like a new database, and leaves the journal alone", () => {
    const path = firstReleaseFile();
    const journal = openJournal(path);
    journal.recordSeen({
      orderAddress: "OrderA",
      clientOrderId: "client-a",
      user: "UserA",
      kind: "buy",
      side: "YES",
      symbol: OPEN.symbol,
      units: 100n,
      limitPx: 4_500n,
      maxFeeMicros: 50_000n,
      expiresAt: OPEN.expiresAt / 1000 - 300,
    });
    const registry = openRegistry(path);
    try {
      const listed: ContractInfo = {
        symbol: OPEN.symbol,
        eventTicker: OPEN.eventTicker,
        status: "active",
        marketState: "open",
        effectiveAt: new Date(OPEN.effectiveAt),
        expiresAt: new Date(OPEN.expiresAt),
        tickPx: 100n,
        unitIncrement: 1n,
        minUnits: 1n,
        resolutionSide: null,
        label: "Up",
        sortOrder: 0,
        rules: "Resolves to Yes if the price is above the price at the start of the window.",
        strike: "64010.00",
        lastPx: 4_400n,
      };
      expect(registry.storeEvents([eventOf([listed], { title: "BTC price today at 12:45am UTC", subcategory: ["Bitcoin"] })], T0 + 31 * MINUTE)).toEqual([]);
      expect(registry.get(OPEN.symbol)).toEqual({
        ...migrated(OPEN),
        title: "BTC price today at 12:45am UTC",
        rules: "Resolves to Yes if the price is above the price at the start of the window.",
        strike: "64010.00",
        lastPx: 4_400n,
        updatedAt: T0 + 31 * MINUTE,
      });

      registry.setSettle(AWAITING.symbol, "settled", { signature: "SigLater" });
      expect(registry.get(AWAITING.symbol)).toMatchObject({ settleState: "settled", settleSignature: "SigLater", marketAddress: AWAITING.marketAddress });

      registry.prune(T0 + 2 * DAY);
      expect(registry.get(NEVER_ONCHAIN.symbol)).toBeUndefined();
      expect(registry.event(NEVER_ONCHAIN.eventTicker)).toBeUndefined();
      expect(registry.onchain(500)).toHaveLength(6);
      expect(journal.get("OrderA")).toMatchObject({ symbol: OPEN.symbol, state: "seen" });
    } finally {
      registry.close();
      journal.close();
    }
  });
});
