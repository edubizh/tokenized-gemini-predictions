import { describe, expect, it } from "vitest";
import { toContract, toDepth, toEvent, toHistory, toTrades } from "../src/venue/gemini/payloads.ts";
import { EVENT, LADDER, SYMBOL, TERMS_URL, contractRow, eventRow, ladderRow, richText, strikeRow } from "./gemini-fakes.ts";
import type { Row } from "./gemini-fakes.ts";

/** Maps an event that must not lose a contract. */
function mapped(row: Row) {
  return toEvent(row, (reason) => {
    throw new Error(`unexpected skip: ${reason}`);
  });
}

const QUOTED = { buy: { yes: "0.23", no: "0.97" }, sell: { yes: "0.03", no: "0.77" }, bestBid: "0.03", bestAsk: "0.23" };

describe("toEvent: shapes", () => {
  it("maps an up-or-down event with its one contract", () => {
    expect(mapped(eventRow({ volume: "48" }))).toEqual({
      ticker: EVENT,
      title: "Demo price today at 10pm EST",
      category: "Crypto",
      subcategory: ["Demo"],
      underlying: "DEMO",
      shape: "binary",
      cadence: "15m",
      description: "Interval DEMO price prediction event expiring on November 13, 2026 at 10pm ET",
      source: { agency: "demo-agency", index: "DEMO-INDEX-USD" },
      termsUrl: TERMS_URL,
      listedAt: new Date("2026-11-14T02:38:30.000Z"),
      expiresAt: new Date("2026-11-14T03:00:00.000Z"),
      status: "active",
      volumeUnits: 4_800n,
      contracts: [
        {
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
        },
      ],
    });
  });

  it("maps a ladder: any type but binary, contracts ascending by sort order, each with its strike", () => {
    const event = mapped(
      ladderRow([strikeRow("0.86", 2), strikeRow("0.82", 0, { prices: { ...QUOTED, lastTradePrice: "0.08" } }), strikeRow("0.84", 1)], {
        category: "Commodities",
        subcategory: { id: 67, slug: "commodities_precious-metals_demo", name: "Demo", path: ["Commodities", "Precious Metals", "Demo"] },
        sourceDetails: { agency: "demo-equities", index: "DM_RFR_DEMOUSD" },
        source: undefined,
        startTime: undefined,
      }),
    );
    expect(event).toMatchObject({
      ticker: LADDER,
      shape: "ladder",
      cadence: "hourly",
      category: "Commodities",
      subcategory: ["Precious Metals", "Demo"],
      underlying: "DEMO",
      source: { agency: "demo-equities", index: "DM_RFR_DEMOUSD" },
    });
    expect(event.contracts.map((contract) => [contract.symbol, contract.sortOrder, contract.label, contract.strike])).toEqual([
      [`GEMI-${LADDER}-HI0D82`, 0, "$0.82 or above", "0.82"],
      [`GEMI-${LADDER}-HI0D84`, 1, "$0.84 or above", "0.84"],
      [`GEMI-${LADDER}-HI0D86`, 2, "$0.86 or above", "0.86"],
    ]);
    expect(event.contracts[0]).toMatchObject({ eventTicker: LADDER, bestBidPx: 300n, bestAskPx: 2_300n, lastPx: 800n });

    expect(mapped(eventRow({ type: "something-new" })).shape).toBe("ladder");
  });
});

