import { complementPx, cost } from "../money.ts";
import type { Outcome, VenueFill } from "./types.ts";

/**
 * What a user asked for, in the user's own side space: `limitPx` is the maximum price of a buy
 * and the minimum price of a sell.
 */
export type UserAction = { kind: "buy" | "sell"; side: Outcome; units: bigint; limitPx: bigint };

/**
 * The venue order for a user action. The relayer only ever BUYS: a contract is one book quoted in
 * YES prices, so selling an outcome at no less than `M` is buying the opposite outcome at no more
 * than `10_000 - M`.
 */
export function toVenueOrder(action: UserAction): { outcome: Outcome; units: bigint; limitPx: bigint } {
  // Both lookups validate their input, so a buy is checked as strictly as a sell.
  const opposite = oppositeOf(action.side);
  const complement = complementPx(action.limitPx);
  switch (action.kind) {
    case "buy":
      return { outcome: action.side, units: action.units, limitPx: action.limitPx };
    case "sell":
      return { outcome: opposite, units: action.units, limitPx: complement };
    default:
      throw new RangeError(`unknown action kind: ${String(action.kind)}`);
  }
}

/** Micro-dollars paid for the fills of a buy: `sum(units * px)`. */
export function buyCost(fills: VenueFill[]): bigint {
  return fills.reduce((sum, fill) => sum + cost(fill.units, fill.px), 0n);
}

/**
 * Micro-dollars a sell returns. Its fills are BUYs of the opposite outcome, each releasing the
 * payout of the pair it closes: `sum(units * (10_000 - px))`.
 */
export function sellProceeds(fills: VenueFill[]): bigint {
  return fills.reduce((sum, fill) => sum + cost(fill.units, complementPx(fill.px)), 0n);
}

function oppositeOf(side: Outcome): Outcome {
  switch (side) {
    case "YES":
      return "NO";
    case "NO":
      return "YES";
    default:
      throw new RangeError(`unknown outcome: ${String(side)}`);
  }
}
