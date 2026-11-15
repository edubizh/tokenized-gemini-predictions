import type { ContractInfo, EventInfo } from "../../src/venue/venue.ts";

/** A venue event around the given contracts, in the shape the venue adapters produce. */
export function eventOf(contracts: ContractInfo[], overrides: Partial<EventInfo> = {}): EventInfo {
  const first = contracts[0];
  if (first === undefined) throw new Error("an event needs a contract to take its ticker and dates from");
  return {
    ticker: first.eventTicker,
    title: `${first.eventTicker} title`,
    category: "Crypto",
    subcategory: ["Bitcoin"],
    underlying: "BTC",
    shape: contracts.length > 1 ? "ladder" : "binary",
    cadence: "15m",
    description: "",
    source: null,
    termsUrl: null,
    listedAt: first.effectiveAt,
    expiresAt: first.expiresAt,
    status: "active",
    volumeUnits: 0n,
    contracts,
    ...overrides,
  };
}
