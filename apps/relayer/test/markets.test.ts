import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketError, RefreshError, createMarketManager, tokenNames } from "../src/markets.ts";
import type { MarketManagerOptions } from "../src/markets.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// Synthetic 15-minute contracts: window 02:45 to 03:00, so the venue stops orders at 02:58.
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const NOW = Date.parse("2026-11-14T02:50:00Z");
const BTC = "TEST-BTC15M2611140300-UP";
const ETH = "TEST-ETH15M2611140300-UP";
const SOL = "TEST-SOL15M2611140300-UP";
const BOOK = { bids: [[4_000n, 500n] as [bigint, bigint]], asks: [[4_500n, 700n] as [bigint, bigint]] };

function info(symbol: string, overrides: Partial<ContractInfo> = {}): ContractInfo {
  const series = symbol.split("-")[1]!.slice(0, -10);
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
    title: `${series} price at 3am`,
    label: "Up",
    series,
    strike: "64000.50",
    settlementValue: null,
    ...overrides,
  };
}

const registries: Registry[] = [];
afterEach(() => {
  while (registries.length > 0) registries.pop()?.close();
});

function world(options: Partial<MarketManagerOptions> = {}) {
  const venue = new MockVenue();
  const chain = new FakeMarketChain();
  const registry = openRegistry(":memory:");
  registries.push(registry);
  const clock = { ms: NOW };
  const manager = createMarketManager({ venue, chain, registry, series: ["BTC15M", "ETH15M", "SOL15M"], now: () => clock.ms, ...options });
  return { venue, chain, registry, clock, manager };
}

/** A world whose registry and book cache already hold the BTC contract with offers. */
async function listed(overrides: Partial<ContractInfo> = {}, options: Partial<MarketManagerOptions> = {}) {
  const w = world(options);
  w.venue.addContract(info(BTC, overrides));
  w.venue.setBook(BTC, BOOK);
  await w.manager.refresh();
  return w;
}

