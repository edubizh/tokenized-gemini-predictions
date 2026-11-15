// The words the app uses for a market. Everything here is pure: a market from the relayer in,
// sentences out. The raw venue symbol is never a title.

import type { ApiMarket } from "@outcome/relayer/api-types";

export interface TimeOptions {
  /** Defaults to the viewer's zone. */
  timeZone?: string;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `10:00 PM`, or `10:00 PM EST` with the zone named, or `10:00:07 PM` with seconds. Plain spaces only. */
export function formatClock(atMs: number, options: TimeOptions & { zone?: boolean; seconds?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: options.seconds ? "2-digit" : undefined,
    hour12: true,
    timeZone: options.timeZone,
    timeZoneName: options.zone ? "short" : undefined,
  }).formatToParts(new Date(atMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const clock = `${part("hour")}:${part("minute")}${options.seconds ? `:${part("second")}` : ""} ${part("dayPeriod")}`;
  return options.zone ? `${clock} ${part("timeZoneName")}` : clock;
}

function strikeDecimals(whole: bigint): number {
  return whole >= 100n ? 2 : whole >= 1n ? 3 : 5;
}

/**
 * A reference price as the venue prints it (`"67328.95"`, `"75.44495833333333"`) in dollars:
 * 2 decimals at 100 and above, 3 below 100, 5 below 1, rounded half up. Works on the decimal
 * string, never through a float. Anything that is not a plain decimal is returned unchanged.
 */
export function formatStrike(strike: string): string {
  const plain = strike.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) return strike;
  const [wholeText = "0", fraction = ""] = plain.split(".");
  let decimals = strikeDecimals(BigInt(wholeText));
  // One digit more than is kept decides the rounding.
  let rounded = (BigInt(wholeText + fraction.padEnd(decimals + 1, "0").slice(0, decimals + 1)) + 5n) / 10n;
  // Rounding can carry a value into the next band (99.9996 becomes 100.00).
  const band = strikeDecimals(rounded / 10n ** BigInt(decimals));
  if (band < decimals) {
    rounded /= 10n ** BigInt(decimals - band);
    decimals = band;
  }
  const digits = rounded.toString().padStart(decimals + 1, "0");
  return `$${group(digits.slice(0, -decimals))}.${digits.slice(-decimals)}`;
}

/** The strike of a ladder contract as the venue words it, digit for digit: `$68,000 or above`. */
export function strikeLabel(strike: string): string {
  const [whole = "", fraction] = strike.split(".");
  return `$${group(whole)}${fraction === undefined ? "" : `.${fraction}`} or above`;
}

/** A contract by the title of its event and its own label: `BTC price on November 15 · $68,000 or above`. */
export function marketTitle(market: Pick<ApiMarket, "title" | "label">): string {
  return `${market.title} · ${market.label}`;
}

/** The `venueStatus` of a market read from Solana alone: nothing the venue says about it is known. */
export const VENUE_NOT_KNOWN = "not_known";

/** False for a market put together from its accounts on Solana while the relayer is not answering. */
export function venueKnown(market: { venueStatus?: string }): boolean {
  return market.venueStatus !== VENUE_NOT_KNOWN;
}

/**
 * What YES pays for, in one or two sentences. A contract with a strike resolves Yes when the
 * price is at or above it: the strike of a ladder contract, the price to beat of an Up contract.
 */
export function payoutStatement(market: Pick<ApiMarket, "label" | "strike" | "startsAt" | "expiresAt"> & { venueStatus?: string }, options: TimeOptions = {}): string {
  const close = formatClock(market.expiresAt, { ...options, zone: true });
  if (market.strike !== null) return `YES pays $1.00 if the price is at or above ${formatStrike(market.strike)} at ${close}. NO pays $1.00 otherwise.`;
  if (market.label !== "Up") return `YES pays $1.00 if: ${market.label}.`;
  if (!venueKnown(market)) return `YES pays $1.00 if the price is at or above its price to beat at ${close}. NO pays $1.00 otherwise. The price to beat is not known while the relayer is not answering.`;
  return `The reference price is set when the window opens at ${formatClock(market.startsAt, options)}.`;
}

/**
 * The price an Up contract must close at or above, or when it will be known: the venue publishes
 * it a minute or two after the window opens. Null for any other contract.
 */
export function priceToBeat(market: Pick<ApiMarket, "label" | "strike" | "startsAt"> & { venueStatus?: string }, options: TimeOptions = {}): string | null {
  if (market.label !== "Up") return null;
  if (market.strike === null && !venueKnown(market)) return "Not known while the relayer is not answering";
  return market.strike === null ? `Set shortly after ${formatClock(market.startsAt, options)}` : formatStrike(market.strike);
}

/** Why a contract cannot be traded now, or null when it can. */
export function notTradableWords(market: Pick<ApiMarket, "tradable" | "notTradableReason" | "startsAt">, options: TimeOptions = {}): string | null {
  if (market.tradable) return null;
  switch (market.notTradableReason) {
    case "not_started":
      return `Opens at ${formatClock(market.startsAt, options)}`;
    case "too_close_to_expiry":
    case "market_not_open":
      return "Orders closed";
    case "no_offers":
      return "No offers right now";
    case "paused":
      return "Trading is paused";
    case "venue_offline":
      return "The venue is offline";
    case "not_active":
    case null:
      return "Not open for orders";
  }
}
