import { describe, expect, it } from "vitest";
import type { ApiBook, ApiEvent, ApiMarket } from "@outcome/relayer/api-types";
import {
  cadenceLabel,
  cadencesOf,
  cardRows,
  categoriesOf,
  centsText,
  chancePx,
  chanceText,
  eventPhase,
  filterEvents,
  isQuoted,
  NO_VALUE,
  prices,
  selectedContract,
  sortEvents,
  volumeText,
  volumeUnits,
} from "./derive";

const NOW = Date.UTC(2026, 10, 14, 22, 0, 0);
const MINUTE = 60_000;

const book = (bid: number | null, ask: number | null): ApiBook => ({
  bidPx: bid === null ? null : String(bid),
  bidUnits: bid === null ? "0" : "2500",
  askPx: ask === null ? null : String(ask),
  askUnits: ask === null ? "0" : "1800",
  at: NOW,
});

const market = (patch: Partial<ApiMarket> = {}): ApiMarket => ({
  symbol: "GEMI-BTC2611142300-HI64500",
  eventTicker: "BTC2611142300",
  title: "BTC price today at 6pm EST",
  label: "$64,500 or above",
  strike: "64500",
  sortOrder: 0,
  startsAt: NOW - 30 * MINUTE,
  expiresAt: NOW + 30 * MINUTE,
  lastOrderAt: NOW + 29 * MINUTE,
  venueStatus: "active",
  marketState: "open",
  tradable: true,
  notTradableReason: null,
  tickPx: "100",
  minUnits: "1",
  unitIncrement: "1",
  book: book(5500, 5700),
  lastPx: null,
  onchain: null,
  resolution: null,
  settlementValue: null,
  settleState: "open",
  ...patch,
});

const unquoted = (patch: Partial<ApiMarket> = {}) => market({ book: book(null, null), tradable: false, notTradableReason: "no_offers", ...patch });

const event = (ticker: string, patch: Partial<ApiEvent> = {}): ApiEvent => ({
  ticker,
  title: `${ticker} title`,
  category: "Crypto",
  subcategory: ["Bitcoin"],
  underlying: "BTC",
  shape: "binary",
  cadence: "15m",
  listedAt: NOW - 20 * MINUTE,
  expiresAt: NOW + 30 * MINUTE,
  venueStatus: "active",
  volumeUnits: "0",
  markets: [market({ symbol: `GEMI-${ticker}-UP`, eventTicker: ticker, label: "Up" })],
  ...patch,
});

/** A ladder whose contracts have these bids and asks, in strike order. Null is a contract nobody quotes. */
const ladder = (ticker: string, quotes: Array<[number | null, number | null] | null>, patch: Partial<ApiEvent> = {}): ApiEvent =>
  event(ticker, {
    shape: "ladder",
    cadence: "hourly",
    markets: quotes.map((quote, index) => {
      const base = { symbol: `GEMI-${ticker}-HI${index}`, eventTicker: ticker, label: `$${index} or above`, sortOrder: index };
      return quote === null ? unquoted(base) : market({ ...base, book: book(quote[0], quote[1]) });
    }),
    ...patch,
  });

const tickers = (events: readonly ApiEvent[]) => events.map((entry) => entry.ticker);
const symbols = (markets: readonly ApiMarket[]) => markets.map((entry) => entry.symbol);

describe("chance", () => {
  it("is the midpoint of bid and ask when both exist", () => {
    expect(chancePx(market({ book: book(5500, 5700) }))).toBe(5600n);
    expect(chancePx(market({ book: book(300, 600), lastPx: "9000" }))).toBe(450n);
    // Half a px rounds up.
    expect(chancePx(market({ book: book(5501, 5600) }))).toBe(5551n);
  });

  it("is the last trade price when a side is missing, and nothing when it never traded", () => {
    expect(chancePx(market({ book: book(5500, null), lastPx: "5200" }))).toBe(5200n);
    expect(chancePx(market({ book: book(null, 5700), lastPx: "5200" }))).toBe(5200n);
    expect(chancePx(market({ book: null, lastPx: "5200" }))).toBe(5200n);
    expect(chancePx(market({ book: book(5500, null), lastPx: null }))).toBeNull();
    expect(chancePx(market({ book: null, lastPx: null }))).toBeNull();
  });

  it("reads as a whole percent, with the edges said in words and nothing as a dash", () => {
    expect(chanceText(5600n)).toBe("56%");
    expect(chanceText(5649n)).toBe("56%");
    expect(chanceText(5650n)).toBe("57%");
    expect(chanceText(100n)).toBe("1%");
    expect(chanceText(9900n)).toBe("99%");
    expect(chanceText(99n)).toBe("<1%");
    expect(chanceText(1n)).toBe("<1%");
    expect(chanceText(9901n)).toBe(">99%");
    expect(chanceText(9999n)).toBe(">99%");
    expect(chanceText(null)).toBe(NO_VALUE);
  });
});

