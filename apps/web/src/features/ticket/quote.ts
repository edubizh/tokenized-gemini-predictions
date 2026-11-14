// What a buy order costs and whether it can be placed. Pure integer math: units, px and
// micro-dollars as bigint.

import type { ApiHealth, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { cost, feeCap, parseDecimal, PAYOUT_PER_UNIT } from "@outcome/relayer/money";
import { notTradableWords, type TimeOptions } from "@/features/markets/wording";
import type { Balances } from "@/lib/chain/accounts";
import { formatContracts, formatDollars, formatPrice } from "@/lib/format";

/**
 * SOL a wallet needs before placing an order: the rent of the order, its escrow and a token
 * account (about 0.006 SOL, most of it returned when the order closes) plus fees.
 */
export const MIN_LAMPORTS = 8_000_000n;

export interface QuoteInput {
  side: SideName;
  /** Null when what was typed is not a quantity. */
  units: bigint | null;
  /** Null when what was typed is not a price. */
  limitPx: bigint | null;
  market: ApiMarket;
  /** Null while the relayer cannot be reached. */
  health: ApiHealth | null;
  /** Null until the wallet's balances have been read. */
  balances: Balances | null;
  timeZone?: TimeOptions["timeZone"];
}

export interface QuoteError {
  /** Where the message belongs: under a field, or beside the button. */
  field: "quantity" | "price" | "funds" | "sol" | "market";
  code: string;
  /** What is wrong and what is allowed. */
  message: string;
}

export interface Quote {
  /** `units * limitPx`. */
  costMicros: bigint;
  /** The most the venue fee can be for this order; the program holds it with the cost. */
  maxFeeMicros: bigint;
  /** What leaves the wallet when the order is placed. */
  holdMicros: bigint;
  /** What the tokens pay if the chosen side wins. */
  payoutMicros: bigint;
  errors: QuoteError[];
}

export interface OrderLimits {
  minUnits: bigint;
  /** Null while the relayer's limits are unknown. */
  maxUnits: bigint | null;
  incrementUnits: bigint;
  tickPx: bigint;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function orderLimits(market: ApiMarket, health: ApiHealth | null): OrderLimits {
  const incrementUnits = max(1n, BigInt(market.unitIncrement));
  const minUnits = max(max(1n, BigInt(market.minUnits)), health ? BigInt(health.minOrderUnits) : 1n);
  return { minUnits, maxUnits: health ? BigInt(health.maxOrderUnits) : null, incrementUnits, tickPx: max(1n, BigInt(market.tickPx)) };
}

function lenient(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  try {
    return parseDecimal(trimmed.startsWith(".") ? `0${trimmed}` : trimmed.replace(/\.$/, ""), decimals);
  } catch {
    return null;
  }
}

/** Contracts as typed (`5`, `1.5`, `.25`) to units. Null when it is not a quantity. */
export function parseContracts(text: string): bigint | null {
  return lenient(text, 2);
}

/** Dollars as typed (`0.57`, `.5`) to px. Null when it is not a price; the range is the quote's business. */
export function parsePrice(text: string): bigint | null {
  return lenient(text, 4);
}

function quantityError(units: bigint | null, limits: OrderLimits): QuoteError | null {
  if (units === null) return { field: "quantity", code: "not_a_number", message: "Enter a quantity in contracts, such as 1.00." };
  if (units < limits.minUnits) return { field: "quantity", code: "below_min", message: `Minimum is ${formatContracts(limits.minUnits)} contracts.` };
  if (limits.maxUnits !== null && units > limits.maxUnits) {
    return { field: "quantity", code: "above_max", message: `Maximum is ${formatContracts(limits.maxUnits)} contracts.` };
  }
  if (units % limits.incrementUnits !== 0n) {
    return { field: "quantity", code: "off_increment", message: `Quantity must be a multiple of ${formatContracts(limits.incrementUnits)} contracts.` };
  }
  return null;
}

function priceError(limitPx: bigint | null, limits: OrderLimits): QuoteError | null {
  if (limitPx === null) return { field: "price", code: "not_a_number", message: "Enter a price in dollars, such as 0.57." };
  const lowest = limits.tickPx;
  const highest = ((PAYOUT_PER_UNIT - 1n) / limits.tickPx) * limits.tickPx;
  if (limitPx < lowest || limitPx > highest) {
    return { field: "price", code: "out_of_range", message: `Price must be between ${formatPrice(lowest)} and ${formatPrice(highest)}.` };
  }
  if (limitPx % limits.tickPx !== 0n) return { field: "price", code: "off_tick", message: `Price must be a multiple of ${formatPrice(limits.tickPx)}.` };
  return null;
}

/**
 * A buy holds `units * limitPx + maxFee`. Errors come in the order a person would fix them:
 * what cannot be traded at all, then the two fields, then funds.
 */
export function quoteBuy(input: QuoteInput): Quote {
  const { market, health, balances } = input;
  const limits = orderLimits(market, health);
  const errors: QuoteError[] = [];

  if (health === null) {
    errors.push({ field: "market", code: "relayer_offline", message: "The relayer is offline, so new orders cannot be filled." });
  } else if (health.paused.place) {
    errors.push({ field: "market", code: "paused", message: "Trading is paused. Orders already placed are not affected." });
  } else {
    const reason = notTradableWords(market, { timeZone: input.timeZone });
    if (reason !== null) errors.push({ field: "market", code: "not_tradable", message: reason });
  }

  const quantity = quantityError(input.units, limits);
  const price = priceError(input.limitPx, limits);
  if (quantity) errors.push(quantity);
  if (price) errors.push(price);
  if (quantity || price || input.units === null || input.limitPx === null) {
    return { costMicros: 0n, maxFeeMicros: 0n, holdMicros: 0n, payoutMicros: 0n, errors };
  }

  const costMicros = cost(input.units, input.limitPx);
  const maxFeeMicros = feeCap(input.units, input.limitPx, health ? BigInt(health.feeSlackMicros) : undefined);
  const holdMicros = costMicros + maxFeeMicros;
  if (balances !== null) {
    if (balances.stableMicros < holdMicros) {
      errors.push({
        field: "funds",
        code: "not_enough_dollars",
        message: `This order holds ${formatDollars(holdMicros)}. You have ${formatDollars(balances.stableMicros)} in test dollars.`,
      });
    }
    if (balances.lamports < MIN_LAMPORTS) {
      errors.push({ field: "sol", code: "not_enough_sol", message: "Not enough SOL for network fees. Get test funds to top up." });
    }
  }
  return { costMicros, maxFeeMicros, holdMicros, payoutMicros: input.units * PAYOUT_PER_UNIT, errors };
}
