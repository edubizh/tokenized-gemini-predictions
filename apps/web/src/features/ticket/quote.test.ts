import { describe, expect, it } from "vitest";
import type { ApiHealth, ApiMarket } from "@outcome/relayer/api-types";
import { buildFixtures } from "@/lib/relayer/fixtures";
import { availableAt, askPx, bidPx, wantedAt } from "@/features/markets/book";
import { MIN_LAMPORTS, parseContracts, parsePrice, quoteBuy, quoteSell, type QuoteInput, type SellQuoteInput } from "./quote";

const fixtures = buildFixtures(Date.UTC(2026, 10, 15, 3, 0, 0));
const market = fixtures.markets[0] as ApiMarket; // bid 0.55, ask 0.57, 250.00 bid, 180.00 offered
const health = fixtures.health;
const rich = { lamports: 50_000_000n, stableMicros: 1_000_000_000n };
const input = (patch: Partial<QuoteInput> = {}): QuoteInput => ({ side: "YES", units: 200n, limitPx: 4_500n, market, health, balances: rich, ...patch });
const codes = (patch: Partial<QuoteInput>) => quoteBuy(input(patch)).errors.map((e) => e.code);

describe("quoteBuy", () => {
  it("holds the cost at the limit plus the fee cap", () => {
    const quote = quoteBuy(input());
    expect(quote.costMicros).toBe(900_000n); // 2.00 x $0.45
    expect(quote.maxFeeMicros).toBe(70_000n); // 4 cents of fee at $0.45, plus 3 cents of slack
    expect(quote.holdMicros).toBe(970_000n);
    expect(quote.payoutMicros).toBe(2_000_000n);
    expect(quote.errors).toEqual([]);
  });
  it("caps the fee at its 50 cent peak when the limit is above it", () => {
    // 5.00 at $0.57: fee at $0.50 is ceil(8.75) = 9 cents
    expect(quoteBuy(input({ units: 500n, limitPx: 5_700n })).maxFeeMicros).toBe(120_000n);
  });
  it("uses the relayer's fee slack", () => {
    const tight: ApiHealth = { ...health, feeSlackMicros: "0" };
    expect(quoteBuy(input({ health: tight })).maxFeeMicros).toBe(40_000n);
  });
  it("says what quantity is allowed", () => {
    const limits: ApiHealth = { ...health, minOrderUnits: "100", maxOrderUnits: "100000" };
    expect(quoteBuy(input({ units: 50n, health: limits })).errors).toEqual([{ field: "quantity", code: "below_min", message: "Minimum is 1.00 contracts." }]);
    expect(quoteBuy(input({ units: 100_001n, health: limits })).errors[0]).toEqual({ field: "quantity", code: "above_max", message: "Maximum is 1,000.00 contracts." });
    expect(quoteBuy(input({ units: null })).errors[0]).toEqual({ field: "quantity", code: "not_a_number", message: "Enter a quantity in contracts, such as 1.00." });
    expect(quoteBuy(input({ units: 0n })).errors[0]?.message).toBe("Minimum is 0.01 contracts.");
  });
  it("takes the larger of the venue's and the program's minimum, and the venue's increment", () => {
    const stepped: ApiMarket = { ...market, minUnits: "10", unitIncrement: "10" };
    expect(quoteBuy(input({ market: stepped, units: 5n })).errors[0]?.message).toBe("Minimum is 0.10 contracts.");
    expect(quoteBuy(input({ market: stepped, units: 25n })).errors[0]).toEqual({ field: "quantity", code: "off_increment", message: "Quantity must be a multiple of 0.10 contracts." });
  });
  it("says what price is allowed", () => {
    expect(quoteBuy(input({ limitPx: null })).errors[0]).toEqual({ field: "price", code: "not_a_number", message: "Enter a price in dollars, such as 0.57." });
    expect(quoteBuy(input({ limitPx: 0n })).errors[0]).toEqual({ field: "price", code: "out_of_range", message: "Price must be between $0.01 and $0.99." });
    expect(quoteBuy(input({ limitPx: 10_000n })).errors[0]?.code).toBe("out_of_range");
    expect(quoteBuy(input({ limitPx: 4_550n })).errors[0]).toEqual({ field: "price", code: "off_tick", message: "Price must be a multiple of $0.01." });
  });
  it("reports no amounts while the quantity or the price is invalid", () => {
    const quote = quoteBuy(input({ limitPx: 0n }));
    expect([quote.costMicros, quote.maxFeeMicros, quote.holdMicros, quote.payoutMicros]).toEqual([0n, 0n, 0n, 0n]);
  });
  it("needs enough test dollars for the hold", () => {
    const quote = quoteBuy(input({ balances: { lamports: 50_000_000n, stableMicros: 500_000n } }));
    expect(quote.errors).toEqual([{ field: "funds", code: "not_enough_dollars", message: "This order holds $0.97. You have $0.50 in test dollars." }]);
    expect(codes({ balances: { lamports: 50_000_000n, stableMicros: 970_000n } })).toEqual([]);
  });
  it("needs SOL for fees and for the order's rent", () => {
    expect(quoteBuy(input({ balances: { lamports: MIN_LAMPORTS - 1n, stableMicros: 1_000_000_000n } })).errors).toEqual([
      { field: "sol", code: "not_enough_sol", message: "Not enough SOL for network fees. Get test funds to top up." },
    ]);
  });
  it("gives the reason when the market cannot be traded", () => {
    const closed: ApiMarket = { ...market, tradable: false, notTradableReason: "too_close_to_expiry" };
    expect(quoteBuy(input({ market: closed })).errors).toEqual([{ field: "market", code: "not_tradable", message: "Orders closed" }]);
  });
  it("blocks while trading is paused or the relayer is offline", () => {
    expect(quoteBuy(input({ health: { ...health, paused: { place: true, fill: false } } })).errors).toEqual([
      { field: "market", code: "paused", message: "Trading is paused. Orders already placed are not affected." },
    ]);
    expect(quoteBuy(input({ health: null })).errors).toEqual([
      { field: "market", code: "relayer_offline", message: "The relayer is offline, so new orders cannot be filled." },
    ]);
  });
  it("does not complain about funds before the balances are known", () => {
    expect(codes({ balances: null })).toEqual([]);
  });
});

