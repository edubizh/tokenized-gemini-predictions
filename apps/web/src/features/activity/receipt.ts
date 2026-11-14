// What a row of the activity list says about an order, and the numbers of its receipt. Both are
// read off the derived timeline, so the list, the timeline and the receipt cannot disagree. Pure.

import type { ApiOrder } from "@outcome/relayer/api-types";
import { complementPx } from "@outcome/relayer/money";
import type { DerivedTimeline } from "@/features/ticket/timeline";

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The outcome of an order in one or two short sentences. */
export function outcomeWords(timeline: DerivedTimeline): string {
  const [, sent, filled, result] = timeline.steps;
  if (timeline.stamp === "OPEN") {
    const current = timeline.steps.find((step) => step.status === "current" && step.text !== "");
    return sentence(current?.text ?? "In progress");
  }
  if (timeline.stamp === "FILLED") return `${sentence(filled.text)} ${sentence(result.text)}`;
  // Refunded or expired: the first step that did not happen is the reason.
  const reason = sent.status === "skipped" ? sent : filled.status === "skipped" ? filled : null;
  if (timeline.stamp === "EXPIRED" || reason === null) return sentence(result.text);
  return `${sentence(reason.text)} ${sentence(result.text)}`;
}

export interface ReceiptFill {
  tradeId: string;
  units: bigint;
  /** In the order's own terms: what a buy paid, or what a sale brought, per unit. */
  px: bigint;
  feeMicros: bigint;
}

/** The part of a receipt only a sale has: it holds tokens and is paid in test dollars. */
export interface SaleReceipt {
  /** Tokens the program held for the order, in units. */
  heldUnits: bigint;
  /** What the sale brought before the fee. Zero unless the fill was recorded on Solana. */
  proceedsMicros: bigint;
  /** Test dollars paid to the wallet: proceeds less the fee. Null while the tokens are still held. */
  paidMicros: bigint | null;
  /** Tokens that came back unsold. Null while they are still held. */
  returnedUnits: bigint | null;
}

export interface OrderReceipt {
  /** Null when the order never reached the venue. */
  venueOrderId: string | null;
  fills: ReceiptFill[];
  /** What the program held for a buy, in test dollars. Zero for a sale. */
  heldMicros: bigint;
  /** What was taken from the hold for the tokens, and for the fee. Zero unless the fill was recorded on Solana. */
  costMicros: bigint;
  feeMicros: bigint;
  /** What came back from the hold; null while the hold is still with the program. */
  returnedMicros: bigint | null;
  /** The transactions of the order's on-chain steps, in order. */
  signatures: Array<{ label: string; signature: string }>;
  /** Present for a sale only. */
  sale?: SaleReceipt;
}

export function orderReceipt(timeline: DerivedTimeline, api: ApiOrder | null): OrderReceipt {
  // A fill moves money only once it is recorded on Solana; until then, and for a venue fill that
  // came too late to record, the whole hold is still the user's.
  const taken = api?.state === "chain_filled";
  const amountMicros = taken ? BigInt(api.amountMicros) : 0n;
  const feeMicros = taken ? BigInt(api.feeMicros) : 0n;
  const selling = timeline.kind === "sell";
  const base = {
    venueOrderId: api?.venueOrderId ?? null,
    fills: (api?.fills ?? []).map((fill) => ({
      tradeId: fill.tradeId,
      units: BigInt(fill.units),
      px: selling ? complementPx(BigInt(fill.px)) : BigInt(fill.px),
      feeMicros: BigInt(fill.feeMicros),
    })),
    feeMicros,
    signatures: timeline.steps.flatMap((step) => (step.signature ? [{ label: step.title, signature: step.signature }] : [])),
  };
  if (!selling) {
    return { ...base, heldMicros: timeline.holdMicros, costMicros: amountMicros, returnedMicros: timeline.open ? null : timeline.holdMicros - amountMicros - feeMicros };
  }
  const soldUnits = taken ? BigInt(api.filledUnits) : 0n;
  return {
    ...base,
    heldMicros: 0n,
    costMicros: 0n,
    returnedMicros: timeline.open ? null : 0n,
    sale: {
      heldUnits: timeline.units,
      proceedsMicros: amountMicros,
      paidMicros: timeline.open ? null : amountMicros - feeMicros,
      returnedUnits: timeline.open ? null : timeline.units - soldUnits,
    },
  };
}