describe("prices", () => {
  it("prices Yes at the best ask and No at 100 cents less the best bid", () => {
    expect(prices(market({ book: book(5500, 5700) }))).toEqual({ yes: 5700n, no: 4500n });
    expect(prices(market({ book: book(300, 9700) }))).toEqual({ yes: 9700n, no: 9700n });
  });

  it("has no price for a side nobody offers, and never a price of zero", () => {
    expect(prices(market({ book: book(200, null) }))).toEqual({ yes: null, no: 9800n });
    expect(prices(market({ book: book(null, 5700) }))).toEqual({ yes: 5700n, no: null });
    expect(prices(market({ book: book(null, null) }))).toEqual({ yes: null, no: null });
    expect(prices(market({ book: null }))).toEqual({ yes: null, no: null });
  });

  it("writes a price in cents and a missing one as a dash", () => {
    expect(centsText(5700n)).toBe("57¢");
    expect(centsText(350n)).toBe("3.5¢");
    expect(centsText(null)).toBe(NO_VALUE);
    expect(centsText(null)).not.toContain("0");
  });
});

describe("isQuoted", () => {
  it("is true when at least one side has a price", () => {
    expect(isQuoted(market({ book: book(5500, 5700) }))).toBe(true);
    expect(isQuoted(market({ book: book(200, null) }))).toBe(true);
    expect(isQuoted(market({ book: book(null, 5700) }))).toBe(true);
    expect(isQuoted(market({ book: book(null, null) }))).toBe(false);
    expect(isQuoted(market({ book: null }))).toBe(false);
  });
});

describe("sortEvents", () => {
  const soon = event("SOON", { expiresAt: NOW + 10 * MINUTE });
  const later = event("LATER", { expiresAt: NOW + 30 * MINUTE });
  const quiet = event("QUIET", { expiresAt: NOW + 5 * MINUTE, markets: [unquoted()] });
  const closing = event("CLOSING", { expiresAt: NOW + MINUTE, markets: [market({ tradable: false, notTradableReason: "too_close_to_expiry" })] });
  const opening = ladder("OPENING", [null, null], { expiresAt: NOW + 2 * MINUTE, venueStatus: "approved" });
  const oneStrike = ladder("ONESTRIKE", [null, [4000, 4400], null], { expiresAt: NOW + 20 * MINUTE });
  const all = [opening, later, quiet, oneStrike, closing, soon];

  it("puts events with a tradable, quoted contract first, then the soonest to expire, and what is not trading yet last", () => {
    expect(tickers(sortEvents(all))).toEqual(["SOON", "ONESTRIKE", "LATER", "CLOSING", "QUIET", "OPENING"]);
    expect(tickers(sortEvents(all, "ending"))).toEqual(tickers(sortEvents(all)));
  });

  it("breaks a tie on the expiry by ticker, so the order does not move between polls", () => {
    const twins = [event("B", { expiresAt: NOW + MINUTE }), event("A", { expiresAt: NOW + MINUTE })];
    expect(tickers(sortEvents(twins))).toEqual(["A", "B"]);
    expect(tickers(sortEvents([...twins].reverse()))).toEqual(["A", "B"]);
  });

  it("sorts by what was listed last", () => {
    const events = [event("OLD", { listedAt: NOW - 90 * MINUTE }), event("NEW", { listedAt: NOW - MINUTE }), event("MID", { listedAt: NOW - 10 * MINUTE })];
    expect(tickers(sortEvents(events, "newest"))).toEqual(["NEW", "MID", "OLD"]);
  });

  it("sorts by volume, beyond what a number holds exactly, and keeps the default order among equals", () => {
    const events = [
      event("NONE-LATER", { expiresAt: NOW + 30 * MINUTE }),
      event("SOME", { volumeUnits: "4800" }),
      event("NONE-SOON", { expiresAt: NOW + 10 * MINUTE }),
      event("MOST", { volumeUnits: "9007199254740993" }),
      event("NEARLY", { volumeUnits: "9007199254740992" }),
    ];
    expect(tickers(sortEvents(events, "volume"))).toEqual(["MOST", "NEARLY", "SOME", "NONE-SOON", "NONE-LATER"]);
  });

  it("leaves the list it was given as it was", () => {
    const before = tickers(all);
    sortEvents(all, "volume");
    expect(tickers(all)).toEqual(before);
  });
});

