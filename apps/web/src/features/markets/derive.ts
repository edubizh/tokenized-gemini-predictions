// What the pages show about events and their contracts, derived from the relayer's answers.
// Pure: no React and no clock. Prices are px in bigint (one cent per contract = 100).

import type { ApiEvent, ApiMarket, Cadence } from "@outcome/relayer/api-types";
import { formatCents, formatContracts } from "@/lib/format";
import { askPx } from "./book";

/** Stands where a value does not exist: a side nobody offers, a chance nothing tells. */
export const NO_VALUE = "–";

type Booked = Pick<ApiMarket, "book">;

/** True when at least one side has a price. */
export function isQuoted(market: Booked): boolean {
  return market.book !== null && (market.book.bidPx !== null || market.book.askPx !== null);
}

/** What one contract of each side costs now: Yes at the best ask, No at 100 cents less the best bid. Null for a side nobody offers. */
export function prices(market: Booked): { yes: bigint | null; no: bigint | null } {
  return { yes: askPx(market, "YES"), no: askPx(market, "NO") };
}

/** A price in cents, `57¢`; a missing one is a dash and never `0¢`. */
export function centsText(px: bigint | null): string {
  return px === null ? NO_VALUE : formatCents(px);
}

/** The chance of Yes in px: the midpoint of bid and ask when both exist, else the last trade price, else null. */
export function chancePx(market: Pick<ApiMarket, "book" | "lastPx">): bigint | null {
  const bid = market.book?.bidPx ?? null;
  const ask = market.book?.askPx ?? null;
  if (bid !== null && ask !== null) return (BigInt(bid) + BigInt(ask) + 1n) / 2n;
  return market.lastPx === null ? null : BigInt(market.lastPx);
}

/** A chance as a whole percent, `<1%` and `>99%` at the edges, a dash for none. */
export function chanceText(px: bigint | null): string {
  if (px === null) return NO_VALUE;
  if (px < 100n) return "<1%";
  if (px > 9_900n) return ">99%";
  return `${(px + 50n) / 100n}%`;
}

/** Units traded at the venue over the life of the event, or null when nothing traded: a volume of zero is not shown. */
export function volumeUnits(event: Pick<ApiEvent, "volumeUnits">): bigint | null {
  const units = BigInt(event.volumeUnits);
  return units > 0n ? units : null;
}

/** The volume as it is written beside a market, `4,940 contracts traded`; null when nothing traded. */
export function volumeText(event: Pick<ApiEvent, "volumeUnits">): string | null {
  const units = volumeUnits(event);
  if (units === null) return null;
  const contracts = formatContracts(units).replace(/\.00$/, "");
  return `${contracts} ${contracts === "1" ? "contract" : "contracts"} traded`;
}

/** In the order the filter offers them. */
const CADENCE_LABELS: Record<Cadence, string> = { "5m": "5 min", "15m": "15 min", hourly: "Hourly", daily: "Daily", weekly: "Weekly", monthly: "Monthly", other: "Other" };

export function cadenceLabel(cadence: Cadence): string {
  return CADENCE_LABELS[cadence];
}

/** The categories that have an event, by name. */
export function categoriesOf(events: readonly ApiEvent[]): string[] {
  return [...new Set(events.map((event) => event.category))].sort();
}

/** The cadences that have an event, shortest first. */
export function cadencesOf(events: readonly ApiEvent[]): Cadence[] {
  return (Object.keys(CADENCE_LABELS) as Cadence[]).filter((cadence) => events.some((event) => event.cadence === cadence));
}

export interface EventFilter {
  /** Null or absent: every category. */
  category?: string | null;
  cadence?: Cadence | null;
  /** Looked for in the title, the underlying and the labels of the contracts. */
  search?: string | null;
}

export function filterEvents(events: readonly ApiEvent[], { category, cadence, search }: EventFilter): ApiEvent[] {
  const words = search?.trim().toLowerCase() ?? "";
  return events.filter(
    (event) =>
      (!category || event.category === category) &&
      (!cadence || event.cadence === cadence) &&
      (words === "" || [event.title, event.underlying, ...event.markets.map((market) => market.label)].some((text) => text.toLowerCase().includes(words))),
  );
}