describe("toEvent: cadence", () => {
  it.each([
    ["five-minute", "5m"],
    ["fifteen-minute", "15m"],
    ["hourly", "hourly"],
    ["daily", "daily"],
    ["monthly", "monthly"],
  ])("takes it from the event tag %s", (slug, cadence) => {
    // The contract itself runs for a week, so only the tag can give this answer.
    const week = contractRow({ effectiveDate: "2026-11-07T03:00:00.000Z" });
    const eventTags = [{ id: 8, name: "Reference", slug: "reference" }, { id: 1, name: "Tag", slug }];
    expect(mapped(eventRow({ contracts: [week], eventTags })).cadence).toBe(cadence);
  });

  it.each([
    ["2026-11-14T02:55:00.000Z", "5m"],
    ["2026-11-14T02:54:59.000Z", "15m"],
    ["2026-11-14T02:45:00.000Z", "15m"],
    ["2026-11-14T02:00:00.000Z", "hourly"],
    ["2026-11-14T01:30:00.000Z", "hourly"],
    ["2026-11-13T03:00:00.000Z", "daily"],
    ["2026-11-12T15:00:00.000Z", "daily"],
    ["2026-11-06T10:27:00.000Z", "weekly"],
    ["2026-11-04T03:00:00.000Z", "weekly"],
    ["2026-10-14T21:00:00.000Z", "monthly"],
    ["2026-11-14T03:00:00.000Z", "other"],
    ["2026-11-14T04:00:00.000Z", "other"],
  ])("takes it from the contract's life when no tag says it: trading from %s is %s", (effectiveDate, cadence) => {
    const contracts = [contractRow({ effectiveDate })];
    expect(mapped(eventRow({ contracts, eventTags: [{ id: 8, name: "Reference", slug: "reference" }] })).cadence).toBe(cadence);
    expect(mapped(eventRow({ contracts, eventTags: undefined })).cadence).toBe(cadence);
  });

  it("measures the contract's life from the contract's own start, not the event's", () => {
    // The event was listed a day before its 15-minute window, and its own effective date says so.
    const event = eventRow({ createdAt: "2026-11-13T02:45:00.000Z", effectiveDate: "2026-11-13T02:45:00.000Z", eventTags: [] });
    expect(mapped(event)).toMatchObject({ cadence: "15m", listedAt: new Date("2026-11-13T02:45:00.000Z") });
    expect(mapped(event).contracts[0]!.effectiveAt).toEqual(new Date("2026-11-14T02:45:00.000Z"));
  });
});

describe("toEvent: event fields", () => {
  it.each([
    ["DEMO05M2611140300", "DEMO"],
    ["DEMO15M2611140300", "DEMO"],
    ["DEMO2611140300", "DEMO"],
    ["DEMOJAN26", "DEMOJAN"],
    ["DEMO-2611140300-AAA-BBB-M", "DEMO"],
    ["2611140300", "2611140300"],
  ])("reads the underlying of %s as %s", (ticker, underlying) => {
    expect(mapped(eventRow({ ticker })).underlying).toBe(underlying);
  });

  it("counts volume in units and reads an unreadable volume as none", () => {
    expect(mapped(eventRow({ volume: "47.78" })).volumeUnits).toBe(4_778n);
    expect(mapped(eventRow({ volume: "0" })).volumeUnits).toBe(0n);
    expect(mapped(eventRow({ volume: undefined })).volumeUnits).toBe(0n);
    expect(mapped(eventRow({ volume: "a lot" })).volumeUnits).toBe(0n);
  });

  it("leaves out what the venue does not name", () => {
    const bare = mapped(eventRow({ title: undefined, category: undefined, subcategory: undefined, description: undefined, sourceDetails: undefined, termsLink: undefined, status: 7 }));
    expect(bare).toMatchObject({ title: EVENT, category: "", subcategory: [], description: "", source: null, termsUrl: null, status: "unknown" });
    expect(mapped(eventRow({ sourceDetails: { agency: "demo-agency" } })).source).toBeNull();
    // The terms url becomes a link on a page: nothing but https is passed on.
    expect(mapped(eventRow({ termsLink: "javascript:alert(1)" })).termsUrl).toBeNull();
  });
});

describe("toEvent: quotes", () => {
  const quotes = (prices: unknown) => {
    const { bestBidPx, bestAskPx, lastPx } = mapped(eventRow({ contracts: [contractRow({ prices })] })).contracts[0]!;
    return { bestBidPx, bestAskPx, lastPx };
  };

  it("reads no quote, one side, both sides and a last trade in YES price space", () => {
    expect(quotes({ buy: {}, sell: {} })).toEqual({ bestBidPx: null, bestAskPx: null, lastPx: null });
    expect(quotes({ buy: { no: "0.98" }, sell: { yes: "0.02" }, bestBid: "0.02" })).toEqual({ bestBidPx: 200n, bestAskPx: null, lastPx: null });
    expect(quotes({ buy: { yes: "0.4" }, sell: { no: "0.6" }, bestAsk: "0.4" })).toEqual({ bestBidPx: null, bestAskPx: 4_000n, lastPx: null });
    expect(quotes(QUOTED)).toEqual({ bestBidPx: 300n, bestAskPx: 2_300n, lastPx: null });
    expect(quotes({ ...QUOTED, lastTradePrice: "0.08" })).toEqual({ bestBidPx: 300n, bestAskPx: 2_300n, lastPx: 800n });
  });

  it("reads a price it cannot use as no quote, and leaves the quotes out when the row has no prices", () => {
    expect(quotes({ buy: {}, sell: {}, bestBid: "0.4", bestAsk: "soon", lastTradePrice: 1 })).toEqual({ bestBidPx: 4_000n, bestAskPx: null, lastPx: null });
    const bare = mapped(eventRow({ contracts: [contractRow({ prices: undefined })] })).contracts[0]!;
    expect(bare).not.toHaveProperty("bestBidPx");
    expect(bare).not.toHaveProperty("bestAskPx");
    expect(bare).not.toHaveProperty("lastPx");
  });
});

