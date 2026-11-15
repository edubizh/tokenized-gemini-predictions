import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketError, RefreshError, createMarketManager, tokenNames } from "../src/markets.ts";
import type { MarketManagerOptions } from "../src/markets.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { MockEvent } from "../src/venue/mock.ts";
import type { ContractInfo, EventInfo } from "../src/venue/venue.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// Synthetic 15-minute contracts: window 02:45 to 03:00, so the venue stops orders at 02:58. The
// strike ladder runs from 03:00 to 04:00.
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const NOW = Date.parse("2026-11-14T02:50:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BTC = "TEST-BTC15M2611140300-UP";
const ETH = "TEST-ETH15M2611140300-UP";
const SOL = "TEST-SOL15M2611140300-UP";
const LADDER = "BTC2611140400";
const RUNGS = [`TEST-${LADDER}-HI64000`, `TEST-${LADDER}-HI64500`, `TEST-${LADDER}-HI65000`] as const;
const BOOK = { bids: [[4_000n, 500n] as [bigint, bigint]], asks: [[4_500n, 700n] as [bigint, bigint]] };
const RULE = "If the price is above the price at the start of the window, this market resolves to Yes.";

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
    label: "Up",
    sortOrder: 0,
    rules: RULE,
    strike: "64000.50",
    settlementValue: null,
    ...overrides,
  };
}

const BTC_EVENT: MockEvent = {
  ticker: "BTC15M2611140300",
  title: "BTC price today at 3am",
  category: "Crypto",
  subcategory: ["Bitcoin"],
  underlying: "BTC",
  shape: "binary",
  cadence: "15m",
  description: "Interval BTC price prediction event",
  source: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
  termsUrl: "https://example.test/terms.pdf",
  listedAt: new Date(EFFECTIVE - 240_000),
  expiresAt: new Date(EXPIRY),
};

const LADDER_EVENT: MockEvent = {
  ticker: LADDER,
  title: "BTC price today at 4am",
  category: "Crypto",
  subcategory: ["Bitcoin"],
  underlying: "BTC",
  shape: "ladder",
  cadence: "hourly",
  description: "Hourly BTC price prediction event",
  source: null,
  termsUrl: null,
  listedAt: new Date(EXPIRY - HOUR),
  expiresAt: new Date(EXPIRY + HOUR),
};

function rung(index: number, overrides: Partial<ContractInfo> = {}): ContractInfo {
  const strike = 64_000 + index * 500;
  return info(RUNGS[index]!, {
    effectiveAt: new Date(EXPIRY),
    expiresAt: new Date(EXPIRY + HOUR),
    label: `$${strike.toLocaleString("en-US")} or above`,
    sortOrder: index,
    rules: `If the price is $${strike.toLocaleString("en-US")} or above, this market resolves to Yes.`,
    strike: String(strike),
    ...overrides,
  });
}

const registries: Registry[] = [];
afterEach(() => {
  while (registries.length > 0) registries.pop()?.close();
});

/** A manager that reads the venue list on every refresh, unless the options say otherwise. */
function world(options: Partial<MarketManagerOptions> = {}) {
  const clock = { ms: NOW };
  const venue = new MockVenue({ now: () => clock.ms });
  const chain = new FakeMarketChain();
  const registry = openRegistry(":memory:");
  registries.push(registry);
  const manager = createMarketManager({ venue, chain, registry, now: () => clock.ms, listRefreshMs: 0, ...options });
  /** Adds the strike ladder: approved until its window starts at 03:00, unless told otherwise. */
  const addLadder = (overrides: Partial<ContractInfo> = { status: "approved", marketState: "post_only" }) => {
    venue.addEvent(LADDER_EVENT);
    RUNGS.forEach((_symbol, index) => venue.addContract(rung(index, overrides)));
  };
  return { venue, chain, registry, clock, manager, addLadder };
}

/** A world whose registry already holds the BTC contract, with offers. */
async function listed(overrides: Partial<ContractInfo> = {}, options: Partial<MarketManagerOptions> = {}) {
  const w = world(options);
  w.venue.addEvent(BTC_EVENT);
  w.venue.addContract(info(BTC, overrides));
  w.venue.setBook(BTC, BOOK);
  await w.manager.refresh();
  return w;
}

const BTC_VIEW = {
  symbol: BTC,
  eventTicker: "BTC15M2611140300",
  title: "BTC price today at 3am",
  label: "Up",
  strike: "64000.50",
  sortOrder: 0,
  startsAt: EFFECTIVE,
  expiresAt: EXPIRY,
  lastOrderAt: EXPIRY - 120_000 - 30_000,
  venueStatus: "active",
  marketState: "open",
  tradable: true,
  notTradableReason: null,
  tickPx: "100",
  minUnits: "1",
  unitIncrement: "1",
  book: { bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW },
  lastPx: null,
  onchain: null,
  resolution: null,
  settlementValue: null,
  settleState: "open",
};