describe("filterEvents", () => {
  const btc = event("BTC15M2611142215", { title: "BTC price today at 5:15pm EST" });
  const eth = ladder("ETH2611152200", [[5500, 5900], null], { title: "ETH price on November 15", underlying: "ETH", subcategory: ["Ethereum"], cadence: "daily" });
  const gold = ladder("XAU2611152200", [null, null], { title: "Gold price on November 15?", underlying: "XAU", category: "Commodities", subcategory: ["Precious Metals", "Gold"], cadence: "daily" });
  const all = [btc, eth, gold];

  it("names the categories and the cadences that are present", () => {
    expect(categoriesOf(all)).toEqual(["Commodities", "Crypto"]);
    expect(cadencesOf(all)).toEqual(["15m", "daily"]);
    expect(cadencesOf([event("M", { cadence: "monthly" }), event("O", { cadence: "other" }), event("F", { cadence: "5m" }), event("W", { cadence: "weekly" }), event("H", { cadence: "hourly" })])).toEqual(["5m", "hourly", "weekly", "monthly", "other"]);
    expect(categoriesOf([])).toEqual([]);
  });

  it("keeps everything without a filter", () => {
    expect(filterEvents(all, {})).toEqual(all);
    expect(filterEvents(all, { category: null, cadence: null, search: "  " })).toEqual(all);
  });

  it("filters by category and by cadence", () => {
    expect(tickers(filterEvents(all, { category: "Commodities" }))).toEqual(["XAU2611152200"]);
    expect(tickers(filterEvents(all, { cadence: "daily" }))).toEqual(["ETH2611152200", "XAU2611152200"]);
    expect(tickers(filterEvents(all, { category: "Crypto", cadence: "daily" }))).toEqual(["ETH2611152200"]);
    expect(filterEvents(all, { category: "Sports" })).toEqual([]);
  });

  it("searches the title, the underlying and the labels of the contracts, whatever the case", () => {
    expect(tickers(filterEvents(all, { search: "gold" }))).toEqual(["XAU2611152200"]);
    expect(tickers(filterEvents(all, { search: " xau " }))).toEqual(["XAU2611152200"]);
    expect(tickers(filterEvents(all, { search: "NOVEMBER 15" }))).toEqual(["ETH2611152200", "XAU2611152200"]);
    expect(tickers(filterEvents(all, { search: "$1 or above" }))).toEqual(["ETH2611152200", "XAU2611152200"]);
    expect(tickers(filterEvents(all, { search: "up" }))).toEqual(["BTC15M2611142215"]);
    expect(tickers(filterEvents(all, { search: "eth", category: "Commodities" }))).toEqual([]);
  });
});

describe("cardRows", () => {
  it("shows the one contract of a binary event", () => {
    const binary = event("BTC15M2611142215");
    expect(cardRows(binary)).toEqual({ markets: binary.markets, quoted: true, more: 0 });
    const quiet = event("SOL05M2611142205", { markets: [unquoted()] });
    expect(cardRows(quiet)).toEqual({ markets: quiet.markets, quoted: false, more: 0 });
  });

  it("shows the two quoted contracts of a ladder whose chance is nearest 50%, in ladder order", () => {
    // Chances 93, 84, 69, 54, 38, 22, 11 and 5 percent.
    const hourly = ladder("BTC2611142300", [[9100, 9500], [8200, 8600], [6700, 7100], [5200, 5600], [3600, 4000], [2000, 2400], [900, 1300], [300, 700]]);
    const rows = cardRows(hourly);
    expect(symbols(rows.markets)).toEqual(["GEMI-BTC2611142300-HI3", "GEMI-BTC2611142300-HI4"]);
    expect(rows.quoted).toBe(true);
    expect(rows.more).toBe(6);
  });

  it("passes over the contracts nobody quotes, however close their last trade was to 50%", () => {
    const some = ladder("ETH2611152200", [[7800, 8200], null, [900, 1300], null]);
    const traded = { ...some, markets: some.markets.map((entry, index) => (index === 1 ? { ...entry, lastPx: "5000" } : entry)) };
    expect(symbols(cardRows(traded).markets)).toEqual(["GEMI-ETH2611152200-HI0", "GEMI-ETH2611152200-HI2"]);
  });

  it("ranks a quoted contract without a chance after those that have one, and prefers the lower strike on a tie", () => {
    const tie = ladder("TIE", [[5900, 6100], [200, null], [3900, 4100], [4900, 5100]]);
    expect(symbols(cardRows(tie).markets)).toEqual(["GEMI-TIE-HI0", "GEMI-TIE-HI3"]);
    const oneSided = ladder("ONE", [[200, null], [100, 300]]);
    expect(symbols(cardRows(oneSided).markets)).toEqual(["GEMI-ONE-HI0", "GEMI-ONE-HI1"]);
  });

  it("shows the only quoted contract alone", () => {
    const one = ladder("SOL2611202200", [null, [200, null], null, null, null]);
    expect(cardRows(one)).toMatchObject({ quoted: true, more: 4 });
    expect(symbols(cardRows(one).markets)).toEqual(["GEMI-SOL2611202200-HI1"]);
  });

  it("shows the two middle contracts, marked as not quoted, when nobody quotes the ladder", () => {
    const five = ladder("XAU2611152200", [null, null, null, null, null]);
    expect(cardRows(five)).toMatchObject({ quoted: false, more: 3 });
    expect(symbols(cardRows(five).markets)).toEqual(["GEMI-XAU2611152200-HI2", "GEMI-XAU2611152200-HI3"]);
    expect(symbols(cardRows(ladder("SIX", [null, null, null, null, null, null])).markets)).toEqual(["GEMI-SIX-HI2", "GEMI-SIX-HI3"]);
    expect(symbols(cardRows(ladder("TWO", [null, null])).markets)).toEqual(["GEMI-TWO-HI0", "GEMI-TWO-HI1"]);
    expect(cardRows(event("EMPTY", { shape: "ladder", markets: [] }))).toEqual({ markets: [], quoted: false, more: 0 });
  });
});

