// Where an order is, derived from everything known about it: its account on Solana (or its
// absence), the relayer's record, what this browser kept when it placed the order, and the
// cluster clock. Pure: the same facts always give the same four steps.

import type { ApiOrder, SideName } from "@outcome/relayer/api-types";
import { formatContracts, formatDollars, formatPrice } from "@/lib/format";

/** An open order as read from its account. Times are cluster seconds. */
export interface ChainOrderView {
  address: string;
  user: string;
  market: string;
  /** 0 YES, 1 NO. */
  side: number;
  /** 0 buy, 1 sell. */
  kind: number;
  qtyUnits: bigint;
  limitPx: bigint;
  maxFee: bigint;
  expiresAt: number;
  rentPayer: string;
  nonce: bigint;
}

/** What the browser keeps, by order address, when it places an order. */
export interface LocalOrder {
  address: string;
  /** Signature of the transaction that placed the order. */
  signature: string | null;
  symbol: string;
  side: SideName;
  units: string;
  limitPx: string;
  maxFeeMicros: string;
  /** Unix milliseconds. */
  placedAt: number;
  /** Cluster seconds; an estimate until the order account has been read. */
  expiresAt: number;
  /** Signature of the user's own cancel, once they have reclaimed the hold. */
  reclaimSignature?: string;
}

export interface TimelineInput {
  /** The order account; null when it does not exist; undefined before it has been read. */
  chainOrder: ChainOrderView | null | undefined;
  /** The relayer's record; null until the relayer has seen the order. */
  apiOrder: ApiOrder | null;
  local: LocalOrder | null;
  chainNowSecs: number;
}

export type StepStatus = "done" | "current" | "pending" | "skipped";

export interface DerivedStep {
  id: "held" | "sent" | "filled" | "result";
  status: StepStatus;
  title: string;
  /** One line; empty for a step that has nothing to say yet. */
  text: string;
  /** A second, quieter line, such as the venue order id. */
  detail: string | null;
  /** When it happened, unix milliseconds, where that is known. */
  atMs: number | null;
  /** The transaction of this step, where there is one. */
  signature: string | null;
}

export type OrderStamp = "OPEN" | "FILLED" | "REFUNDED" | "EXPIRED";

export interface DerivedTimeline {
  steps: [DerivedStep, DerivedStep, DerivedStep, DerivedStep];
  stamp: OrderStamp;
  /** True while the hold is still with the program. */
  open: boolean;
  /** True when the order has expired and its account is known to exist: the user can cancel it. */
  canReclaim: boolean;
  /** Cluster seconds. */
  expiresAt: number;
  side: SideName;
  units: bigint;
  limitPx: bigint;
  holdMicros: bigint;
}

const REFUSALS: ReadonlyArray<[prefix: string, words: string]> = [
  ["expiry_window", "Not sent: the order arrived too close to the close."],
  ["book_side_empty", "Not sent: there were no offers on that side."],
  ["fee_cap", "Not sent: the fee cap was too low."],
  ["not_tradable", "Not sent: the market was not tradable."],
  ["contract_missing", "Not sent: the market was not tradable."],
  ["bad_order_values", "Not sent: the relayer did not accept the order's values."],
  ["min_proceeds", "Not sent: the relayer did not accept the order's values."],
];

/** Why the relayer refused an order before sending it, or null when it was not such a refusal. */
export function refusalWords(order: Pick<ApiOrder, "venueOrderId" | "detail">): string | null {
  if (order.venueOrderId !== null || order.detail === null) return null;
  const detail = order.detail;
  return REFUSALS.find(([prefix]) => detail === prefix || detail.startsWith(`${prefix}:`))?.[1] ?? null;
}

/** Average fill price in px, rounded half up to a whole px. */
function averagePx(order: ApiOrder): bigint | null {
  let units = 0n;
  let value = 0n;
  for (const fill of order.fills) {
    units += BigInt(fill.units);
    value += BigInt(fill.units) * BigInt(fill.px);
  }
  if (units === 0n) {
    units = BigInt(order.filledUnits);
    value = BigInt(order.amountMicros);
  }
  return units === 0n ? null : (value * 2n + units) / (units * 2n);
}

