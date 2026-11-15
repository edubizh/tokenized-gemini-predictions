import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@outcome/relayer/api-types";
import { deriveTimeline, type ChainOrderView, type LocalOrder, type TimelineInput } from "@/features/ticket/timeline";
import { orderAmount, orderReceipt } from "./receipt";

const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const NOW = 1_800_000_000; // chain seconds
const EXPIRES = NOW + 40;

// 2.00 YES at a limit of $0.45: cost $0.90, fee cap $0.07, hold $0.97.
const chain: ChainOrderView = { address: ADDRESS, user: "user", market: "market", side: 0, kind: 0, qtyUnits: 200n, limitPx: 4_500n, maxFee: 70_000n, expiresAt: EXPIRES, rentPayer: "user", nonce: 3n };
const local: LocalOrder = { address: ADDRESS, signature: "placeSig", symbol: "SYM", side: "YES", units: "200", limitPx: "4500", maxFeeMicros: "70000", placedAt: NOW * 1000 - 5_000, expiresAt: EXPIRES };
const api = (patch: Partial<ApiOrder>): ApiOrder => ({
  address: ADDRESS,
  user: "user",
  symbol: "SYM",
  kind: "buy",
  side: "YES",
  units: "200",
  limitPx: "4500",
  maxFeeMicros: "70000",
  expiresAt: EXPIRES,
  state: "seen",
  venueOrderId: null,
  filledUnits: "0",
  amountMicros: "0",
  feeMicros: "0",
  fills: [],
  chainSignature: null,
  detail: null,
  createdAt: NOW * 1000 - 4_000,
  updatedAt: NOW * 1000 - 1_000,
  ...patch,
});
const venue = { venueOrderId: "73615284000001117" };
const filled = { ...venue, filledUnits: "200", amountMicros: "880000", feeMicros: "40000", fills: [{ tradeId: "1", units: "200", px: "4400", feeMicros: "40000" }] };
const input = (patch: Partial<TimelineInput>): TimelineInput => ({ chainOrder: chain, apiOrder: null, local, chainNowSecs: NOW, ...patch });
const receipt = (patch: Partial<TimelineInput>) => {
  const full = input(patch);
  return orderReceipt(deriveTimeline(full), full.apiOrder);
};

describe("orderReceipt", () => {
  it("accounts for a filled order: cost and fee taken, the rest of the hold returned", () => {
    const filledReceipt = receipt({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...filled, chainSignature: "fillSig" }) });
    expect(filledReceipt).toEqual({
      venueOrderId: "73615284000001117",
      fills: [{ tradeId: "1", units: 200n, px: 4_400n, feeMicros: 40_000n }],
      heldMicros: 970_000n,
      costMicros: 880_000n,
      feeMicros: 40_000n,
      returnedMicros: 50_000n,
      signatures: [
        { label: "Held on Solana", signature: "placeSig" },
        { label: "Tokens minted", signature: "fillSig" },
      ],
    });
  });

  it("returns the whole hold when nothing filled", () => {
    const refunded = receipt({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", ...venue, chainSignature: "cancelSig" }) });
    expect(refunded).toMatchObject({ fills: [], costMicros: 0n, feeMicros: 0n, returnedMicros: 970_000n });
    expect(refunded.signatures.map((entry) => entry.label)).toEqual(["Held on Solana", "Refunded"]);
  });

  it("takes nothing for a venue fill that was never recorded on Solana", () => {
    const orphaned = receipt({ chainOrder: null, apiOrder: api({ state: "orphaned", ...filled, chainSignature: "cancelSig" }), chainNowSecs: EXPIRES + 1 });
    expect(orphaned).toMatchObject({ costMicros: 0n, feeMicros: 0n, returnedMicros: 970_000n });
    expect(orphaned.fills).toHaveLength(1);
  });

  it("has nothing returned yet while the hold is with the program", () => {
    expect(receipt({})).toMatchObject({ venueOrderId: null, heldMicros: 970_000n, costMicros: 0n, feeMicros: 0n, returnedMicros: null });
    expect(receipt({ chainNowSecs: EXPIRES + 1 }).returnedMicros).toBeNull();
  });

  it("links the user's own reclaim", () => {
    const reclaimed = orderReceipt(deriveTimeline(input({ chainOrder: null, chainNowSecs: EXPIRES + 1, local: { ...local, reclaimSignature: "reclaimSig" } })), null);
    expect(reclaimed.returnedMicros).toBe(970_000n);
    expect(reclaimed.signatures).toEqual([
      { label: "Held on Solana", signature: "placeSig" },
      { label: "Refunded", signature: "reclaimSig" },
    ]);
  });
});

