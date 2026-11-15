import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@outcome/relayer/api-types";
import { deriveTimeline, type ChainOrderView, type LocalOrder, type TimelineInput } from "./timeline";

const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const NOW = 1_800_000_000; // chain seconds
const EXPIRES = NOW + 40;
const PLACE_SIG = "placeSig";

// 2.00 YES at a limit of $0.45: cost $0.90, fee cap $0.07, hold $0.97.
const chain: ChainOrderView = { address: ADDRESS, user: "user", market: "market", side: 0, kind: 0, qtyUnits: 200n, limitPx: 4_500n, maxFee: 70_000n, expiresAt: EXPIRES, rentPayer: "user", nonce: 3n };
const local: LocalOrder = { address: ADDRESS, signature: PLACE_SIG, symbol: "SYM", side: "YES", units: "200", limitPx: "4500", maxFeeMicros: "70000", placedAt: NOW * 1000 - 5_000, expiresAt: EXPIRES };
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
const filled = { venueOrderId: "73615284000001117", filledUnits: "200", amountMicros: "880000", feeMicros: "40000", fills: [{ tradeId: "1", units: "200", px: "4400", feeMicros: "40000" }] };
const derive = (patch: Partial<TimelineInput>) => deriveTimeline({ chainOrder: chain, apiOrder: null, local, chainNowSecs: NOW, ...patch });
const shape = (t: ReturnType<typeof deriveTimeline>) => t.steps.map((s) => `${s.status}:${s.text}`);