describe("toContract", () => {
  it("reduces rich-text rules to plain text, Markdown links to their text", () => {
    const rules = (description: unknown) => toContract(contractRow({ description }), EVENT).rules;
    expect(rules(richText(`Resolves to Yes at $68,000 or above. View the [full rules](${TERMS_URL}) and the [index](https://example.org/index).`))).toBe(
      "Resolves to Yes at $68,000 or above. View the full rules and the index.",
    );
    // Paragraphs and link nodes, as the rich-text format allows them.
    const nested = {
      nodeType: "document",
      content: [
        { nodeType: "paragraph", content: [{ nodeType: "text", value: "First " }, { nodeType: "hyperlink", data: { uri: TERMS_URL }, content: [{ nodeType: "text", value: "rule" }] }, { nodeType: "text", value: "." }] },
        { nodeType: "paragraph", content: [{ nodeType: "text", value: "Second rule." }] },
      ],
    };
    expect(rules(nested)).toBe("First rule.\nSecond rule.");
    expect(rules(`A flat rule with a [link](${TERMS_URL}).`)).toBe("A flat rule with a link.");
    expect(toContract(contractRow({ description: undefined }), EVENT)).not.toHaveProperty("rules");
    expect(toContract(contractRow({ description: { nodeType: "document", content: [] } }), EVENT)).not.toHaveProperty("rules");
  });

  it("reads the reference price once the venue has it, and the result once settled", () => {
    const before = toContract(contractRow(), EVENT);
    expect(before).toMatchObject({ strike: null, settlementValue: null, resolutionSide: null });

    const strike = { type: "reference", value: "64394.65", availableAt: "2026-11-14T02:45:00.000Z" };
    expect(toContract(contractRow({ strike }), EVENT).strike).toBe("64394.65");
    expect(toContract(contractRow({ strike: { type: "above", value: "3.550" } }), EVENT).strike).toBe("3.550");

    const settled = contractRow({ strike, status: "settled", marketState: "closed", resolutionSide: "YES", resolvedAt: "2026-11-14T03:00:06.000Z", settlementValue: "64394.65233333333" });
    expect(toContract(settled, EVENT)).toMatchObject({ status: "settled", marketState: "closed", resolutionSide: "yes", settlementValue: "64394.65233333333" });
    expect(toContract(contractRow({ settlementValue: 64100.125 }), EVENT).settlementValue).toBe("64100.125");
  });

  // Served by the venue: strike "6.10" labelled "$6.1 or above", "3.600" labelled "$3.6 or above".
  it("writes the label of a strike contract with the digits of its strike, and leaves any other label as the venue wrote it", () => {
    const label = (strike: string, venueLabel: string, fields: Row = {}): unknown =>
      toContract(strikeRow(strike, 0, { label: venueLabel, ...fields }), LADDER).label;
    expect(label("6.10", "$6.1 or above")).toBe("$6.10 or above");
    expect(label("3.600", "$3.6 or above")).toBe("$3.600 or above");
    expect(label("63700", "$63,700 or above")).toBe("$63,700 or above");
    expect(label("1234567.50", "$1,234,567.5 or above")).toBe("$1,234,567.50 or above");
    expect(label("0.84", "$0.84 or above")).toBe("$0.84 or above");
    // A label that is not the strike's number is the venue's own wording.
    expect(label("6.10", "$6.2 or above")).toBe("$6.2 or above");
    expect(label("6.10", "Above $6.1")).toBe("Above $6.1");
    expect(label("6.10", "$6.1 or above", { strike: { type: "reference", availableAt: "2026-11-14T02:45:00.000Z" } })).toBe("$6.1 or above");
    expect(toContract(contractRow({ strike: { type: "reference", value: "64000.10" } }), EVENT).label).toBe("Up");
  });

  it("passes unknown states through and reads the resolution side leniently", () => {
    expect(toContract(contractRow({ status: "invalid", marketState: 7, resolutionSide: "void" }), EVENT)).toMatchObject({
      status: "invalid",
      marketState: "unknown",
      resolutionSide: null,
    });
    expect(toContract(contractRow({ status: undefined }), EVENT).status).toBe("unknown");
  });

  it("upper-cases the symbol and keeps the event ticker it was given", () => {
    const odd = toContract(contractRow({ instrumentSymbol: "gemi-demo-2611140300-aaa-bbb-m-aaa1.5" }), "DEMO-2611140300-AAA-BBB-M");
    expect(odd).toMatchObject({ symbol: "GEMI-DEMO-2611140300-AAA-BBB-M-AAA1.5", eventTicker: "DEMO-2611140300-AAA-BBB-M" });
  });

  it("reads the grid in px and units, and refuses a grid it cannot trade on", () => {
    const whole = toContract(contractRow({ quantityIncrement: "1", quantityMinimum: "1", priceIncrement: "0.0001" }), EVENT);
    expect(whole).toMatchObject({ tickPx: 1n, unitIncrement: 100n, minUnits: 100n });

    for (const [field, value] of [
      ["priceIncrement", "a cent"],
      ["priceIncrement", "0.00001"],
      ["priceIncrement", "0"],
      ["quantityIncrement", null],
      ["quantityIncrement", "0.001"],
      ["quantityMinimum", undefined],
    ] as const) {
      expect(() => toContract(contractRow({ [field]: value }), EVENT)).toThrow(`contract ${SYMBOL}: unreadable ${field}`);
    }
  });

  it("refuses a row without a symbol or with a date it cannot read", () => {
    expect(() => toContract(contractRow({ instrumentSymbol: undefined }), EVENT)).toThrow(`event ${EVENT}: a contract has no symbol`);
    expect(() => toContract("GEMI-TEXT", EVENT)).toThrow(`event ${EVENT}: a contract has no symbol`);
    expect(() => toContract(contractRow({ expiryDate: "soon" }), EVENT)).toThrow(`contract ${SYMBOL}: unreadable expiryDate`);
    expect(() => toContract(contractRow({ effectiveDate: undefined }), EVENT)).toThrow(`contract ${SYMBOL}: unreadable effectiveDate`);
  });
});