const BTC_EVENT_VIEW = {
  ticker: "BTC15M2611140300",
  title: "BTC price today at 3am",
  category: "Crypto",
  subcategory: ["Bitcoin"],
  underlying: "BTC",
  shape: "binary",
  cadence: "15m",
  listedAt: EFFECTIVE - 240_000,
  expiresAt: EXPIRY,
  venueStatus: "active",
  volumeUnits: "0",
  markets: [BTC_VIEW],
};

describe("refresh", () => {
  it("stores every event the venue lists, one contract or a ladder, and builds the views from them", async () => {
    const { venue, manager, addLadder } = await listed();
    venue.addContract(info("TEST-COPPER2611152200-HI6D12", { expiresAt: new Date("2026-11-15T22:00:00Z"), label: "$6.12 or above", strike: "6.12" }));
    addLadder();
    await manager.refresh();

    expect(manager.view(BTC)).toEqual(BTC_VIEW);
    expect(manager.eventViews().map((event) => [event.ticker, event.shape, event.markets.map((market) => market.symbol)])).toEqual([
      ["BTC15M2611140300", "binary", [BTC]],
      [LADDER, "ladder", [...RUNGS]],
      ["COPPER2611152200", "binary", ["TEST-COPPER2611152200-HI6D12"]],
    ]);
    expect(manager.view(RUNGS[1])).toMatchObject({ eventTicker: LADDER, title: "BTC price today at 4am", label: "$64,500 or above", strike: "64500", sortOrder: 1 });
    expect(manager.view("TEST-NOPE")).toBeUndefined();
  });

  it("reads the venue list once per list interval, twenty seconds unless told otherwise, and again at once after a read that failed", async () => {
    const { venue, manager, clock } = world({ listRefreshMs: undefined }); // the manager's own interval
    venue.addContract(info(BTC));
    const list = vi.spyOn(venue, "listEvents");

    await manager.refresh();
    clock.ms += 19_999;
    await manager.refresh();
    expect(list).toHaveBeenCalledTimes(1);
    clock.ms += 1;
    await manager.refresh();
    expect(list).toHaveBeenCalledTimes(2);

    list.mockRejectedValueOnce(new Error("venue down"));
    clock.ms += 20_000;
    await expect(manager.refresh()).rejects.toThrow("venue_list: venue down");
    await manager.refresh(); // no wait after a failure
    expect(list).toHaveBeenCalledTimes(4);
    await manager.refresh();
    expect(list).toHaveBeenCalledTimes(4);
  });

  it("never reads a book: listing hundreds of contracts costs one list read and no chain read", async () => {
    const { venue, chain, manager } = world();
    for (let i = 0; i < 300; i++) venue.addContract(info(`TEST-COIN${String(i).padStart(3, "0")}2611140300-UP`));
    const books = vi.spyOn(venue, "topOfBook");
    const list = vi.spyOn(venue, "listEvents");
    await manager.refresh();
    expect(manager.eventViews()).toHaveLength(300);
    expect(list).toHaveBeenCalledTimes(1);
    expect(books).not.toHaveBeenCalled();
    expect(chain.reads).toEqual([]);
  });

  it("does not move a venue status backwards when a list read is older than one already seen", async () => {
    const { venue, manager } = await listed();
    const stale = (await venue.listEvents()).map((event) => ({
      ...event,
      status: "approved",
      contracts: event.contracts.map((contract) => ({ ...contract, status: "approved", marketState: "post_only" })),
    }));
    vi.spyOn(venue, "listEvents").mockResolvedValueOnce(stale);
    await manager.refresh();
    // The status stays; the market state is taken as read, which only costs availability.
    expect(manager.view(BTC)).toMatchObject({ venueStatus: "active", marketState: "post_only", tradable: false, notTradableReason: "market_not_open" });
    expect(manager.eventViews()[0]).toMatchObject({ venueStatus: "active" });
    await manager.refresh();
    expect(manager.view(BTC)).toMatchObject({ venueStatus: "active", marketState: "open", tradable: true });
  });

  it("keeps a contract that is missing from a list read, with its last quote, until it expires", async () => {
    const { venue, manager, clock } = world();
    venue.addContract(info(BTC));
    venue.addContract(info(ETH));
    const quoted: EventInfo[] = (await venue.listEvents()).map((event) => ({
      ...event,
      contracts: event.contracts.map((contract) => ({ ...contract, bestBidPx: 4_000n, bestAskPx: 4_500n })),
    }));
    const list = vi.spyOn(venue, "listEvents").mockResolvedValueOnce(quoted);
    await manager.refresh();

    clock.ms += 15_000;
    list.mockResolvedValueOnce(quoted.slice(0, 1)); // a page without the ETH event
    await manager.refresh();
    expect(manager.eventViews().map((event) => event.markets[0]!.symbol)).toEqual([BTC, ETH]);
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "0", askPx: "4500", askUnits: "0", at: NOW });
    expect(manager.view(ETH)).toMatchObject({ tradable: true, book: { bidPx: "4000", askPx: "4500", at: NOW } });

    clock.ms = EXPIRY;
    list.mockResolvedValueOnce([]);
    await manager.refresh();
    expect(manager.eventViews()).toEqual([]);
    expect(manager.view(ETH)?.book).toBeNull(); // the quote of an expired contract is forgotten
  });

  it("forgets contracts that expired more than a day ago and never got an on-chain market", async () => {
    const { venue, registry, clock, manager } = await listed();
    venue.addContract(info(ETH));
    await manager.refresh();
    await manager.ensureOnchain(ETH);

    vi.spyOn(venue, "listEvents").mockResolvedValue([]);
    clock.ms = EXPIRY + DAY;
    await manager.refresh();
    expect(manager.view(BTC)).toBeDefined();
    clock.ms += 1;
    await manager.refresh();
    expect(manager.view(BTC)).toBeUndefined();
    expect(manager.eventView("BTC15M2611140300")).toBeUndefined();
    expect(manager.view(ETH)).toMatchObject({ onchain: { market: `market:${ETH}` } });
    expect(registry.event("ETH15M2611140300")?.markets).toHaveLength(1);
  });

  it("reports a contract it cannot store after storing the others", async () => {
    const { venue, manager } = world();
    venue.addEvent(BTC_EVENT);
    venue.addContract(info(BTC, { expiresAt: new Date("nope") }));
    venue.addContract(info(ETH));
    const failure = await manager.refresh().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RefreshError);
    expect((failure as RefreshError).parts).toEqual([{ part: "registry", error: new Error(`contract ${BTC}: unreadable effective or expiry date`) }]);
    expect(manager.view(BTC)).toBeUndefined();
    expect(manager.view(ETH)).toMatchObject({ venueStatus: "active" });
  });

  it("keeps reporting what the last list read could not store until the next read, so the failure does not come and go", async () => {
    const { venue, manager, clock } = world({ listRefreshMs: 15_000 });
    venue.addEvent(BTC_EVENT);
    venue.addContract(info(BTC, { expiresAt: new Date("nope") }));
    const message = `market refresh failed: registry: contract ${BTC}: unreadable effective or expiry date`;
    await expect(manager.refresh()).rejects.toThrow(message);
    clock.ms += 4_000; // a refresh between two list reads
    await expect(manager.refresh()).rejects.toThrow(message);

    venue.addContract(info(BTC));
    clock.ms += 11_000;
    await expect(manager.refresh()).resolves.toBeUndefined();
    expect(manager.view(BTC)).toBeDefined();
  });

  it("refreshes the chain state of on-chain markets and keeps going when the venue list fails", async () => {
    const { venue, chain, clock, manager } = await listed();
    await manager.ensureOnchain(BTC);
    chain.setSupply(BTC, 300n, 100n);
    chain.reads.length = 0;
    clock.ms += 15_000; // the copy cached by ensureOnchain has aged
    vi.spyOn(venue, "listEvents").mockRejectedValueOnce(new Error("venue down"));

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

describe("book", () => {
  it("is the venue's live top whenever the venue holds one, with its sizes", async () => {
    const { venue, manager, clock } = await listed();
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW });

    // The book moves between two list reads: the view follows without a refresh.
    clock.ms += 4_000;
    venue.setBook(BTC, { bids: [[4_100n, 10n]], asks: [] });
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4100", bidUnits: "10", askPx: null, askUnits: "0", at: NOW + 4_000 });
  });

  /** The list as the venue gives it now, with these best prices on every contract. */
  const listWith = async (venue: MockVenue, bestBidPx: bigint, bestAskPx: bigint): Promise<EventInfo[]> =>
    (await venue.listEvents()).map((event) => ({ ...event, contracts: event.contracts.map((contract) => ({ ...contract, bestBidPx, bestAskPx })) }));

  it("stays the live top when a later list read shows other prices: the list lags the book and carries no sizes", async () => {
    const { venue, manager, clock } = await listed();
    vi.spyOn(venue, "listEvents").mockResolvedValueOnce(await listWith(venue, 4_000n, 4_600n));
    clock.ms += 20_000;
    await manager.refresh();
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW });

    clock.ms += 2_000;
    venue.setBook(BTC, { bids: [[4_300n, 40n]], asks: [[4_700n, 50n]] });
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4300", bidUnits: "40", askPx: "4700", askUnits: "50", at: NOW + 22_000 });
  });

  it("is the list quote, sizes unknown, while the venue holds no live top, dated from the read that first showed it", async () => {
    const { venue, manager, clock } = world();
    venue.addContract(info(BTC)); // no book, so no live top
    const first = await listWith(venue, 4_000n, 4_500n);
    const askMoved = await listWith(venue, 4_000n, 4_600n);
    vi.spyOn(venue, "listEvents").mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockResolvedValueOnce(askMoved);
    await manager.refresh();
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "0", askPx: "4500", askUnits: "0", at: NOW });
    expect(manager.view(BTC)).toMatchObject({ tradable: true, notTradableReason: null });

    clock.ms += 20_000;
    await manager.refresh(); // the list repeats the quote
    expect(manager.view(BTC)?.book?.at).toBe(NOW);
    clock.ms += 20_000;
    await manager.refresh();
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "0", askPx: "4600", askUnits: "0", at: NOW + 40_000 });
  });

  it("keeps the last listed prices when the venue list fails", async () => {
    const { venue, manager, clock } = world();
    venue.addContract(info(BTC));
    vi.spyOn(venue, "listEvents").mockResolvedValueOnce(await listWith(venue, 4_000n, 4_500n)).mockRejectedValueOnce(new Error("venue down"));
    await manager.refresh();
    clock.ms += 15_000;
    await manager.refresh().catch(() => {});
    expect(manager.view(BTC)?.book).toEqual({ bidPx: "4000", bidUnits: "0", askPx: "4500", askUnits: "0", at: NOW });
  });

  it("is the live top for a venue whose list carries no quotes, and missing when there is neither", async () => {
    const { venue, manager, clock } = world();
    venue.addContract(info(BTC));
    venue.addContract(info(ETH));
    venue.setBook(BTC, BOOK);
    const bare = (await venue.listEvents()).map((event) => ({
      ...event,
      contracts: event.contracts.map(({ bestBidPx: _bid, bestAskPx: _ask, ...rest }) => rest),
    }));
    vi.spyOn(venue, "listEvents").mockResolvedValue(bare);
    clock.ms += 15_000;
    await manager.refresh();
    expect(manager.view(BTC)).toMatchObject({ tradable: true, book: { bidPx: "4000", bidUnits: "500", askPx: "4500", askUnits: "700", at: NOW } });
    expect(manager.view(ETH)).toMatchObject({ tradable: false, notTradableReason: "no_offers", book: null });
  });

  it("carries the price of the last trade", async () => {
    const { venue, manager } = await listed();
    venue.setCash(10_000_000n);
    await venue.placeOrder({ clientOrderId: "a", symbol: BTC, outcome: "YES", units: 100n, limitPx: 4_500n, timeInForce: "FOK" });
    await manager.refresh();
    expect(manager.view(BTC)).toMatchObject({ lastPx: "4500", book: { askUnits: "600" } });
  });
});