describe("selectedContract", () => {
  const hourly = ladder("BTC2611142300", [[9100, 9500], [5200, 5600], [300, 700]]);

  it("is the contract the link names", () => {
    expect(selectedContract(hourly, "GEMI-BTC2611142300-HI2")?.symbol).toBe("GEMI-BTC2611142300-HI2");
  });

  it("is the contract the card ranks first when the link names none, or one that is not in the event", () => {
    expect(selectedContract(hourly, null)?.symbol).toBe("GEMI-BTC2611142300-HI1");
    expect(selectedContract(hourly, "GEMI-ETH2611152200-HI0")?.symbol).toBe("GEMI-BTC2611142300-HI1");
    expect(selectedContract(ladder("XAU2611152200", [null, null, null, null, null]), null)?.symbol).toBe("GEMI-XAU2611152200-HI2");
  });

  it("is the one contract of a binary event, and nothing for an event without contracts", () => {
    const binary = event("BTC15M2611142215");
    expect(selectedContract(binary, null)).toBe(binary.markets[0]);
    expect(selectedContract(event("EMPTY", { markets: [] }), null)).toBeNull();
  });
});

describe("labels", () => {
  it("names every cadence", () => {
    expect((["5m", "15m", "hourly", "daily", "weekly", "monthly", "other"] as const).map(cadenceLabel)).toEqual(["5 min", "15 min", "Hourly", "Daily", "Weekly", "Monthly", "Other"]);
  });

  it("has a volume only when something traded", () => {
    expect(volumeUnits(event("A", { volumeUnits: "4800" }))).toBe(4800n);
    expect(volumeUnits(event("B", { volumeUnits: "0" }))).toBeNull();
  });

  it("writes a volume in contracts, whole ones without decimals, and none for nothing traded", () => {
    expect(volumeText(event("A", { volumeUnits: "494000" }))).toBe("4,940 contracts traded");
    expect(volumeText(event("B", { volumeUnits: "100" }))).toBe("1 contract traded");
    expect(volumeText(event("C", { volumeUnits: "150" }))).toBe("1.50 contracts traded");
    expect(volumeText(event("D", { volumeUnits: "0" }))).toBeNull();
  });
});

describe("eventPhase", () => {
  it("is live once the first contract has started, until the event expires", () => {
    expect(eventPhase(event("A"), NOW)).toEqual({ phase: "live" });
  });

  it("opens at the first contract's start while that is ahead", () => {
    const later = event("B", { markets: [market({ startsAt: NOW + 5 * MINUTE }), market({ startsAt: NOW + 2 * MINUTE })] });
    expect(eventPhase(later, NOW)).toEqual({ phase: "upcoming", opensAt: NOW + 2 * MINUTE });
  });

  it("is upcoming without a time while the venue has listed it but not opened it", () => {
    expect(eventPhase(event("C", { venueStatus: "approved" }), NOW)).toEqual({ phase: "upcoming", opensAt: null });
  });

  it("is closed once expired or under review, and settled once the venue says so", () => {
    expect(eventPhase(event("D", { expiresAt: NOW }), NOW)).toEqual({ phase: "closed" });
    expect(eventPhase(event("E", { venueStatus: "under_review" }), NOW)).toEqual({ phase: "closed" });
    expect(eventPhase(event("F", { venueStatus: "settled", expiresAt: NOW - MINUTE }), NOW)).toEqual({ phase: "settled" });
  });
});