describe("toEvent: malformed rows", () => {
  it("leaves a contract it cannot read out of the event and says why", () => {
    const reasons: string[] = [];
    const broken = strikeRow("0.84", 1, { quantityIncrement: null });
    const event = toEvent(ladderRow([strikeRow("0.82", 0), broken, "not a row", strikeRow("0.86", 2)]), (reason) => reasons.push(reason));
    expect(event.contracts.map((contract) => contract.strike)).toEqual(["0.82", "0.86"]);
    expect(reasons).toEqual([`contract GEMI-${LADDER}-HI0D84: unreadable quantityIncrement`, `event ${LADDER}: a contract has no symbol`]);
  });

  it("refuses an event it cannot describe", () => {
    const skip = () => {};
    expect(() => toEvent(eventRow({ ticker: undefined }), skip)).toThrow("event without a ticker");
    expect(() => toEvent(eventRow({ ticker: "" }), skip)).toThrow("event without a ticker");
    expect(() => toEvent(eventRow({ expiryDate: undefined }), skip)).toThrow(`event ${EVENT}: unreadable expiryDate`);
    expect(() => toEvent(eventRow({ createdAt: "yesterday" }), skip)).toThrow(`event ${EVENT}: unreadable createdAt`);
    expect(() => toEvent(eventRow({ contracts: undefined }), skip)).toThrow(`event ${EVENT}: no readable contract`);
    expect(() => toEvent(eventRow({ contracts: [contractRow({ priceIncrement: "?" })] }), skip)).toThrow(`event ${EVENT}: no readable contract`);
  });
});

