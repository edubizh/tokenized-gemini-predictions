import type { Outcome } from "./types.ts";

const MINUTE_MS = 60_000;

/**
 * How long before expiry orders stop, by contract life: up to 5 minutes -> 1 minute, up to
 * 15 minutes -> 2 minutes, otherwise 5 minutes. An invalid date gets the longest cutoff.
 */
export function cutoffMs(effectiveAt: Date, expiresAt: Date): number {
  const lifeMs = expiresAt.getTime() - effectiveAt.getTime();
  if (lifeMs <= 5 * MINUTE_MS) return 1 * MINUTE_MS;
  if (lifeMs <= 15 * MINUTE_MS) return 2 * MINUTE_MS;
  return 5 * MINUTE_MS;
}

/**
 * Whether an order may be sent for the contract right now. Only `marketState === "open"` trades:
 * any other state, including the venue's undocumented `"post_only"`, does not.
 */
export function tradableNow(
  contract: { status: string; marketState: string; effectiveAt: Date; expiresAt: Date },
  now: Date,
): { ok: true } | { ok: false; reason: string } {
  if (contract.status !== "active") return { ok: false, reason: "not_active" };
  if (contract.marketState !== "open") return { ok: false, reason: "market_not_open" };

  // Each check is written as the condition that must HOLD, so an invalid date (NaN) fails it.
  const nowMs = now.getTime();
  const started = contract.effectiveAt.getTime() <= nowMs;
  if (!started) return { ok: false, reason: "not_started" };
  const lastOrderMs = contract.expiresAt.getTime() - cutoffMs(contract.effectiveAt, contract.expiresAt);
  const beforeCutoff = nowMs < lastOrderMs;
  if (!beforeCutoff) return { ok: false, reason: "too_close_to_expiry" };
  return { ok: true };
}

/** A buy needs the side of the book it takes from: asks to buy YES, bids to buy NO. */
export function bookSideAvailable(book: { bids: unknown[]; asks: unknown[] }, outcome: Outcome): boolean {
  switch (outcome) {
    case "YES":
      return Array.isArray(book.asks) && book.asks.length > 0;
    case "NO":
      return Array.isArray(book.bids) && book.bids.length > 0;
    default:
      return false;
  }
}