describe("deriveTimeline", () => {
  it("always has the four steps in order", () => {
    expect(derive({}).steps.map((s) => s.id)).toEqual(["held", "sent", "filled", "result"]);
  });

  it("waits for the relayer right after the order is placed", () => {
    const t = derive({ chainOrder: undefined });
    expect(t.steps[0]).toMatchObject({ status: "done", title: "Held on Solana", text: "$0.97 held", signature: PLACE_SIG, atMs: local.placedAt });
    expect(t.steps[1]).toMatchObject({ status: "current", title: "Sent to the venue", text: "Waiting for the relayer" });
    expect(t.steps.slice(2).map((s) => s.status)).toEqual(["pending", "pending"]);
    expect(t).toMatchObject({ stamp: "OPEN", open: true, canReclaim: false, expiresAt: EXPIRES, holdMicros: 970_000n });
  });

  it("shows the relayer picking the order up, then the order at the venue", () => {
    expect(derive({ apiOrder: api({ state: "seen" }) }).steps[1]).toMatchObject({ status: "current", text: "The relayer has the order and is sending it" });
    const sent = derive({ apiOrder: api({ state: "submitting", venueOrderId: "73615284000001117" }) });
    expect(shape(sent)).toEqual([
      "done:$0.97 held",
      "done:Order sent, fill-or-kill at 45¢",
      "current:Waiting for the venue's answer",
      "pending:",
    ]);
  });

  it("reports a fill with the average price and the venue order id", () => {
    const t = derive({ apiOrder: api({ state: "venue_filled", ...filled }) });
    expect(t.steps[2]).toMatchObject({ status: "done", title: "Filled", text: "Filled 2.00 at 44¢", detail: "Venue order 73615284000001117" });
    expect(t.steps[3]).toMatchObject({ status: "current", title: "Tokens minted", text: "Minting your tokens" });
    expect(t.stamp).toBe("OPEN");
  });

  it("averages several fills", () => {
    const fills = [
      { tradeId: "1", units: "100", px: "4400", feeMicros: "20000" },
      { tradeId: "2", units: "100", px: "4200", feeMicros: "20000" },
    ];
    const t = derive({ apiOrder: api({ state: "venue_filled", ...filled, amountMicros: "860000", fills }) });
    expect(t.steps[2]?.text).toBe("Filled 2.00 at 43¢");
  });

  it("ends a fill with the tokens and what came back from the hold", () => {
    const t = derive({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...filled, chainSignature: "fillSig" }) });
    expect(t.steps[3]).toMatchObject({ status: "done", title: "Tokens minted", text: "2.00 Yes tokens minted. $0.05 of the hold returned.", signature: "fillSig" });
    expect(t).toMatchObject({ stamp: "FILLED", open: false, canReclaim: false });
  });

  it("leaves out the refund sentence when the whole hold was used", () => {
    const exact = { ...filled, amountMicros: "900000", feeMicros: "70000" };
    const t = derive({ chainOrder: null, apiOrder: api({ state: "chain_filled", ...exact, chainSignature: "fillSig" }) });
    expect(t.steps[3]?.text).toBe("2.00 Yes tokens minted.");
  });

  it("describes an order that did not fill in words, then the refund", () => {
    const waiting = derive({ apiOrder: api({ state: "venue_not_filled", venueOrderId: "7" }) });
    expect(waiting.steps[2]).toMatchObject({ status: "skipped", title: "Not filled", text: "No fill at your limit" });
    expect(waiting.steps[3]).toMatchObject({ status: "current", text: "Returning your hold" });

    const done = derive({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", venueOrderId: "7", chainSignature: "cancelSig" }) });
    expect(shape(done)).toEqual(["done:$0.97 held", "done:Order sent, fill-or-kill at 45¢", "skipped:No fill at your limit", "done:Hold returned in full."]);
    expect(done.steps[3]).toMatchObject({ title: "Refunded", signature: "cancelSig" });
    expect(done).toMatchObject({ stamp: "REFUNDED", open: false });
  });

  it.each([
    ["expiry_window", "Not sent: the order arrived too close to the close."],
    ["book_side_empty", "Not sent: there were no offers on that side."],
    ["fee_cap", "Not sent: the fee cap was too low."],
    ["not_tradable:too_close_to_expiry", "Not sent: the market was not tradable."],
    ["contract_missing", "Not sent: the market was not tradable."],
    ["bad_order_values", "Not sent: the relayer did not accept the order's values."],
  ])("says why the relayer refused before sending (%s)", (detail, words) => {
    const t = derive({ chainOrder: null, apiOrder: api({ state: "chain_cancelled", detail, chainSignature: "cancelSig" }) });
    expect(t.steps[1]).toMatchObject({ status: "skipped", title: "Not sent", text: words });
    expect(t.steps[2]).toMatchObject({ status: "skipped", title: "Not filled", text: "Nothing was bought" });
    expect(t.steps[3]).toMatchObject({ status: "done", text: "Hold returned in full.", signature: "cancelSig" });
  });

  it("offers Reclaim for an order that expired while still open", () => {
    const t = derive({ chainNowSecs: EXPIRES + 1 });
    expect(t.steps[1]).toMatchObject({ status: "skipped", text: "The relayer did not pick this order up in time" });
    expect(t.steps[3]).toMatchObject({ status: "current", title: "Refund", text: "Expired. Reclaim your hold." });
    expect(t).toMatchObject({ stamp: "EXPIRED", open: true, canReclaim: true });
  });

  it("does not offer Reclaim at the expiry second itself, or before the order account has been read", () => {
    expect(derive({ chainNowSecs: EXPIRES }).canReclaim).toBe(false);
    expect(derive({ chainNowSecs: EXPIRES + 1, chainOrder: undefined }).canReclaim).toBe(false);
  });

  it("shows a reclaimed order as refunded, with the reclaim transaction", () => {
    const t = derive({ chainOrder: null, chainNowSecs: EXPIRES + 30, local: { ...local, reclaimSignature: "reclaimSig" } });
    expect(t.steps[3]).toMatchObject({ status: "done", title: "Refunded", text: "Hold returned in full.", signature: "reclaimSig" });
    expect(t).toMatchObject({ stamp: "REFUNDED", open: false, canReclaim: false });
  });

  it("says in plain words when the venue has not confirmed the result", () => {
    const t = derive({ apiOrder: api({ state: "venue_unknown", venueOrderId: "7" }) });
    expect(t.steps[2]).toMatchObject({ status: "current", text: "The venue has not confirmed the result. The relayer is checking." });
    const late = derive({ apiOrder: api({ state: "venue_unknown", venueOrderId: "7" }), chainNowSecs: EXPIRES + 1 });
    expect(late.steps[2]).toMatchObject({ status: "skipped", text: "The venue did not confirm a fill before the order expired" });
    expect(late.steps[3]?.text).toBe("Expired. Reclaim your hold.");
    expect(late.canReclaim).toBe(true);
  });

  it("explains an orphaned order: filled too late, nothing minted", () => {
    const refunded = derive({ chainOrder: null, apiOrder: api({ state: "orphaned", ...filled, chainSignature: "cancelSig" }), chainNowSecs: EXPIRES + 60 });
    expect(refunded.steps[2]).toMatchObject({ status: "skipped", title: "Filled too late", text: "The venue filled this order too late to record it on Solana. No tokens were minted." });
    expect(refunded.steps[3]).toMatchObject({ status: "done", text: "Hold returned in full.", signature: "cancelSig" });
    expect(refunded.stamp).toBe("REFUNDED");

    const open = derive({ apiOrder: api({ state: "orphaned", ...filled }), chainNowSecs: EXPIRES + 60 });
    expect(open.steps[3]?.text).toBe("Expired. Reclaim your hold.");
    expect(open.canReclaim).toBe(true);
  });

  it("explains a failed order and lets the user reclaim once it has expired", () => {
    const before = derive({ apiOrder: api({ state: "failed", detail: "market closed before the order could be sent" }) });
    expect(before.steps[1]).toMatchObject({ status: "skipped", title: "Not sent", text: "The relayer could not send this order" });
    expect(before.steps[3]).toMatchObject({ status: "current", text: "The relayer could not finish this order. You can reclaim the hold once it expires." });
    expect(before.canReclaim).toBe(false);

    const after = derive({ apiOrder: api({ state: "failed" }), chainNowSecs: EXPIRES + 1 });
    expect(after.steps[3]?.text).toBe("Expired. Reclaim your hold.");
    expect(after).toMatchObject({ stamp: "EXPIRED", canReclaim: true });

    const gone = derive({ chainOrder: null, apiOrder: api({ state: "failed" }), chainNowSecs: EXPIRES + 1 });
    expect(gone.steps[3]).toMatchObject({ status: "done", text: "Hold returned in full." });
  });

  it("reads the order's facts from the relayer when nothing was kept in this browser", () => {
    const t = derive({ chainOrder: undefined, local: null, apiOrder: api({ state: "chain_cancelled", venueOrderId: "7", side: "NO", units: "400", limitPx: "4000", maxFeeMicros: "100000" }) });
    expect(t).toMatchObject({ side: "NO", units: 400n, limitPx: 4_000n, holdMicros: 1_700_000n });
    expect(t.steps[0]).toMatchObject({ text: "$1.70 held", signature: null });
  });
});