describe("quoteSell", () => {
  // 3.00 YES at no less than $0.55. The venue order is a buy of NO at $0.45.
  const sell = (patch: Partial<SellQuoteInput> = {}): SellQuoteInput => ({ side: "YES", units: 300n, minPx: 5_500n, market, health, balances: rich, heldUnits: 300n, ...patch });

  it("pays at least the proceeds at the minimum less the fee cap of the opposite buy", () => {
    const quote = quoteSell(sell());
    expect(quote.proceedsMicros).toBe(1_650_000n); // 3.00 x $0.55
    expect(quote.maxFeeMicros).toBe(90_000n); // 6 cents of fee at $0.45, plus 3 cents of slack
    expect(quote.receiveMicros).toBe(1_560_000n);
    expect(quote.errors).toEqual([]);
  });
  it("takes the fee cap at the complement of the minimum price", () => {
    // 5.00 at $0.30: the venue buy is at $0.70, so the fee is capped at its 50 cent peak, 9 cents.
    expect(quoteSell(sell({ units: 500n, minPx: 3_000n, heldUnits: 500n })).maxFeeMicros).toBe(120_000n);
    expect(quoteSell(sell({ health: { ...health, feeSlackMicros: "0" } })).maxFeeMicros).toBe(60_000n);
  });
  it("refuses a sale whose minimum proceeds do not exceed the fee cap, and names the smallest quantity that would", () => {
    // 3.00 at $0.03 brings $0.09, and the fee cap is $0.09.
    const quote = quoteSell(sell({ minPx: 300n, heldUnits: 1_000n }));
    expect(quote.errors).toEqual([{ field: "fee", code: "fee_cap", message: "At $0.03 a sale needs at least 3.01 contracts to cover the fee cap." }]);
    expect(quote.minSellUnits).toBe(301n);
    expect(quote.receiveMicros).toBe(0n);
    const enough = quoteSell(sell({ units: 301n, minPx: 300n, heldUnits: 1_000n }));
    expect(enough.errors).toEqual([]);
    expect(enough.receiveMicros).toBe(300n);
  });
  it("says so when no quantity can cover the fee cap at a price", () => {
    const quote = quoteSell(sell({ minPx: 100n, heldUnits: 100_000n }));
    expect(quote.minSellUnits).toBeNull();
    expect(quote.errors).toEqual([{ field: "fee", code: "fee_cap", message: "At $0.01 a sale cannot cover the fee cap at any quantity. Set a higher minimum price." }]);
  });
  it("sells no more than the wallet holds", () => {
    expect(quoteSell(sell({ units: 301n })).errors).toEqual([{ field: "quantity", code: "above_held", message: "You hold 3.00 YES. That is the most you can sell." }]);
    expect(quoteSell(sell({ side: "NO", heldUnits: 0n })).errors[0]).toEqual({ field: "quantity", code: "nothing_held", message: "You hold no NO tokens of this market." });
    expect(quoteSell(sell({ units: 5_000n, heldUnits: null })).errors).toEqual([]);
  });
  it("applies the venue's quantity rules and the program's maximum, but not the minimum for buys", () => {
    const limits: ApiHealth = { ...health, minOrderUnits: "100", maxOrderUnits: "200" };
    expect(quoteSell(sell({ units: 50n, health: limits })).errors).toEqual([]);
    expect(quoteSell(sell({ units: 201n, health: limits })).errors[0]).toEqual({ field: "quantity", code: "above_max", message: "Maximum is 2.00 contracts." });
    expect(quoteSell(sell({ units: null })).errors[0]?.code).toBe("not_a_number");
    expect(quoteSell(sell({ units: 0n })).errors[0]?.message).toBe("Minimum is 0.01 contracts.");
    expect(quoteSell(sell({ units: 25n, market: { ...market, minUnits: "10", unitIncrement: "10" } })).errors[0]?.code).toBe("off_increment");
  });
  it("says what minimum price is allowed", () => {
    expect(quoteSell(sell({ minPx: null })).errors[0]).toEqual({ field: "price", code: "not_a_number", message: "Enter a price in dollars, such as 0.57." });
    expect(quoteSell(sell({ minPx: 10_000n })).errors[0]).toEqual({ field: "price", code: "out_of_range", message: "Price must be between $0.01 and $0.99." });
    expect(quoteSell(sell({ minPx: 5_550n })).errors[0]?.code).toBe("off_tick");
    const invalid = quoteSell(sell({ minPx: 0n }));
    expect([invalid.proceedsMicros, invalid.maxFeeMicros, invalid.receiveMicros]).toEqual([0n, 0n, 0n]);
  });
  it("needs SOL for the order's rent but no test dollars", () => {
    expect(quoteSell(sell({ balances: { lamports: 50_000_000n, stableMicros: 0n } })).errors).toEqual([]);
    expect(quoteSell(sell({ balances: { lamports: MIN_LAMPORTS - 1n, stableMicros: 0n } })).errors.map((e) => e.code)).toEqual(["not_enough_sol"]);
  });
  it("blocks for the same market reasons as a buy", () => {
    expect(quoteSell(sell({ health: null })).errors.map((e) => e.code)).toEqual(["relayer_offline"]);
    expect(quoteSell(sell({ health: { ...health, paused: { place: true, fill: false } } })).errors.map((e) => e.code)).toEqual(["paused"]);
    expect(quoteSell(sell({ market: { ...market, tradable: false, notTradableReason: "too_close_to_expiry" } })).errors).toEqual([{ field: "market", code: "not_tradable", message: "Orders closed" }]);
  });
});

