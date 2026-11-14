// What a row of the activity list says about an order, and the numbers of its receipt. Both are
// read off the derived timeline, so the list, the timeline and the receipt cannot disagree. Pure.

import type { ApiOrder } from "@outcome/relayer/api-types";
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
  /** In the venue order's own outcome space. */
  px: bigint;
  feeMicros: bigint;
}

export interface OrderReceipt {
  /** Null when the order never reached the venue. */
  venueOrderId: string | null;
  fills: ReceiptFill[];
  /** What the program held for the order. */
  heldMicros: bigint;
  /** What was taken from the hold for the tokens, and for the fee. Zero unless the fill was recorded on Solana. */
  costMicros: bigint;
  feeMicros: bigint;
  /** What came back from the hold; null while the hold is still with the program. */
  returnedMicros: bigint | null;
  /** The transactions of the order's on-chain steps, in order. */
  signatures: Array<{ label: string; signature: string }>;
}

export function orderReceipt(timeline: DerivedTimeline, api: ApiOrder | null): OrderReceipt {
  // A fill takes money only once it is recorded on Solana; until then, and for a venue fill that
  // came too late to record, the whole hold is still the user's.
  const taken = api?.state === "chain_filled";
  const costMicros = taken ? BigInt(api.amountMicros) : 0n;
  const feeMicros = taken ? BigInt(api.feeMicros) : 0n;
  return {
    venueOrderId: api?.venueOrderId ?? null,
    fills: (api?.fills ?? []).map((fill) => ({ tradeId: fill.tradeId, units: BigInt(fill.units), px: BigInt(fill.px), feeMicros: BigInt(fill.feeMicros) })),
    heldMicros: timeline.holdMicros,
    costMicros,
    feeMicros,
    returnedMicros: timeline.open ? null : timeline.holdMicros - costMicros - feeMicros,
    signatures: timeline.steps.flatMap((step) => (step.signature ? [{ label: step.title, signature: step.signature }] : [])),
  };
}