describe("refresh", () => {
  it("stores the contracts of curated series only and builds views from them", async () => {
    const { venue, manager } = world({ series: ["BTC15M", "ETH15M"] });
    venue.addContract(info(BTC));
    venue.addContract(info(ETH, { expiresAt: new Date(EXPIRY + 900_000) }));
    venue.addContract(info("TEST-DOGE15M2611140300-UP"));
    venue.setBook(BTC, BOOK);
    await manager.refresh();

    expect(manager.views("live").map((view) => view.symbol)).toEqual([BTC, ETH]);
    expect(manager.views("all").map((view) => view.symbol)).toEqual([ETH, BTC]);
    expect(manager.view("TEST-DOGE15M2611140300-UP")).toBeUndefined();
    expect(manager.view(BTC)).toEqual({
      symbol: BTC,
      eventTicker: "BTC15M2611140300",
      series: "BTC15M",
      underlying: "BTC",
      title: "BTC15M price at 3am",
      label: "Up",
      startsAt: EFFECTIVE,
      expiresAt: EXPIRY,
      lastOrderAt: EXPIRY - 120_000 - 30_000,
      strike: "64000.50",
      venueStatus: "active",
      marketState: "open",
      tradable: true,
      notTradableReason: null,
      tickPx: "100",
      minUnits: "1",
      unitIncrement: "1",
      book: { bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW },
      onchain: null,
      resolution: null,
      settlementValue: null,
      settleState: "open",
    });
  });

  it("leaves expired contracts out of the live views", async () => {
    const { clock, manager } = await listed();
    clock.ms = EXPIRY;
    expect(manager.views("live")).toEqual([]);
    expect(manager.views("all").map((view) => view.symbol)).toEqual([BTC]);
  });

  it("refreshes a few books per call, round-robin, the one waiting longest first", async () => {
    const { venue, manager, clock } = world();
    venue.addContract(info(BTC));
    venue.addContract(info(ETH, { expiresAt: new Date(EXPIRY + 60_000) }));
    venue.addContract(info(SOL, { expiresAt: new Date(EXPIRY + 120_000) }));
    const books = vi.spyOn(venue, "topOfBook");
    const asked = () => books.mock.calls.map((call) => call[0]);

    await manager.refresh();
    expect(asked()).toEqual([BTC, ETH]);
    // Listed without quotes, and its book has not had a turn: no prices, sizes unknown.
    expect(manager.view(SOL)?.book).toEqual({ bidPx: null, bidUnits: "0", askPx: null, askUnits: "0", at: NOW });

    venue.setBook(SOL, BOOK);
    clock.ms = NOW + 4_000;
    await manager.refresh();
    expect(asked()).toEqual([BTC, ETH, SOL, BTC]);
    expect(manager.view(SOL)?.book).toEqual({ bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW + 4_000 });
    expect(manager.view(ETH)?.book?.at).toBe(NOW + 4_000); // prices come with every list

    await manager.refresh();
    expect(asked()).toEqual([BTC, ETH, SOL, BTC, ETH, SOL]);
  });

  it("takes book prices from the contract list on every refresh; sizes stay from the last book read", async () => {
    const { venue, manager, clock } = world({ booksPerRefresh: 1 });
    venue.addContract(info(BTC));
    venue.addContract(info(ETH, { expiresAt: new Date(EXPIRY + 60_000) }));
    venue.setBook(BTC, BOOK);
    venue.setBook(ETH, { bids: [[2_000n, 50n]], asks: [[2_300n, 60n]] });

    await manager.refresh(); // book read: BTC
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW });
    expect(manager.view(ETH)?.book).toEqual({ bidPx: "2000", bidUnits: "0", askPx: "2300", askUnits: "0", at: NOW });
    expect(manager.view(ETH)).toMatchObject({ tradable: true, notTradableReason: null });

    venue.setBook(BTC, { bids: [[4_100n, 10n]], asks: [] });
    clock.ms = NOW + 4_000;
    await manager.refresh(); // book read: ETH
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4100", bidUnits: "500", askPx: null, askUnits: "700", at: NOW + 4_000 });
    expect(manager.view(ETH)?.book).toEqual({ bidPx: "2000", bidUnits: "50", askPx: "2300", askUnits: "60", at: NOW + 4_000 });

    // The list decides whether there are offers, whatever the last book read showed.
    venue.setBook(BTC, { bids: [], asks: [] });
    await manager.refresh(); // book read: BTC again
    expect(manager.view(BTC)).toMatchObject({ tradable: false, notTradableReason: "no_offers", book: { bidPx: null, askPx: null } });
  });

  it("keeps the last listed prices when the venue list fails", async () => {
    const { venue, manager, clock } = await listed();
    vi.spyOn(venue, "listContracts").mockRejectedValueOnce(new Error("venue down"));
    clock.ms = NOW + 4_000;
    await manager.refresh().catch(() => {});
    expect(manager.view(BTC)?.book).toMatchObject({ bidPx: "4000", askPx: "4500", at: NOW });
  });

  it("falls back to the prices of the last book read for a venue that lists none", async () => {
    const { venue, manager } = world();
    venue.addContract(info(BTC));
    venue.setBook(BTC, BOOK);
    const bare = (await venue.listContracts()).map(({ bestBidPx: _bid, bestAskPx: _ask, ...rest }) => rest);
    vi.spyOn(venue, "listContracts").mockResolvedValue(bare);
    await manager.refresh();
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW });
    expect(manager.view(BTC)?.tradable).toBe(true);
  });

  it("a book that cannot be read takes its turn like any other and is reported after the rest ran", async () => {
    const { venue, manager } = world({ booksPerRefresh: 1 });
    venue.addContract(info(BTC));
    venue.addContract(info(ETH, { expiresAt: new Date(EXPIRY + 60_000) }));
    venue.setBook(ETH, BOOK);
    const books = vi.spyOn(venue, "topOfBook").mockRejectedValueOnce(new Error("book down"));

    const failure = await manager.refresh().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RefreshError);
    expect((failure as RefreshError).parts).toEqual([{ part: "books", error: new Error("book down") }]);
    await manager.refresh();
    expect(books.mock.calls.map((call) => call[0])).toEqual([BTC, ETH]);
    expect(manager.view(ETH)?.book?.askPx).toBe("4500");
  });

  it("refreshes the chain state of on-chain markets and keeps going when the venue list fails", async () => {
    const { venue, chain, clock, manager } = await listed();
    await manager.ensureOnchain(BTC);
    chain.setSupply(BTC, 300n, 100n);
    chain.reads.length = 0;
    clock.ms += 15_000; // the copy cached by ensureOnchain has aged
    vi.spyOn(venue, "listContracts").mockRejectedValueOnce(new Error("venue down"));

    const failure = await manager.refresh().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RefreshError);
    expect((failure as RefreshError).message).toContain("venue down");
    expect((failure as RefreshError).parts.map((part) => part.part)).toEqual(["venue_list"]);
    expect(chain.reads).toEqual([BTC]);
    expect(manager.view(BTC)?.onchain).toMatchObject({ yesSupply: "300", noSupply: "100", status: "open" });
  });

  it("reads the chain state of a live market at most once per refresh interval", async () => {
    const { chain, clock, manager } = await listed({}, { chainRefreshMs: 15_000 });
    await manager.ensureOnchain(BTC);
    chain.reads.length = 0;

    await manager.refresh();
    clock.ms += 14_000;
    await manager.refresh();
    expect(chain.reads).toEqual([]); // ensureOnchain left a fresh copy in the cache

    clock.ms += 1_000;
    await manager.refresh();
    await manager.refresh();
    expect(chain.reads).toEqual([BTC]);
  });

  it("keeps reading an expired on-chain market until its settlement is cached, then stops", async () => {
    const { chain, registry, clock, manager } = await listed();
    await manager.ensureOnchain(BTC);
    clock.ms = EXPIRY + 60_000;
    chain.reads.length = 0;

    await manager.refresh();
    expect(chain.reads).toEqual([BTC]); // unsettled: read every time

    const signature = await chain.settleMarket(BTC, 10_000n, 0n);
    registry.setSettle(BTC, "settled", { signature });
    await manager.refresh();
    await manager.refresh();
    expect(chain.reads).toEqual([BTC, BTC]);
    expect(manager.view(BTC)).toMatchObject({
      settleState: "settled",
      onchain: { status: "settled", yesPayout: "10000", noPayout: "0", redeemAfter: EXPIRY / 1000 + 30 },
    });
  });

  it("reports a chain read that fails after the other markets were read", async () => {
    const { venue, chain, clock, manager } = await listed();
    venue.addContract(info(ETH));
    await manager.refresh();
    await manager.ensureOnchain(BTC);
    await manager.ensureOnchain(ETH);
    chain.setSupply(ETH, 50n, 0n);
    chain.fail("market", 1);
    clock.ms += 15_000; // both cached copies have aged

    const failure = await manager.refresh().catch((error: unknown) => error);
    expect((failure as RefreshError).parts.map((part) => part.part)).toEqual(["chain"]);
    expect(manager.view(ETH)?.onchain?.yesSupply).toBe("50");
  });
});

