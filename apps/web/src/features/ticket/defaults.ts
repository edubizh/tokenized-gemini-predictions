// What the trade panel starts with, and how its price stops following the market. Pure.

import { formatCents, formatContracts } from "@/lib/format";
import type { OrderLimits } from "./quote";

/** A price in px as the panel shows it, in cents without the sign: `56`, `45.5`. */
export const priceText = (px: bigint) => formatCents(px).replace("¢", "");
/** Units as the panel shows them, without grouping: `1250.00`. */
export const quantityText = (units: bigint) => formatContracts(units).replace(/,/g, "");

export interface TicketDefaults {
  /** Buy: one contract. Sale: everything held, rounded down to the increment and capped. */
  quantity: string;
  /** The stepper's bounds, in units. */
  leastUnits: bigint;
  mostUnits: bigint | null;
}

export function ticketDefaults({ selling, heldUnits, limits }: { selling: boolean; heldUnits: bigint | null; limits: OrderLimits }): TicketDefaults {
  const mostUnits = selling && heldUnits !== null && (limits.maxUnits === null || heldUnits < limits.maxUnits) ? heldUnits : limits.maxUnits;
  const sellable = selling && heldUnits !== null && mostUnits !== null ? (mostUnits / limits.incrementUnits) * limits.incrementUnits : 0n;
  return { quantity: sellable > 0n ? quantityText(sellable) : "1.00", leastUnits: limits.minUnits, mostUnits };
}

/**
 * Until the panel is first touched its price follows the reference (the offer for a buy, the bid
 * for a sale). At the first touch that price is fixed as if typed, so it never moves under the user.
 */
export function fixPrice(typed: string | null, reference: bigint | null): string | null {
  return typed ?? (reference === null ? null : priceText(reference));
}

/** The reference, when it has moved away from a price that was fixed from it and not edited since. */
export function movedReference({ typed, fixed }: { typed: string | null; fixed: string | null }, reference: bigint | null): bigint | null {
  if (typed === null || typed !== fixed || reference === null) return null;
  return priceText(reference) === typed ? null : reference;
}