/** `ending` is the default order of the index. */
export type EventSort = "ending" | "newest" | "volume";

const compare = <T extends number | bigint | string>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** 0: something can be bought now. 2: listed, not trading yet. 1: everything between. */
function standing(event: ApiEvent): number {
  if (event.venueStatus === "approved") return 2;
  return event.markets.some((market) => market.tradable && isQuoted(market)) ? 0 : 1;
}

/**
 * `ending`: events with a tradable, quoted contract first, then the soonest to expire, and events
 * that are listed but not trading yet last. `newest` and `volume` keep that order among equals.
 */
export function sortEvents(events: readonly ApiEvent[], sort: EventSort = "ending"): ApiEvent[] {
  const ordered = [...events].sort((a, b) => standing(a) - standing(b) || a.expiresAt - b.expiresAt || compare(a.ticker, b.ticker));
  if (sort === "newest") return ordered.sort((a, b) => b.listedAt - a.listedAt);
  if (sort === "volume") return ordered.sort((a, b) => compare(BigInt(b.volumeUnits), BigInt(a.volumeUnits)));
  return ordered;
}

const HALF_PX = 5_000n;

/**
 * The contracts of an event, the ones worth showing first: the quoted ones by how near their
 * chance is to 50%, or, for a ladder nobody quotes, its middle contracts onwards.
 */
function ranked(event: Pick<ApiEvent, "markets">): ApiMarket[] {
  const quoted = event.markets.filter(isQuoted);
  if (quoted.length === 0) return event.markets.slice(Math.max(0, Math.floor((event.markets.length - 1) / 2)));
  const distance = (market: ApiMarket) => {
    const chance = chancePx(market);
    // A quoted contract without a chance comes after every one that has it.
    return chance === null ? HALF_PX + 1n : chance > HALF_PX ? chance - HALF_PX : HALF_PX - chance;
  };
  return quoted.sort((a, b) => compare(distance(a), distance(b)) || a.sortOrder - b.sortOrder);
}

export interface CardRows {
  /** At most two contracts, in the order of the ladder. */
  markets: ApiMarket[];
  /** False when nobody quotes the event: its rows are shown dimmed, with "No offers". */
  quoted: boolean;
  /** How many contracts of the event the card leaves out. */
  more: number;
}

/** The rows of an event's card: its one contract, or the two of a ladder worth showing first. */
export function cardRows(event: Pick<ApiEvent, "markets">): CardRows {
  const markets = ranked(event)
    .slice(0, 2)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return { markets, quoted: event.markets.some(isQuoted), more: event.markets.length - markets.length };
}

/** The contract an event page opens on: the one its link names, else the one the card ranks first. Null for an event without contracts. */
export function selectedContract(event: Pick<ApiEvent, "markets">, symbol: string | null | undefined): ApiMarket | null {
  return event.markets.find((market) => market.symbol === symbol) ?? ranked(event)[0] ?? null;
}

export type EventPhase = { phase: "upcoming"; opensAt: number | null } | { phase: "live" } | { phase: "closed" } | { phase: "settled" };

/**
 * Where an event stands at `nowMs`: upcoming until its first contract starts (with no time while
 * the venue has listed it without opening it), then live until it expires, then closed until the
 * venue settles it.
 */
export function eventPhase(event: Pick<ApiEvent, "venueStatus" | "expiresAt" | "markets">, nowMs: number): EventPhase {
  if (event.venueStatus === "settled") return { phase: "settled" };
  if (event.venueStatus === "under_review" || nowMs >= event.expiresAt) return { phase: "closed" };
  const opensAt = Math.min(...event.markets.map((market) => market.startsAt));
  if (opensAt > nowMs) return { phase: "upcoming", opensAt };
  if (event.venueStatus === "approved") return { phase: "upcoming", opensAt: null };
  return { phase: "live" };
}