describe("views", () => {
  it("eventViews: every listed event that has not expired, soonest expiry first, approved ones included", async () => {
    const { venue, manager, clock, addLadder } = await listed();
    addLadder();
    venue.setBook(RUNGS[0], BOOK);
    await manager.refresh();

    const [binary, ladder] = manager.eventViews();
    expect(binary).toEqual(BTC_EVENT_VIEW);
    expect(ladder).toMatchObject({ ticker: LADDER, shape: "ladder", cadence: "hourly", venueStatus: "approved", listedAt: EXPIRY - HOUR, expiresAt: EXPIRY + HOUR });
    // Not an instrument yet: listed, quoted or not, and never tradable.
    expect(ladder?.markets.map((market) => [market.symbol, market.sortOrder, market.venueStatus, market.tradable, market.notTradableReason])).toEqual([
      [RUNGS[0], 0, "approved", false, "not_active"],
      [RUNGS[1], 1, "approved", false, "not_active"],
      [RUNGS[2], 2, "approved", false, "not_active"],
    ]);

    clock.ms = EXPIRY;
    expect(manager.eventViews().map((event) => event.ticker)).toEqual([LADDER]);
    clock.ms = EXPIRY + HOUR;
    expect(manager.eventViews()).toEqual([]);
  });

  it("eventView: one event with its description, source, terms and the rule of each contract, expired or not", async () => {
    const { manager, clock, addLadder } = await listed();
    addLadder({});
    await manager.refresh();
    clock.ms = EXPIRY + 5 * HOUR;

    expect(manager.eventView("BTC15M2611140300")).toEqual({
      ...BTC_EVENT_VIEW,
      description: "Interval BTC price prediction event",
      source: { agency: "lukka", index: "LS-LRRR-XBTUSD" },
      termsUrl: "https://example.test/terms.pdf",
      rules: { [BTC]: RULE },
      markets: [{ ...BTC_VIEW, tradable: false, notTradableReason: "too_close_to_expiry" }],
    });
    expect(manager.eventView(LADDER)).toMatchObject({
      description: "Hourly BTC price prediction event",
      source: null,
      termsUrl: null,
      rules: {
        [RUNGS[0]]: "If the price is $64,000 or above, this market resolves to Yes.",
        [RUNGS[1]]: "If the price is $64,500 or above, this market resolves to Yes.",
        [RUNGS[2]]: "If the price is $65,000 or above, this market resolves to Yes.",
      },
    });
    expect(manager.eventView(LADDER)?.markets.map((market) => market.symbol)).toEqual([...RUNGS]);
    expect(manager.eventView("NOPE")).toBeUndefined();
  });

  it("views: the markets that exist on-chain, newest expiry first, whatever their age", async () => {
    const { manager, clock, addLadder } = await listed();
    addLadder({});
    await manager.refresh();
    expect(manager.views()).toEqual([]);

    await manager.ensureOnchain(BTC);
    clock.ms = EXPIRY + 1; // the ladder's window has started
    await manager.ensureOnchain(RUNGS[2]);
    clock.ms = EXPIRY + 30 * DAY;
    expect(manager.views().map((view) => [view.symbol, view.onchain?.market])).toEqual([
      [RUNGS[2], `market:${RUNGS[2]}`],
      [BTC, `market:${BTC}`],
    ]);
    expect(manager.views()[1]).toEqual(manager.view(BTC));
  });
});

