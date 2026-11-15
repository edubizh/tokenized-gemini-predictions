import { describe, expect, it } from "vitest";
import type { ApiHealth, ApiMarket, NotTradableReason } from "@outcome/relayer/api-types";
import { closedReason } from "./reasons";

const OPENS = Date.UTC(2026, 10, 15, 1, 10);
const LAST_ORDER = Date.UTC(2026, 10, 15, 2, 0);
const market = (notTradableReason: NotTradableReason | null, tradable = notTradableReason === null) =>
  ({ tradable, notTradableReason, startsAt: OPENS, lastOrderAt: LAST_ORDER }) as Pick<ApiMarket, "tradable" | "notTradableReason" | "startsAt" | "lastOrderAt">;
const health = (patch: Partial<ApiHealth> = {}) => ({ paused: { place: false, fill: false }, ...patch }) as Pick<ApiHealth, "paused">;
// A minute before the last order time, so only the tests about that time move the clock.
const UTC = { timeZone: "UTC", now: LAST_ORDER - 60_000 };

describe("closedReason", () => {
  it("is nothing for a contract that takes orders", () => {
    expect(closedReason(market(null), health(), UTC)).toBeNull();
  });

  it("says why in a title and one sentence", () => {
    expect(closedReason(market("not_started"), health(), UTC)).toEqual({ title: "Opens at 1:10 AM UTC", text: "Orders can be placed once the contract opens." });
    expect(closedReason(market("not_active"), health(), UTC)?.title).toBe("Not trading yet");
    expect(closedReason(market("too_close_to_expiry"), health(), UTC)?.title).toBe("Orders closed");
    expect(closedReason(market("no_offers"), health(), UTC)).toEqual({ title: "No offers", text: "Nobody offers this contract right now, so an order would not fill." });
    expect(closedReason(market("venue_offline"), health(), UTC)?.title).toBe("The venue is not connected");
  });

  it("puts the relayer and a pause before the contract's own reason", () => {
    expect(closedReason(market("no_offers"), null, UTC)?.title).toBe("The relayer is not answering");
    expect(closedReason(market(null), health({ paused: { place: true, fill: false } }), UTC)?.title).toBe("Trading is paused");
  });

  it("has a sentence for every reason", () => {
    const reasons: NotTradableReason[] = ["not_started", "too_close_to_expiry", "market_not_open", "not_active", "no_offers", "paused", "venue_offline"];
    for (const reason of reasons) expect(closedReason(market(reason), health(), UTC)?.text).toMatch(/\.$/);
    expect(closedReason(market(null, false), health(), UTC)?.title).toBe("Not open for orders");
  });

  it("is closed from the last order time on, whatever the last poll said", () => {
    expect(closedReason(market(null), health(), { ...UTC, now: LAST_ORDER - 1 })).toBeNull();
    expect(closedReason(market(null), health(), { ...UTC, now: LAST_ORDER })?.title).toBe("Orders closed");
  });
});