describe("the book", () => {
  it("bids for NO at one dollar minus the YES ask", () => {
    expect(bidPx(market, "YES")).toBe(5_500n);
    expect(bidPx(market, "NO")).toBe(4_300n);
    expect(bidPx({ book: null }, "YES")).toBeNull();
  });
  it("gives what buyers want at a minimum", () => {
    expect(wantedAt(market, "YES", 5_500n)).toBe(25_000n);
    expect(wantedAt(market, "YES", 5_600n)).toBe(0n);
    expect(wantedAt(market, "NO", 4_300n)).toBe(18_000n);
    expect(wantedAt({ ...market, book: null }, "YES", 5_500n)).toBeNull();
  });
  it("prices NO as one dollar minus the YES bid", () => {
    expect(askPx(market, "YES")).toBe(5_700n);
    expect(askPx(market, "NO")).toBe(4_500n);
  });
  it("gives what is offered at a limit", () => {
    expect(availableAt(market, "YES", 5_700n)).toBe(18_000n);
    expect(availableAt(market, "YES", 5_600n)).toBe(0n);
    expect(availableAt(market, "NO", 4_500n)).toBe(25_000n);
    expect(availableAt({ ...market, book: null }, "YES", 5_700n)).toBeNull();
  });
});

describe("parsing what was typed", () => {
  it("reads contracts with up to two decimals", () => {
    expect(parseContracts("5")).toBe(500n);
    expect(parseContracts("1.5")).toBe(150n);
    expect(parseContracts(" 2.00 ")).toBe(200n);
    expect(parseContracts(".25")).toBe(25n);
    expect(parseContracts("1.005")).toBeNull();
    expect(parseContracts("")).toBeNull();
    expect(parseContracts("abc")).toBeNull();
  });
  it("reads a price in dollars, keeping an off-tick price for the quote to refuse", () => {
    expect(parsePrice("0.57")).toBe(5_700n);
    expect(parsePrice(".5")).toBe(5_000n);
    expect(parsePrice("0.455")).toBe(4_550n);
    expect(parsePrice("1")).toBe(10_000n);
    expect(parsePrice("0.12345")).toBeNull();
    expect(parsePrice("")).toBeNull();
  });
});
