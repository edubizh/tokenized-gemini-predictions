// The figures of an order, read off its derived timeline and the relayer's record, so the list,
// the steps and the figures cannot disagree. Pure.

import type { ApiOrder } from "@outcome/relayer/api-types";
import { complementPx } from "@outcome/relayer/money";
import type { DerivedTimeline } from "@/features/ticket/timeline";

export interface OrderFill {
  tradeId: string;
  units: bigint;
  /** In the order's own terms: what a buy paid, or what a sale brought, per unit. */
  px: bigint;
  feeMicros: bigint;
}

/** The part of the figures only a sale has: it holds tokens and is paid in test dollars. */
export interface SaleFigures {
  /** Tokens the program held for the order, in units. */
  heldUnits: bigint;
  /** What the sale brought before the fee. Zero unless the fill was recorded on Solana. */
  proceedsMicros: bigint;
  /** Test dollars paid to the wallet: proceeds less the fee. Null while the tokens are still held. */
  paidMicros: bigint | null;
  /** Tokens that came back unsold. Null while they are still held. */
  returnedUnits: bigint | null;
}

export interface OrderFigures {
  /** Null when the order never reached the venue. */
  venueOrderId: string | null;
  fills: OrderFill[];
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
  sale?: SaleFigures;
}

export function orderFigures(timeline: DerivedTimeline, api: ApiOrder | null): OrderFigures {
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

/**
 * The money of an order in one figure. A buy: what it paid (cost and fee) once a fill is recorded
 * on Solana, otherwise what it held. A sale: the test dollars it paid, or null before or without a fill.
 */
export function orderAmount(figures: OrderFigures): bigint | null {
  if (figures.sale) return figures.sale.paidMicros !== null && figures.sale.paidMicros > 0n ? figures.sale.paidMicros : null;
  return figures.costMicros > 0n ? figures.costMicros + figures.feeMicros : figures.heldMicros;
}