describe("tradable", () => {
  const reason = (w: Awaited<ReturnType<typeof listed>>) => {
    const view = w.manager.view(BTC)!;
    expect(view.tradable).toBe(view.notTradableReason === null);
    return view.notTradableReason;
  };

  it("is true for an open, started contract with offers", async () => {
    expect(reason(await listed())).toBeNull();
  });

  it("venue_offline while the venue is marked offline, before any other reason", async () => {
    const w = await listed();
    w.manager.setVenueOnline(false);
    w.manager.setPaused(true);
    expect(reason(w)).toBe("venue_offline");
    w.manager.setVenueOnline(true);
    expect(reason(w)).toBe("paused");
    w.manager.setPaused(false);
    expect(reason(w)).toBeNull();
  });

  it("not_active when the venue status is not active", async () => {
    const w = await listed();
    w.registry.upsertContract(info(BTC, { status: "under_review", marketState: "closed" }), NOW);
    expect(reason(w)).toBe("not_active");
  });

  it("market_not_open when the venue market state is not open or the on-chain market is halted", async () => {
    const w = await listed();
    w.registry.upsertContract(info(BTC, { marketState: "post_only" }), NOW);
    expect(reason(w)).toBe("market_not_open");

    const halted = await listed();
    await halted.manager.ensureOnchain(BTC);
    expect(reason(halted)).toBeNull();
    await halted.chain.haltMarket(BTC);
    halted.clock.ms += 15_000; // the cached on-chain copy has aged
    await halted.manager.refresh();
    expect(reason(halted)).toBe("market_not_open");
  });

  it("not_started before the window opens", async () => {
    const w = await listed();
    w.clock.ms = EFFECTIVE - 1;
    expect(reason(w)).toBe("not_started");
    w.clock.ms = EFFECTIVE;
    expect(reason(w)).toBeNull();
  });

  it("too_close_to_expiry from the last order time on", async () => {
    const w = await listed();
    const lastOrderAt = w.manager.view(BTC)!.lastOrderAt;
    w.clock.ms = lastOrderAt - 1;
    expect(reason(w)).toBeNull();
    w.clock.ms = lastOrderAt;
    expect(reason(w)).toBe("too_close_to_expiry");
  });

  it("no_offers without a book or with both sides empty; one side is enough", async () => {
    const w = world();
    w.venue.addContract(info(BTC));
    w.registry.upsertContract(info(BTC), NOW);
    expect(reason(w)).toBe("no_offers"); // no book read yet
    await w.manager.refresh();
    expect(reason(w)).toBe("no_offers"); // empty book
    w.venue.setBook(BTC, { bids: [[4_000n, 500n]], asks: [] });
    await w.manager.refresh();
    expect(reason(w)).toBeNull();
  });
});