describe("eventView of an expired event", () => {
  /** The ladder half a minute after its expiry: the registry still holds its three contracts as active. */
  async function expired() {
    const w = await listed();
    w.addLadder({});
    await w.manager.refresh();
    w.clock.ms = EXPIRY + HOUR + 30_000;
    const contract = vi.spyOn(w.venue, "contract");
    const shown = (): unknown => w.manager.eventView(LADDER)?.markets.map((market) => [market.venueStatus, market.resolution]);
    return { ...w, contract, shown };
  }
  /** Lets the reads that run in the background finish. */
  const background = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it("asks the venue about its contracts in the background and shows the answer in the next view", async () => {
    const { venue, contract, shown } = await expired();
    venue.resolve(RUNGS[0], "yes");
    venue.resolve(RUNGS[1], "no");

    expect(shown()).toEqual([["active", null], ["active", null], ["active", null]]);
    await background();
    expect(contract.mock.calls.map(([symbol]) => symbol)).toEqual([...RUNGS]);
    expect(shown()).toEqual([["settled", "yes"], ["settled", "no"], ["active", null]]);
  });

  it("asks at most once in ten seconds per event, and then only about the contracts that are not settled", async () => {
    const { venue, manager, clock, contract } = await expired();
    venue.resolve(RUNGS[0], "yes");
    manager.eventView(LADDER);
    await background();
    clock.ms += 9_999;
    manager.eventView(LADDER);
    await background();
    expect(contract).toHaveBeenCalledTimes(3);

    clock.ms += 1;
    manager.eventView(LADDER);
    manager.eventView("BTC15M2611140300"); // another expired event is asked about on its own account
    await background();
    expect(contract.mock.calls.slice(3).map(([symbol]) => symbol)).toEqual([RUNGS[1], RUNGS[2], BTC]);
  });

  it("answers without waiting for the venue, and puts up with a read that fails", async () => {
    const { venue, manager, clock, contract, shown } = await expired();
    for (const symbol of RUNGS) venue.resolve(symbol, "yes");
    contract.mockReturnValueOnce(new Promise(() => {})).mockRejectedValueOnce(new Error("venue down"));

    expect(shown()).toEqual([["active", null], ["active", null], ["active", null]]);
    await background();
    expect(shown()).toEqual([["active", null], ["active", null], ["settled", "yes"]]);

    clock.ms += 10_000;
    manager.eventView(LADDER);
    await background();
    expect(shown()).toEqual([["settled", "yes"], ["settled", "yes"], ["settled", "yes"]]);
  });

  it("leaves the venue alone for an event that has not expired or whose contracts are all settled", async () => {
    const { venue, manager, clock, contract } = await expired();
    clock.ms = EXPIRY + HOUR - 1;
    manager.eventView(LADDER);
    await background();
    expect(contract).not.toHaveBeenCalled();

    clock.ms = EXPIRY + HOUR;
    for (const symbol of RUNGS) venue.resolve(symbol, "no");
    manager.eventView(LADDER);
    await background();
    expect(contract).toHaveBeenCalledTimes(3);
    clock.ms += 10_000;
    manager.eventView(LADDER);
    await background();
    expect(contract).toHaveBeenCalledTimes(3);
  });
});