function step(id: DerivedStep["id"], status: StepStatus, title: string, text = "", extra: Partial<Pick<DerivedStep, "detail" | "atMs" | "signature">> = {}): DerivedStep {
  return { id, status, title, text, detail: extra.detail ?? null, atMs: extra.atMs ?? null, signature: extra.signature ?? null };
}

const EXPIRED = "Expired. Reclaim your hold.";
const RETURNED = "Hold returned in full.";

export function deriveTimeline(input: TimelineInput): DerivedTimeline {
  const { chainOrder, apiOrder: api, local, chainNowSecs } = input;

  const side: SideName = api?.side ?? (chainOrder ? (chainOrder.side === 0 ? "YES" : "NO") : (local?.side ?? "YES"));
  const units = api ? BigInt(api.units) : (chainOrder?.qtyUnits ?? BigInt(local?.units ?? "0"));
  const limitPx = api ? BigInt(api.limitPx) : (chainOrder?.limitPx ?? BigInt(local?.limitPx ?? "0"));
  const maxFee = api ? BigInt(api.maxFeeMicros) : (chainOrder?.maxFee ?? BigInt(local?.maxFeeMicros ?? "0"));
  const holdMicros = units * limitPx + maxFee;
  const expiresAt = chainOrder?.expiresAt ?? api?.expiresAt ?? local?.expiresAt ?? 0;
  const expired = chainNowSecs > expiresAt;
  const reclaimed = local?.reclaimSignature ?? null;
  const state = api?.state ?? null;

  // The hold is back once the relayer has recorded a fill or a cancel on-chain, once the user has
  // reclaimed it, or once the account is gone and the relayer has nothing more to do with it.
  const closed =
    state === "chain_filled" ||
    state === "chain_cancelled" ||
    reclaimed !== null ||
    (chainOrder === null && (api === null || state === "failed" || state === "orphaned"));
  const open = !closed;
  const canReclaim = open && expired && chainOrder != null;

  const held = step("held", "done", "Held on Solana", `${formatDollars(holdMicros)} held`, { signature: local?.signature ?? null, atMs: local?.placedAt ?? api?.createdAt ?? null });
  const sentText = `Order sent, fill-or-kill at ${limitPx > 0n ? formatPrice(limitPx) : "your limit"}`;
  const sentDone = step("sent", "done", "Sent to the venue", sentText);
  const refunded = (signature: string | null, atMs: number | null) => step("result", "done", "Refunded", RETURNED, { signature, atMs });
  const reclaim = step("result", "current", "Refund", EXPIRED);
  /** The last step of an order whose hold has not come back through the relayer. */
  const unresolved = (waiting: DerivedStep) => (reclaimed !== null ? refunded(reclaimed, null) : expired ? reclaim : waiting);
  const finish = (steps: [DerivedStep, DerivedStep, DerivedStep], result: DerivedStep, stamp: OrderStamp): DerivedTimeline => ({
    steps: [...steps, result],
    stamp,
    open,
    canReclaim,
    expiresAt,
    side,
    units,
    limitPx,
    holdMicros,
  });
  const openStamp: OrderStamp = closed ? "REFUNDED" : expired ? "EXPIRED" : "OPEN";

  /** Before the relayer has sent anything: it has not seen the order, or has only just picked it up. */
  const beforeSending = (): DerivedTimeline => {
    const nothing = step("filled", "skipped", "Not filled", "Nothing was bought");
    if (closed) return finish([held, step("sent", "skipped", "Not sent", "The relayer did not send this order"), nothing], refunded(reclaimed, null), "REFUNDED");
    if (expired) return finish([held, step("sent", "skipped", "Not sent", "The relayer did not pick this order up in time"), nothing], reclaim, "EXPIRED");
    const waiting = api === null ? "Waiting for the relayer" : "The relayer has the order and is sending it";
    return finish([held, step("sent", "current", "Sent to the venue", waiting), step("filled", "pending", "Filled")], step("result", "pending", "Tokens minted"), "OPEN");
  };
  if (api === null) return beforeSending();

  const order = api;
  const venueDetail = order.venueOrderId ? `Venue order ${order.venueOrderId}` : null;
  const average = averagePx(order);
  const filledStep = step("filled", "done", "Filled", `Filled ${formatContracts(BigInt(order.filledUnits))} at ${average === null ? "your limit" : formatPrice(average)}`, { detail: venueDetail });
  const noFill = step("filled", "skipped", "Not filled", "No fill at your limit", { detail: venueDetail });
  const refusal = refusalWords(order);

  switch (order.state) {
    case "seen":
      return beforeSending();

    case "submitting":
      return finish([held, sentDone, expired ? step("filled", "skipped", "Not filled", "The venue did not answer before the order expired") : step("filled", "current", "Filled", "Waiting for the venue's answer")], unresolved(step("result", "pending", "Tokens minted")), openStamp);

    case "venue_unknown":
      return finish(
        [
          held,
          sentDone,
          expired || reclaimed !== null
            ? step("filled", "skipped", "Result unknown", "The venue did not confirm a fill before the order expired", { detail: venueDetail })
            : step("filled", "current", "Filled", "The venue has not confirmed the result. The relayer is checking.", { detail: venueDetail }),
        ],
        unresolved(step("result", "pending", "Tokens minted")),
        openStamp,
      );

    case "venue_filled":
      return finish([held, sentDone, filledStep], unresolved(step("result", "current", "Tokens minted", "Minting your tokens")), openStamp);

    case "venue_not_filled":
      return finish([held, sentDone, noFill], unresolved(step("result", "current", "Refunded", "Returning your hold")), openStamp);

    case "chain_filled": {
      const returned = holdMicros - BigInt(order.amountMicros) - BigInt(order.feeMicros);
      const minted = `${formatContracts(BigInt(order.filledUnits))} ${side} tokens minted.`;
      const text = returned > 0n ? `${minted} ${formatDollars(returned)} of the hold returned.` : minted;
      return finish([held, sentDone, filledStep], step("result", "done", "Tokens minted", text, { signature: order.chainSignature, atMs: order.updatedAt }), "FILLED");
    }

    case "chain_cancelled": {
      const result = refunded(order.chainSignature ?? reclaimed, order.updatedAt);
      if (refusal !== null || order.venueOrderId === null) {
        const why = refusal ?? "The relayer did not send this order";
        return finish([held, step("sent", "skipped", "Not sent", why), step("filled", "skipped", "Not filled", "Nothing was bought")], result, "REFUNDED");
      }
      return finish([held, sentDone, noFill], result, "REFUNDED");
    }

    case "orphaned": {
      const late = step("filled", "skipped", "Filled too late", "The venue filled this order too late to record it on Solana. No tokens were minted.", { detail: venueDetail });
      const result = closed ? refunded(order.chainSignature ?? reclaimed, order.chainSignature ? order.updatedAt : null) : unresolved(step("result", "current", "Refunded", "You can reclaim the hold once the order expires."));
      return finish([held, sentDone, late], result, openStamp);
    }

    case "failed": {
      const sent = refusal !== null || order.venueOrderId === null ? step("sent", "skipped", "Not sent", refusal ?? "The relayer could not send this order") : sentDone;
      const middle = BigInt(order.filledUnits) > 0n ? filledStep : step("filled", "skipped", "Not filled", "Nothing was bought", { detail: venueDetail });
      const result = closed
        ? refunded(order.chainSignature ?? reclaimed, order.chainSignature ? order.updatedAt : null)
        : unresolved(step("result", "current", "Refunded", "The relayer could not finish this order. You can reclaim the hold once it expires."));
      return finish([held, sent, middle], result, openStamp);
    }
  }
}
