// Why the trade panel cannot place an order right now, as a title and one sentence. Pure.

import type { ApiHealth, ApiMarket } from "@outcome/relayer/api-types";
import { formatClock, type TimeOptions } from "@/features/markets/wording";

export interface Reason {
  title: string;
  text: string;
}

const PAUSED: Reason = { title: "Trading is paused", text: "Orders already placed are still filled or refunded." };

const TOO_LATE: Reason = { title: "Orders closed", text: "It is too close to the end of this contract for an order to be filled in time." };

/**
 * Null when the contract takes orders. The relayer and a pause come first, because they hold for
 * every contract; then the last order time, which the last poll may not have caught yet; then the
 * contract's own reason. `now` is unix milliseconds and is always passed in: this module reads no clock.
 */
export function closedReason(
  market: Pick<ApiMarket, "tradable" | "notTradableReason" | "startsAt" | "lastOrderAt">,
  health: Pick<ApiHealth, "paused"> | null,
  options: TimeOptions & { now: number },
): Reason | null {
  if (health === null) return { title: "The relayer is not answering", text: "A new order would not reach the venue until it is back." };
  if (health.paused.place) return PAUSED;
  if (options.now >= market.lastOrderAt) return TOO_LATE;
  if (market.tradable) return null;
  switch (market.notTradableReason) {
    case "not_started":
      return { title: `Opens at ${formatClock(market.startsAt, { ...options, zone: true })}`, text: "Orders can be placed once the contract opens." };
    case "not_active":
      return { title: "Not trading yet", text: "The venue has listed this contract but does not take orders on it yet." };
    case "too_close_to_expiry":
      return TOO_LATE;
    case "market_not_open":
      return { title: "Orders closed", text: "The venue is not taking orders on this contract right now." };
    case "no_offers":
      return { title: "No offers", text: "Nobody offers this contract right now, so an order would not fill." };
    case "paused":
      return PAUSED;
    case "venue_offline":
      return { title: "The venue is not connected", text: "The relayer cannot reach the venue, so an order would not fill." };
    case null:
      return { title: "Not open for orders", text: "The venue does not take orders on this contract right now." };
  }
}