describe("lastOrderAt", () => {
  it("is the venue cutoff less the buffer before the market is on-chain", async () => {
    const { manager } = await listed({}, { cutoffBufferSecs: 45 });
    expect(manager.view(BTC)?.lastOrderAt).toBe(EXPIRY - 120_000 - 45_000);
  });

  it("is the earlier of the venue cutoff and the on-chain cutoff once on-chain", async () => {
    const early = await listed();
    await early.manager.ensureOnchain(BTC);
    expect(early.manager.view(BTC)?.lastOrderAt).toBe(EXPIRY - 150_000); // on-chain: close - (120 + 30) s

    const late = await listed();
    late.chain.addMarket(BTC, { closeTs: EXPIRY / 1000, placeCutoffSecs: 60 });
    late.registry.setOnchain(BTC, { marketAddress: `market:${BTC}`, yesMint: `yes:${BTC}`, noMint: `no:${BTC}` });
    await late.manager.refresh();
    expect(late.manager.view(BTC)?.lastOrderAt).toBe(EXPIRY - 120_000); // venue cutoff is earlier
  });
});

describe("ensureOnchain", () => {
  it("creates the market with the contract's terms and stores its addresses", async () => {
    const { chain, registry, manager } = await listed({ tickPx: 10n });
    const view = await manager.ensureOnchain(BTC);

    expect(chain.ensured).toEqual([
      {
        symbol: BTC,
        closeTs: EXPIRY / 1000,
        placeCutoffSecs: 150,
        tickPx: 10n,
        maxSupplyUnits: 1_000_000n,
        yes: { name: "BTC Up 03:00Z 14 Nov YES", ticker: "BTCY0300", uri: "" },
        no: { name: "BTC Up 03:00Z 14 Nov NO", ticker: "BTCN0300", uri: "" },
      },
    ]);
    expect(registry.get(BTC)).toMatchObject({ marketAddress: `market:${BTC}`, yesMint: `yes:${BTC}`, noMint: `no:${BTC}`, settleState: "open" });
    expect(view.onchain).toEqual({
      market: `market:${BTC}`,
      yesMint: `yes:${BTC}`,
      noMint: `no:${BTC}`,
      status: "open",
      closeTs: EXPIRY / 1000,
      placeCutoffSecs: 150,
      yesSupply: "0",
      noSupply: "0",
      yesPayout: null,
      noPayout: null,
      redeemAfter: null,
    });
    expect(manager.view(BTC)).toEqual(view);
  });

  it("uses the configured supply cap and cutoff buffer", async () => {
    const { chain, manager } = await listed({}, { maxSupplyUnits: 5_000n, cutoffBufferSecs: 10 });
    await manager.ensureOnchain(BTC);
    expect(chain.ensured[0]).toMatchObject({ maxSupplyUnits: 5_000n, placeCutoffSecs: 130 });
  });

  it("refuses unknown, uncurated, inactive, expired and coarse-grained contracts without touching the chain", async () => {
    const w = await listed();
    const refusal = async (symbol: string) => {
      const error = await w.manager.ensureOnchain(symbol).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MarketError);
      return (error as MarketError).code;
    };

    expect(await refusal("TEST-NOPE")).toBe("unknown");
    w.registry.upsertContract(info("TEST-DOGE15M2611140300-UP"), NOW);
    expect(await refusal("TEST-DOGE15M2611140300-UP")).toBe("not_allowed");
    w.registry.upsertContract(info(ETH, { status: "under_review" }), NOW);
    expect(await refusal(ETH)).toBe("not_allowed");
    w.registry.upsertContract(info(SOL, { unitIncrement: 100n }), NOW);
    expect(await refusal(SOL)).toBe("not_allowed");
    w.clock.ms = EXPIRY;
    expect(await refusal(BTC)).toBe("expired");

    expect(w.chain.ensured).toEqual([]);
    expect(w.registry.get(BTC)?.marketAddress).toBeNull();
  });

  it("shares one chain call between concurrent requests for a symbol", async () => {
    const { chain, manager } = await listed();
    let release: () => void = () => {};
    chain.ensureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = manager.ensureOnchain(BTC);
    const second = manager.ensureOnchain(BTC);
    await Promise.resolve();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(chain.ensured).toHaveLength(1);
    expect(b).toEqual(a);

    chain.ensureGate = null;
    await manager.ensureOnchain(BTC);
    expect(chain.ensured).toHaveLength(2); // a finished flight is not reused
  });

  it("passes a chain failure on and can be called again", async () => {
    const { chain, registry, manager } = await listed();
    chain.fail("ensureMarket", 1);
    await expect(manager.ensureOnchain(BTC)).rejects.toThrow("injected failure: ensureMarket");
    expect(registry.get(BTC)?.marketAddress).toBeNull();
    await expect(manager.ensureOnchain(BTC)).resolves.toMatchObject({ onchain: { market: `market:${BTC}` } });
  });

  it("does not record a market that came back without both mints", async () => {
    const { chain, registry, manager } = await listed();
    vi.spyOn(chain, "ensureMarket").mockResolvedValueOnce({ ...chain.addMarket(BTC), noMint: null });
    await expect(manager.ensureOnchain(BTC)).rejects.toThrow(`market ${BTC} is missing an outcome mint`);
    expect(registry.get(BTC)?.marketAddress).toBeNull();
  });
});