describe("toDepth", () => {
  const book = {
    bids: [
      { price: "0.03", amount: "33.0", timestamp: "1794693211" },
      { price: "0.02", amount: "11.0", timestamp: "1794693211" },
    ],
    asks: [
      { price: "0.09", amount: "10.0", timestamp: "1794693211" },
      { price: "0.1", amount: "21.89", timestamp: "1794693211" },
      { price: "0.12", amount: "0.5", timestamp: "1794693211" },
    ],
  };

  it("reads the levels of each side in px and units, best first", () => {
    expect(toDepth(book, 10)).toEqual({
      bids: [
        { px: 300n, units: 3_300n },
        { px: 200n, units: 1_100n },
      ],
      asks: [
        { px: 900n, units: 1_000n },
        { px: 1_000n, units: 2_189n },
        { px: 1_200n, units: 50n },
      ],
    });
  });

  it("keeps at most the levels asked for, and an empty book is empty", () => {
    expect(toDepth(book, 2).asks).toHaveLength(2);
    expect(toDepth(book, 1)).toEqual({ bids: [{ px: 300n, units: 3_300n }], asks: [{ px: 900n, units: 1_000n }] });
    expect(toDepth({ bids: [], asks: [] }, 10)).toEqual({ bids: [], asks: [] });
  });

  it("reads the levels of a websocket depth answer", () => {
    const answer = { lastUpdateId: "1793265913744426", bids: [["0.8800", "11.00"], ["0.8600", "11.00"]], asks: [["0.9700", "21.00"]] };
    expect(toDepth(answer, 10)).toEqual({
      bids: [
        { px: 8_800n, units: 1_100n },
        { px: 8_600n, units: 1_100n },
      ],
      asks: [{ px: 9_700n, units: 2_100n }],
    });
  });

  it("refuses a body that is not a book, and a level it cannot read", () => {
    expect(() => toDepth([], 10)).toThrow("unexpected book response");
    expect(() => toDepth({ bids: [] }, 10)).toThrow("unexpected book response");
    expect(() => toDepth({ bids: [{ price: "cheap", amount: "1" }], asks: [] }, 10)).toThrow();
    expect(() => toDepth({ bids: [], asks: [{ price: "0.5" }] }, 10)).toThrow();
  });
});

describe("toTrades", () => {
  it("reads trades newest first, ids as text, prices in px and sizes in units", () => {
    // The trade id arrives as a bare integer; one of 16 digits or more is kept as text by the REST client.
    const tape = [
      { timestamp: 1794693909, timestampms: 1794693909020, tid: "1893456305647143", price: "0.17", amount: "1", exchange: "gemini", type: "buy" },
      { timestamp: 1794693904, timestampms: 1794693904893, tid: 893456305647139, price: "0.03", amount: "22.89", exchange: "gemini", type: "sell" },
    ];
    expect(toTrades(tape)).toEqual([
      { id: "1893456305647143", atMs: 1794693909020, px: 1_700n, units: 100n, taker: "buy" },
      { id: "893456305647139", atMs: 1794693904893, px: 300n, units: 2_289n, taker: "sell" },
    ]);
  });

  it("reads an empty tape as no trades and refuses anything that is not a tape", () => {
    expect(toTrades([])).toEqual([]);
    expect(() => toTrades({ trades: [] })).toThrow("unexpected trades response");
    expect(() => toTrades([{ timestampms: 1794693909020, tid: 7, price: "0.17", amount: "1", type: "auction" }])).toThrow("unexpected trade");
    expect(() => toTrades([{ timestampms: 1794693909020, price: "0.17", amount: "1", type: "buy" }])).toThrow("unexpected trade");
  });
});

describe("toHistory", () => {
  it("reads the closing price of each candle, oldest first", () => {
    const candles = [
      [1794693900000, 0.16, 0.17, 0.02, 0.17, 47.78],
      [1794693840000, 0.16, 0.16, 0.16, 0.1, 0],
      [1794693780000, 0.03, 0.16, 0.03, 0.16, 0.22],
    ];
    expect(toHistory(candles)).toEqual([
      { atMs: 1794693780000, px: 1_600n },
      { atMs: 1794693840000, px: 1_000n },
      { atMs: 1794693900000, px: 1_700n },
    ]);
  });

  it("reads no candles as an empty history and refuses anything that is not a list of candles", () => {
    expect(toHistory([])).toEqual([]);
    expect(() => toHistory({})).toThrow("unexpected candles response");
    expect(() => toHistory([[1794693900000, 0.16]])).toThrow("unexpected candle");
    expect(() => toHistory([["then", 0.16, 0.17, 0.02, 0.17, 1]])).toThrow("unexpected candle");
  });
});
