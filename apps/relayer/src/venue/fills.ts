import { PX_MAX, PX_MIN, cost, parseMicros, parsePx, parseUnits, takerFee } from "../money.ts";
import type { VenueFrame } from "./frames.ts";
import type { VenueFill } from "./types.ts";

type OrderUpdate = Extract<VenueFrame, { kind: "orderUpdate" }>;

export type AggregateState =
  | { status: "pending" }
  | {
      status: "filled";
      venueOrderId: string;
      fills: VenueFill[];
      filledUnits: bigint;
      costMicros: bigint;
      feeMicros: bigint;
    }
  | { status: "not_filled"; venueOrderId: string | null; reason: string }
  /** Never act on this: the caller must reconcile through REST. */
  | { status: "inconsistent"; detail: string };

/**
 * Turns the order updates of ONE buy order into a single outcome.
 *
 * The venue reports quantities in two different ways, and mixing them up double-counts:
 * - on FILLED and PARTIALLY_FILLED, `executed` is the quantity of that one execution;
 * - on CANCELED and REJECTED, `executed` is the cumulative quantity over the order's life.
 *
 * So executions are stored by trade id and only those are summed. The cumulative quantity is
 * never added; it is used to check the sum. Anything that does not add up makes the state
 * `inconsistent`, and it stays that way.
 */
export class FillAggregator {
  readonly #clientOrderId: string;
  readonly #requestedUnits: bigint;
  readonly #limitPx: bigint;
  /** Executions by trade id, in order of first arrival. */
  readonly #fills = new Map<string, VenueFill>();
  #filledUnits = 0n;
  #venueOrderId: string | null = null;
  /** A FILLED event was seen: the venue considers the order complete. */
  #fullyFilled = false;
  /** Set by a CANCELED or REJECTED event whose cumulative quantity agreed with the fills. */
  #closed: { reason: string } | null = null;
  #inconsistency: string | null = null;

  constructor(args: { clientOrderId: string; requestedUnits: bigint; limitPx: bigint }) {
    if (args.clientOrderId === "") throw new RangeError("client order id must not be empty");
    if (args.requestedUnits <= 0n) {
      throw new RangeError(`requested units must be positive: ${args.requestedUnits}`);
    }
    if (args.limitPx < PX_MIN || args.limitPx > PX_MAX) {
      throw new RangeError(`limit px out of range ${PX_MIN}..=${PX_MAX}: ${args.limitPx}`);
    }
    this.#clientOrderId = args.clientOrderId;
    this.#requestedUnits = args.requestedUnits;
    this.#limitPx = args.limitPx;
  }

  /** Frames for other client order ids are ignored. */
  accept(frame: OrderUpdate): void {
    if (this.#inconsistency !== null) return;
    if (frame.clientOrderId !== this.#clientOrderId) return;
    if (this.#venueOrderId !== null && frame.orderId !== this.#venueOrderId) {
      return this.#fail(`venue order id changed from ${this.#venueOrderId} to ${frame.orderId}`);
    }
    this.#venueOrderId = frame.orderId;

    switch (frame.status) {
      case "FILLED":
      case "PARTIALLY_FILLED":
        return this.#acceptFill(frame);
      case "CANCELED":
      case "REJECTED":
        return this.#acceptClose(frame);
      default:
        // NEW, OPEN, MODIFIED and statuses not known here say nothing about fills.
        return;
    }
  }

  state(): AggregateState {
    if (this.#inconsistency !== null) return { status: "inconsistent", detail: this.#inconsistency };
    const venueOrderId = this.#venueOrderId;
    if (venueOrderId === null) return { status: "pending" };

    if (this.#closed !== null && this.#filledUnits === 0n) {
      return { status: "not_filled", venueOrderId, reason: this.#closed.reason };
    }
    // A partial fill confirmed by the closing event is a fill. Without a closing event (a
    // fill-or-kill order ends with FILLED alone) every unit must be accounted for.
    if (this.#closed !== null || (this.#fullyFilled && this.#filledUnits === this.#requestedUnits)) {
      const fills = [...this.#fills.values()].map((fill) => ({ ...fill }));
      return {
        status: "filled",
        venueOrderId,
        fills,
        filledUnits: this.#filledUnits,
        costMicros: fills.reduce((sum, fill) => sum + cost(fill.units, fill.px), 0n),
        feeMicros: fills.reduce((sum, fill) => sum + fill.feeMicros, 0n),
      };
    }
    return { status: "pending" };
  }

  /** On a fill event `executed` is the quantity of that one execution and `lastPrice` its price. */
  #acceptFill(frame: OrderUpdate): void {
    const { tradeId, executed, lastPrice } = frame;
    if (!tradeId || !executed || !lastPrice) {
      return this.#fail(`${frame.status} event without a trade id, quantity or price`);
    }
    const units = parsed(parseUnits, executed);
    const px = parsed(parsePx, lastPrice);
    if (units === null || units === 0n || px === null) {
      return this.#fail(`trade ${tradeId} has an unreadable quantity or price: ${executed} @ ${lastPrice}`);
    }

    const known = this.#fills.get(tradeId);
    if (known !== undefined) {
      if (known.units === units && known.px === px) return; // the same execution, delivered again
      return this.#fail(`trade ${tradeId} was reported twice with different values`);
    }

    if (this.#closed !== null) {
      return this.#fail(`trade ${tradeId} arrived after the order closed with ${this.#filledUnits} units filled`);
    }
    if (px > this.#limitPx) {
      return this.#fail(`trade ${tradeId} is priced at ${px}, above the limit ${this.#limitPx}`);
    }
    if (this.#filledUnits + units > this.#requestedUnits) {
      return this.#fail(`fills add up to ${this.#filledUnits + units} units, more than the ${this.#requestedUnits} requested`);
    }
    const fee = feeOf(frame.fee, units, px);
    if (fee === null) return this.#fail(`trade ${tradeId} has an unreadable fee: ${String(frame.fee)}`);

    this.#fills.set(tradeId, { tradeId, units, px, ...fee });
    this.#filledUnits += units;
    if (frame.status === "FILLED") this.#fullyFilled = true;
  }

  /** On CANCELED and REJECTED `executed` is the cumulative quantity; missing or empty means 0. */
  #acceptClose(frame: OrderUpdate): void {
    const cumulative = frame.executed ? parsed(parseUnits, frame.executed) : 0n;
    if (cumulative === null) {
      return this.#fail(`${frame.status} has an unreadable cumulative quantity: ${String(frame.executed)}`);
    }
    if (cumulative !== this.#filledUnits) {
      return this.#fail(
        `${frame.status} reports ${cumulative} units filled but the fills seen add up to ${this.#filledUnits}`,
      );
    }
    this.#closed ??= { reason: frame.reason || frame.status };
  }

  #fail(detail: string): void {
    this.#inconsistency = detail;
  }
}

/** Runs a strict parser, mapping its RangeError to null. */
function parsed(parse: (text: string) => bigint, text: string): bigint | null {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

/** The fee the venue reported for a fill, or the formula when it reported none. */
function feeOf(reported: string | null, units: bigint, px: bigint): Pick<VenueFill, "feeMicros" | "feeSource"> | null {
  if (reported === null) return { feeMicros: takerFee(units, px), feeSource: "computed" };
  const feeMicros = parsed(parseMicros, reported);
  return feeMicros === null ? null : { feeMicros, feeSource: "reported" };
}