describe("deriveTimeline for a sell", () => {
  // 3.00 YES at no less than $0.55: the venue order is a buy of NO at $0.45, fee cap $0.09.
  const sellChain: ChainOrderView = { ...chain, kind: 1, qtyUnits: 300n, limitPx: 5_500n, maxFee: 90_000n };
  const sellLocal: LocalOrder = { ...local, kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000" };
  const sellApi = (patch: Partial<ApiOrder>) => api({ kind: "sell", units: "300", limitPx: "5500", maxFeeMicros: "90000", ...patch });
  // Filled as a buy of NO at $0.44, so the sale brought $0.56 a contract.
  const sold = { venueOrderId: "73615284000001117", filledUnits: "300", amountMicros: "1680000", feeMicros: "60000", fills: [{ tradeId: "1", units: "300", px: "4400", feeMicros: "60000" }] };
  const sell = (patch: Partial<TimelineInput>) => deriveTimeline({ chainOrder: sellChain, apiOrder: null, local: sellLocal, chainNowSecs: NOW, ...patch });

  it("holds tokens, not test dollars", () => {
    const t = sell({ chainOrder: undefined });
    expect(t.steps[0]).toMatchObject({ status: "done", title: "Held on Solana", text: "3.00 Yes tokens held", signature: PLACE_SIG });
    expect(t.steps[3]).toMatchObject({ status: "pending", title: "Tokens burned" });
    expect(t).toMatchObject({ kind: "sell", side: "YES", units: 300n, limitPx: 5_500n, holdMicros: 0n, stamp: "OPEN" });
    expect(derive({}).kind).toBe("buy");
  });

  it("says the venue order is a buy of the opposite outcome at the complement", () => {
    expect(shape(sell({ apiOrder: sellApi({ state: "submitting", venueOrderId: "7" }) }))).toEqual([
      "done:3.00 Yes tokens held",
      "done:Order sent as a buy of No, fill-or-kill at 45¢",
      "current:Waiting for the venue's answer",
      "pending:",
    ]);
  });

  it("reports the fill at the price the sale brought", () => {
    const t = sell({ apiOrder: sellApi({ state: "venue_filled", ...sold }) });
    expect(t.steps[2]).toMatchObject({ status: "done", text: "Filled 3.00 at 56¢", detail: "Venue order 73615284000001117" });
    expect(t.steps[3]).toMatchObject({ status: "current", title: "Tokens burned", text: "Burning the tokens and paying you" });
  });

  it("ends a fill with the tokens burned and the test dollars paid", () => {
    const t = sell({ chainOrder: null, apiOrder: sellApi({ state: "chain_filled", ...sold, chainSignature: "fillSig" }) });
    expect(t.steps[3]).toMatchObject({ status: "done", title: "Tokens burned", text: "3.00 Yes tokens burned. $1.62 paid.", signature: "fillSig" });
    expect(t).toMatchObject({ stamp: "FILLED", open: false });
  });

  it("returns the tokens when nothing filled", () => {
    const waiting = sell({ apiOrder: sellApi({ state: "venue_not_filled", venueOrderId: "7" }) });
    expect(waiting.steps[2]).toMatchObject({ status: "skipped", text: "No fill at your minimum" });
    expect(waiting.steps[3]).toMatchObject({ status: "current", title: "Tokens returned", text: "Returning your tokens" });
    const done = sell({ chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", venueOrderId: "7", chainSignature: "cancelSig" }) });
    expect(done.steps[3]).toMatchObject({ status: "done", title: "Tokens returned", text: "Tokens returned to your wallet.", signature: "cancelSig" });
    expect(done).toMatchObject({ stamp: "REFUNDED", open: false });
  });

  it.each(["fee_cap", "min_proceeds"])("says a sale was refused because it could not cover the fee cap (%s)", (detail) => {
    const t = sell({ chainOrder: null, apiOrder: sellApi({ state: "chain_cancelled", detail, chainSignature: "cancelSig" }) });
    expect(t.steps[1]).toMatchObject({ status: "skipped", title: "Not sent", text: "Not sent: the sale would not have covered the fee cap." });
    expect(t.steps[2]).toMatchObject({ status: "skipped", text: "Nothing was sold" });
    expect(t.steps[3]?.text).toBe("Tokens returned to your wallet.");
  });

  it("offers to reclaim the tokens of an expired sell, and shows the reclaim", () => {
    const expired = sell({ chainNowSecs: EXPIRES + 1 });
    expect(expired.steps[3]).toMatchObject({ status: "current", title: "Return", text: "Expired. Reclaim your tokens." });
    expect(expired).toMatchObject({ stamp: "EXPIRED", canReclaim: true });
    const reclaimed = sell({ chainOrder: null, chainNowSecs: EXPIRES + 30, local: { ...sellLocal, reclaimSignature: "reclaimSig" } });
    expect(reclaimed.steps[3]).toMatchObject({ status: "done", title: "Tokens returned", text: "Tokens returned to your wallet.", signature: "reclaimSig" });
  });

  it("knows a sell from the order account or the relayer alone", () => {
    expect(sell({ local: null }).kind).toBe("sell");
    expect(sell({ local: null, chainOrder: undefined, apiOrder: sellApi({ state: "seen" }) }).steps[0]?.text).toBe("3.00 Yes tokens held");
  });
});

describe("deriveTimeline while the relayer is away", () => {
  it("does not say what the relayer did with an expired order it has no record of", () => {
    const timeline = derive({ chainNowSecs: EXPIRES + 5, relayerAway: true });
    expect(timeline.stamp).toBe("EXPIRED");
    expect(timeline.canReclaim).toBe(true);
    expect(shape(timeline)).toEqual(["done:$0.97 held", "skipped:Whether this order reached the venue is not known while the relayer is not answering", "skipped:Nothing was bought", "current:Expired. Reclaim your hold."]);
    expect(timeline.steps[1].title).toBe("Sent to the venue");
  });

  it("says the same of an order the user reclaimed", () => {
    const timeline = derive({ chainOrder: null, chainNowSecs: EXPIRES + 60, local: { ...local, reclaimSignature: "reclaimSig" }, relayerAway: true });
    expect(timeline.stamp).toBe("REFUNDED");
    expect(shape(timeline)).toEqual(["done:$0.97 held", "skipped:Whether this order reached the venue is not known while the relayer is not answering", "skipped:Nothing was bought", "done:Hold returned in full."]);
  });

  it("still waits for the relayer while the order can be filled", () => {
    expect(shape(derive({ relayerAway: true }))[1]).toBe("current:Waiting for the relayer");
  });
});