describe("tokenNames", () => {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  const market = (overrides: { underlying?: string; label?: string; expiresAt?: number } = {}) => ({ underlying: "BTC", label: "Up", expiresAt: EXPIRY, ...overrides });

  it("names the underlying, the label, the expiry in UTC and the side", () => {
    expect(tokenNames(market(), "YES")).toEqual({ name: "BTC Up 03:00Z 14 Nov YES", ticker: "BTCY0300", uri: "" });
    expect(tokenNames(market({ label: "Down", expiresAt: Date.parse("2027-01-03T23:45:00Z") }), "NO")).toEqual({
      name: "BTC Down 23:45Z 3 Jan NO",
      ticker: "BTCN2345",
      uri: "",
    });
  });

  it("truncates the label to keep the name within 32 bytes", () => {
    const long = tokenNames(market({ label: "Above the reference price at close" }), "YES");
    expect(long.name).toBe("BTC Above the 03:00Z 14 Nov YES");
    expect(bytes(long.name)).toBeLessThanOrEqual(32);

    const wide = tokenNames(market({ label: "≥ 64,000.50 dollars" }), "NO");
    expect(bytes(wide.name)).toBeLessThanOrEqual(32);
    expect(wide.name).toMatch(/^BTC ≥ .* 03:00Z 14 Nov NO$/);

    const huge = tokenNames(market({ underlying: "AVERYLONGUNDERLYINGNAMEFORATOKEN", label: "Up" }), "YES");
    expect(bytes(huge.name)).toBeLessThanOrEqual(32);
  });

  it("keeps the ticker within 10 bytes and distinct per side", () => {
    const yes = tokenNames(market({ underlying: "LONGCOINNAME" }), "YES");
    const no = tokenNames(market({ underlying: "LONGCOINNAME" }), "NO");
    expect(yes.ticker).toBe("LONGCY0300");
    expect(no.ticker).toBe("LONGCN0300");
    expect(bytes(yes.ticker)).toBeLessThanOrEqual(10);
  });

  it("never carries the venue's name", () => {
    for (const side of ["YES", "NO"] as const) {
      const names = tokenNames(market({ underlying: "GEMIBTC", label: "Gemini Up" }), side);
      expect(`${names.name} ${names.ticker}`).not.toMatch(/gemi/i);
      expect(names.name).toBe(`BTC Up 03:00Z 14 Nov ${side}`);
    }
  });
});