describe("orderAmount of a buy", () => {
  it("is the hold while the order is open and when nothing filled", () => {
    expect(orderAmount(receipt({}))).toBe(970_000n);
    expect(orderAmount(receipt({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", ...venue, chainSignature: "cancelSig" }) }))).toBe(970_000n);
  });

  it("is the cost and the fee once a fill is recorded on Solana", () => {
    expect(orderAmount(receipt({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...filled, chainSignature: "fillSig" }) }))).toBe(920_000n);
  });
});

describe("a sell", () => {
  // 3.00 YES at no less than $0.55, filled as a buy of NO at $0.44: $1.68 of proceeds, $0.06 of fee.
  const sellChain: ChainOrderView = { ...chain, kind: 1, qtyUnits: 300n, limitPx: 5_500n, maxFee: 90_000n };
  const sellLocal: LocalOrder = { ...local, kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000" };
  const sellApi = (patch: Partial<ApiOrder>) => api({ kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000", ...patch });
  const sold = { ...venue, filledUnits: "300", amountMicros: "1680000", feeMicros: "60000", fills: [{ tradeId: "1", units: "300", px: "4400", feeMicros: "60000" }] };
  const sellInput = (patch: Partial<TimelineInput>): TimelineInput => ({ chainOrder: sellChain, apiOrder: null, local: sellLocal, chainNowSecs: NOW, ...patch });
  const sellReceipt = (patch: Partial<TimelineInput>) => {
    const full = sellInput(patch);
    return orderReceipt(deriveTimeline(full), full.apiOrder);
  };

  it("accounts for a filled sale in tokens held and test dollars paid", () => {
    const filledReceipt = sellReceipt({ chainOrder: null, apiOrder: sellApi({ state: "chain_filled", ...sold, chainSignature: "fillSig" }) });
    expect(filledReceipt).toMatchObject({
      heldMicros: 0n,
      feeMicros: 60_000n,
      // The fill is shown at the price the sale brought, not the price of the opposite buy.
      fills: [{ tradeId: "1", units: 300n, px: 5_600n, feeMicros: 60_000n }],
      sale: { heldUnits: 300n, proceedsMicros: 1_680_000n, paidMicros: 1_620_000n, returnedUnits: 0n },
    });
    expect(filledReceipt.signatures.map((entry) => entry.label)).toEqual(["Held on Solana", "Tokens burned"]);
  });

  it("returns every token when nothing filled, and nothing yet while the order is open", () => {
    expect(sellReceipt({ chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", ...venue, chainSignature: "cancelSig" }) }).sale).toEqual({ heldUnits: 300n, proceedsMicros: 0n, paidMicros: 0n, returnedUnits: 300n });
    expect(sellReceipt({}).sale).toEqual({ heldUnits: 300n, proceedsMicros: 0n, paidMicros: null, returnedUnits: null });
  });

  it("amounts to the test dollars paid once filled, and to nothing before or without a fill", () => {
    expect(orderAmount(sellReceipt({ chainOrder: null, apiOrder: sellApi({ state: "chain_filled", ...sold, chainSignature: "fillSig" }) }))).toBe(1_620_000n);
    expect(orderAmount(sellReceipt({}))).toBeNull();
    expect(orderAmount(sellReceipt({ chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", ...venue, chainSignature: "cancelSig" }) }))).toBeNull();
  });

  it("has no sale part for a buy", () => {
    expect(receipt({}).sale).toBeUndefined();
  });
});
