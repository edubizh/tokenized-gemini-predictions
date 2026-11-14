import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@outcome/relayer/api-types";
import { deriveTimeline, type ChainOrderView, type LocalOrder, type TimelineInput } from "@/features/ticket/timeline";
import { orderReceipt, outcomeWords } from "./receipt";

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
const words = (patch: Partial<TimelineInput>) => outcomeWords(deriveTimeline(input(patch)));
const receipt = (patch: Partial<TimelineInput>) => {
  const full = input(patch);
  return orderReceipt(deriveTimeline(full), full.apiOrder);
};

describe("outcomeWords", () => {
  it("says where an open order is", () => {
    expect(words({})).toBe("Waiting for the relayer.");
    expect(words({ apiOrder: api({ state: "submitting", ...venue }) })).toBe("Waiting for the venue's answer.");
    expect(words({ apiOrder: api({ state: "venue_filled", ...filled }) })).toBe("Minting your tokens.");
  });

  it("says what a fill gave", () => {
    expect(words({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...filled, chainSignature: "fillSig" }) })).toBe(
      "Filled 2.00 at $0.44. 2.00 YES tokens minted. $0.05 of the hold returned.",
    );
  });

  it("says why nothing was bought and that the hold came back", () => {
    expect(words({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", ...venue, chainSignature: "cancelSig" }) })).toBe("No fill at your limit. Hold returned in full.");
    expect(words({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail: "expiry_window", chainSignature: "cancelSig" }) })).toBe(
      "Not sent: the order arrived too close to the close. Hold returned in full.",
    );
  });

  it("points an expired order at Reclaim", () => {
    expect(words({ chainNowSecs: EXPIRES + 1 })).toBe("Expired. Reclaim your hold.");
  });
});

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