describe("tradable", () => {
  const reason = (w: Awaited<ReturnType<typeof listed>>) => {
    const view = w.manager.view(BTC)!;
    expect(view.tradable).toBe(view.notTradableReason === null);
    return view.notTradableReason;
  };
  /** Stores a changed copy of the BTC contract, as a later list read would. */
  const relist = (w: Awaited<ReturnType<typeof listed>>, overrides: Partial<ContractInfo>) =>
    w.registry.storeEvents([{ ...BTC_EVENT, status: "active", volumeUnits: 0n, contracts: [info(BTC, overrides)] }], NOW);

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
    relist(w, { status: "under_review", marketState: "closed" });
    expect(reason(w)).toBe("not_active");
  });

  it("market_not_open when the venue market state is not open or the on-chain market is halted", async () => {
    const w = await listed();
    relist(w, { marketState: "post_only" });
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

  it("no_offers without a quote or with both sides empty; one side is enough", async () => {
    const w = world();
    w.venue.addContract(info(BTC));
    w.registry.storeEvents(await w.venue.listEvents(), NOW);
    expect(reason(w)).toBe("no_offers"); // the relayer has no quote at all
    expect(w.manager.view(BTC)?.book).toBeNull();
    await w.manager.refresh();
    expect(reason(w)).toBe("no_offers"); // listed with neither side quoted
    expect(w.manager.view(BTC)?.book).toEqual({ bidPx: null, bidUnits: "0", askPx: null, askUnits: "0", at: NOW });
    w.venue.setBook(BTC, { bids: [[4_000n, 500n]], asks: [] });
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

  it("gives a contract that runs longer than fifteen minutes five minutes of venue cutoff", async () => {
    const { manager, addLadder } = world();
    addLadder({});
    await manager.refresh();
    expect(manager.view(RUNGS[0])?.lastOrderAt).toBe(EXPIRY + HOUR - 300_000 - 30_000);
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
        yes: { name: "BTC Up 15m 14Nov26 03:00 YES", ticker: "BTCY0300Q", uri: "" },
        no: { name: "BTC Up 15m 14Nov26 03:00 NO", ticker: "BTCN0300Q", uri: "" },
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

  it("creates a market for any active contract the venue lists: every strike of a ladder gets its own names", async () => {
    const { chain, manager, clock, addLadder } = world();
    addLadder({});
    await manager.refresh();
    clock.ms = EXPIRY + 60_000;
    await manager.ensureOnchain(RUNGS[0]);
    await manager.ensureOnchain(RUNGS[2]);
    expect(chain.ensured.map((spec) => [spec.symbol, spec.placeCutoffSecs, spec.yes, spec.no])).toEqual([
      [RUNGS[0], 330, { name: "BTC >=64000 14Nov26 04:00 YES", ticker: "BTCY64000H", uri: "" }, { name: "BTC >=64000 14Nov26 04:00 NO", ticker: "BTCN64000H", uri: "" }],
      [RUNGS[2], 330, { name: "BTC >=65000 14Nov26 04:00 YES", ticker: "BTCY65000H", uri: "" }, { name: "BTC >=65000 14Nov26 04:00 NO", ticker: "BTCN65000H", uri: "" }],
    ]);
  });

  it("uses the configured supply cap and cutoff buffer", async () => {
    const { chain, manager } = await listed({}, { maxSupplyUnits: 5_000n, cutoffBufferSecs: 10 });
    await manager.ensureOnchain(BTC);
    expect(chain.ensured[0]).toMatchObject({ maxSupplyUnits: 5_000n, placeCutoffSecs: 130 });
  });

  it("refuses unknown, inactive, expired and coarse-grained contracts without touching the chain", async () => {
    const w = await listed();
    w.venue.addContract(info(ETH));
    w.venue.addContract(info(SOL, { unitIncrement: 100n }));
    w.addLadder(); // approved: not an instrument yet
    await w.manager.refresh();
    w.registry.updateContract(info(ETH, { status: "under_review", marketState: "closed" }), NOW);
    const refusal = async (symbol: string) => {
      const error = await w.manager.ensureOnchain(symbol).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MarketError);
      return [(error as MarketError).code, (error as MarketError).message];
    };

    expect(await refusal("TEST-NOPE")).toEqual(["unknown", "unknown market TEST-NOPE"]);
    expect(await refusal(ETH)).toEqual(["not_allowed", `market ${ETH} is not active at the venue`]);
    expect(await refusal(RUNGS[0])).toEqual(["not_allowed", `market ${RUNGS[0]} is not active at the venue`]);
    expect(await refusal(SOL)).toEqual(["not_allowed", `market ${SOL} trades in steps of 100 units, not 1`]);
    w.clock.ms = EXPIRY;
    expect(await refusal(BTC)).toEqual(["expired", `market ${BTC} has expired`]);

    expect(w.chain.ensured).toEqual([]);
    expect(w.registry.get(BTC)?.marketAddress).toBeNull();
  });

  it("leaves a market that already exists on-chain as it was created and records its addresses", async () => {
    const { chain, registry, manager } = await listed();
    const existing = chain.addMarket(BTC, { closeTs: EXPIRY / 1000, placeCutoffSecs: 60, yesSupply: 700n });
    const view = await manager.ensureOnchain(BTC);
    expect(chain.markets.get(BTC)).toEqual(existing);
    expect(view.onchain).toMatchObject({ market: `market:${BTC}`, placeCutoffSecs: 60, yesSupply: "700" });
    expect(registry.get(BTC)).toMatchObject({ marketAddress: `market:${BTC}`, yesMint: `yes:${BTC}`, noMint: `no:${BTC}` });
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
  const MINUTE = 60_000;
  /** A contract by its symbol, its strike as the venue prints it, its expiry and how long it runs. */
  const market = (symbol: string, strike: string | null, expiry: string, lifeMs: number) => {
    const expiresAt = Date.parse(expiry);
    return { symbol, strike, effectiveAt: expiresAt - lifeMs, expiresAt };
  };

  // Contracts the venue listed on 2026-11-14, with the names and tickers of the naming scheme.
  it.each([
    ["GEMI-BTC05M2611142210-UP", "63845.87", "2026-11-14T22:10:00Z", 5 * MINUTE, "BTC Up 5m 14Nov26 22:10", "BTCY2210F", "BTCN2210F"],
    ["GEMI-XRP15M2611142215-UP", "0.8431275", "2026-11-14T22:15:00Z", 15 * MINUTE, "XRP Up 15m 14Nov26 22:15", "XRPY2215Q", "XRPN2215Q"],
    ["GEMI-BTC2611142300-HI64500", "64500", "2026-11-14T23:00:00Z", HOUR, "BTC >=64500 14Nov26 23:00", "BTCY64500H", "BTCN64500H"],
    ["GEMI-BTC2611152200-HI64000", "64000", "2026-11-15T22:00:00Z", DAY, "BTC >=64000 15Nov26 22:00", "BTCY64000D", "BTCN64000D"],
    ["GEMI-XRP2611142300-HI0D84", "0.84", "2026-11-14T23:00:00Z", HOUR, "XRP >=0.84 14Nov26 23:00", "XRPY0D84H", "XRPN0D84H"],
    ["GEMI-HYPE2611152200-HI59", "59", "2026-11-15T22:00:00Z", DAY, "HYPE >=59 15Nov26 22:00", "HYPEY59D", "HYPEN59D"],
    ["GEMI-ZEC2611202200-HI900", "900", "2026-11-20T22:00:00Z", 7.6 * DAY, "ZEC >=900 20Nov26 22:00", "ZECY900W", "ZECN900W"],
    ["GEMI-ETH2611302200-HI1250", "1250", "2026-11-30T22:00:00Z", 30 * DAY, "ETH >=1250 30Nov26 22:00", "ETHY1250M", "ETHN1250M"],
    ["GEMI-COPPER2611142200-HI6D12", "6.12", "2026-11-14T22:00:00Z", DAY, "COPPER >=6.12 14Nov26 22:00", "COPPY6D12D", "COPPN6D12D"],
    ["GEMI-NGAS2611152200-HI3D575", "3.575", "2026-11-15T22:00:00Z", DAY, "NGAS >=3.575 15Nov26 22:00", "NGAY3D575D", "NGAN3D575D"],
    ["GEMI-XAU2611302200-HI3800", "3800", "2026-11-30T22:00:00Z", 30 * DAY, "XAU >=3800 30Nov26 22:00", "XAUY3800M", "XAUN3800M"],
    ["GEMI-BRENT2611152200-HI91", "91", "2026-11-15T22:00:00Z", DAY, "BRENT >=91 15Nov26 22:00", "BRENTY91D", "BRENTN91D"],
    // Two cases at the edge of the limits: a six-digit strike, and a symbol outside the known grammar.
    ["GEMI-BTC2703010800-HI105250", "105250", "2027-03-01T08:00:00Z", 30 * DAY, "BTC >=105250 01Mar27 08:00", "BTY105250M", "BTN105250M"],
    ["GEMI-FEDJAN26-DN25", null, "2026-01-28T19:00:00Z", 40 * DAY, "FEDJAN26 DN25 28Jan26 19:00", "FEDJYDN25X", "FEDJNDN25X"],
  ])("%s", (symbol, strike, expiry, lifeMs, name, yesTicker, noTicker) => {
    const yes = tokenNames(market(symbol, strike, expiry, lifeMs), "YES");
    const no = tokenNames(market(symbol, strike, expiry, lifeMs), "NO");
    expect(yes).toEqual({ name: `${name} YES`, ticker: yesTicker, uri: "" });
    expect(no).toEqual({ name: `${name} NO`, ticker: noTicker, uri: "" });
    expect(bytes(yes.name)).toBeLessThanOrEqual(32);
    expect(bytes(yes.ticker)).toBeLessThanOrEqual(10);
  });

  it("gives the strikes of one ladder different tickers, and each tenor its letter", () => {
    const tickers = ["HI64000", "HI64500", "HI65000"].map((rungCode) => tokenNames(market(`GEMI-BTC2611142300-${rungCode}`, rungCode.slice(2), "2026-11-14T23:00:00Z", HOUR), "YES").ticker);
    expect(new Set(tickers).size).toBe(3);

    const tenor = (lifeMs: number) => tokenNames(market("GEMI-BTC2611142300-HI64500", "64500", "2026-11-14T23:00:00Z", lifeMs), "YES").ticker.at(-1);
    expect([90 * MINUTE, 90 * MINUTE + 1, 36 * HOUR, 36 * HOUR + 1, 10 * DAY, 10 * DAY + 1].map(tenor)).toEqual(["H", "D", "D", "W", "W", "M"]);
  });

  it("prints a strike without trailing zeros, and from the venue's own code when the strike is not known", () => {
    const name = (symbol: string, strike: string | null) => tokenNames(market(symbol, strike, "2026-11-15T22:00:00Z", DAY), "YES").name;
    expect(name("GEMI-NGAS2611152200-HI3D55", "3.550")).toBe("NGAS >=3.55 15Nov26 22:00 YES");
    expect(name("GEMI-XAG2611152200-HI50", "50.00")).toBe("XAG >=50 15Nov26 22:00 YES");
    expect(name("GEMI-BTC2611152200-HI68000", "68000")).toBe("BTC >=68000 15Nov26 22:00 YES");
    expect(name("GEMI-XRP2611152200-HI0D84", null)).toBe("XRP >=0.84 15Nov26 22:00 YES");
  });

  it("drops the venue's prefix whatever it is, so a simulated contract is named like a real one", () => {
    expect(tokenNames(market(BTC, "64000.50", "2026-11-14T03:00:00Z", 15 * MINUTE), "YES")).toEqual({ name: "BTC Up 15m 14Nov26 03:00 YES", ticker: "BTCY0300Q", uri: "" });
    expect(tokenNames(market("BTC15M2611140300-UP", null, "2026-11-14T03:00:00Z", 15 * MINUTE), "NO").name).toBe("BTC Up 15m 14Nov26 03:00 NO");
  });

  it("names a contract of a kind it does not know by its own parts", () => {
    // An up-or-down contract with an interval the scheme has no word for.
    expect(tokenNames(market("GEMI-BTC30M2611142210-UP", null, "2026-11-14T22:10:00Z", 30 * MINUTE), "YES")).toEqual({ name: "BTC30M UP 14Nov26 22:10 YES", ticker: "BTC30MYUPX", uri: "" });
    // More dashes than the known grammar has.
    expect(tokenNames(market("GEMI-NBA-LAL-BOS-2611142300-LAL", null, "2026-11-14T23:00:00Z", DAY), "NO")).toEqual({ name: "NBALALBOS LAL 14Nov26 23:00 NO", ticker: "NBALANLALX", uri: "" });
    expect(tokenNames(market("LONE", null, "2026-11-14T23:00:00Z", DAY), "YES")).toEqual({ name: "LONE 14Nov26 23:00 YES", ticker: "LONEYX", uri: "" });
  });

  it("cuts the subject to three bytes, then the outcome, to keep the name within 32 bytes", () => {
    const fits = tokenNames(market("GEMI-PLATINUM2611152200-HI123", "123", "2026-11-15T22:00:00Z", DAY), "YES");
    expect(fits.name).toBe("PLATINUM >=123 15Nov26 22:00 YES");
    expect(bytes(fits.name)).toBe(32);

    const long = tokenNames(market("GEMI-PLATINUM2611152200-HI1234D56", "1234.56", "2026-11-15T22:00:00Z", DAY), "YES");
    expect(long.name).toBe("PLAT >=1234.56 15Nov26 22:00 YES");
    expect(bytes(long.name)).toBe(32);

    const longer = tokenNames(market("GEMI-PLATINUM2611152200-HI12345D6789", "12345.6789", "2026-11-15T22:00:00Z", DAY), "NO");
    expect(longer.name).toBe("PLA >=12345.678 15Nov26 22:00 NO");
    expect(bytes(longer.name)).toBe(32);
  });

  it("keeps the ticker within 10 bytes: a key of at most six bytes, a subject of at least two", () => {
    const yes = tokenNames(market("GEMI-PLATINUM2611152200-HI1234567D6789", "1234567.6789", "2026-11-15T22:00:00Z", DAY), "YES");
    const no = tokenNames(market("GEMI-PLATINUM2611152200-HI1234567D6789", "1234567.6789", "2026-11-15T22:00:00Z", DAY), "NO");
    expect(yes.ticker).toBe("PLY123456D");
    expect(no.ticker).toBe("PLN123456D");
    expect(tokenNames(market("GEMI-PLATINUM2611152200-HI9", "9", "2026-11-15T22:00:00Z", DAY), "YES").ticker).toBe("PLATINUY9D");
  });

  it("never carries the venue's name", () => {
    for (const side of ["YES", "NO"] as const) {
      for (const symbol of ["GEMI-GEMIBTC15M2611140300-UP", "GEMI-geminiBTC2611140300-HI64000", "GEMI-BTC2611140300-GEMINI", "TEST-GEMI-BTC-2611140300-GEMIUP"]) {
        const names = tokenNames(market(symbol, "64000", "2026-11-14T03:00:00Z", 15 * MINUTE), side);
        expect(`${names.name} ${names.ticker}`).not.toMatch(/gemi/i);
      }
      expect(tokenNames(market("GEMI-GEMIBTC15M2611140300-UP", null, "2026-11-14T03:00:00Z", 15 * MINUTE), side).name).toBe(`BTC Up 15m 14Nov26 03:00 ${side}`);
    }
  });
});
