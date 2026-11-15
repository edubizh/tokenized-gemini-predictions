// What a buy order costs, what a sale pays at least, and whether either can be placed. Pure
// integer math: units, px and micro-dollars as bigint.

import type { ApiHealth, ApiMarket, SideName } from "@outcome/relayer/api-types";
import { complementPx, cost, feeCap, parseDecimal, PAYOUT_PER_UNIT } from "@outcome/relayer/money";
import { notTradableWords, type TimeOptions } from "@/features/markets/wording";
import type { Balances } from "@/lib/chain/accounts";
import { formatCents, formatContracts, formatDollars } from "@/lib/format";

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
  field: "quantity" | "price" | "funds" | "fee" | "sol" | "market";
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

/** Cents as typed (`57`, `45.5`) to px: one cent is 100 px. Null when it is not a price. */
export function parseCents(text: string): bigint | null {
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
  if (limitPx === null) return { field: "price", code: "not_a_number", message: "Enter a price in cents, such as 57." };
  const lowest = limits.tickPx;
  const highest = ((PAYOUT_PER_UNIT - 1n) / limits.tickPx) * limits.tickPx;
  if (limitPx < lowest || limitPx > highest) {
    return { field: "price", code: "out_of_range", message: `Price must be between ${formatCents(lowest)} and ${formatCents(highest)}.` };
  }
  if (limitPx % limits.tickPx !== 0n) return { field: "price", code: "off_tick", message: `Price must be a multiple of ${formatCents(limits.tickPx)}.` };
  return null;
}

/** Why nothing can be traded at all right now, or null. */
function marketError(market: ApiMarket, health: ApiHealth | null, timeZone: TimeOptions["timeZone"]): QuoteError | null {
  if (health === null) return { field: "market", code: "relayer_offline", message: "The relayer is offline, so new orders cannot be filled." };
  if (health.paused.place) return { field: "market", code: "paused", message: "Trading is paused. Orders already placed are not affected." };
  const reason = notTradableWords(market, { timeZone });
  return reason === null ? null : { field: "market", code: "not_tradable", message: reason };
}

const sideWord = (side: SideName) => (side === "YES" ? "Yes" : "No");

const SOL_ERROR: QuoteError = { field: "sol", code: "not_enough_sol", message: "Not enough SOL for network fees. Get test funds to top up." };

/**
 * A buy holds `units * limitPx + maxFee`. Errors come in the order a person would fix them:
 * what cannot be traded at all, then the two fields, then funds.
 */
export function quoteBuy(input: QuoteInput): Quote {
  const { market, health, balances } = input;
  const limits = orderLimits(market, health);
  const errors: QuoteError[] = [];

  const closed = marketError(market, health, input.timeZone);
  if (closed) errors.push(closed);

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
      errors.push(SOL_ERROR);
    }
  }
  return { costMicros, maxFeeMicros, holdMicros, payoutMicros: input.units * PAYOUT_PER_UNIT, errors };
}

export interface SellQuoteInput {
  side: SideName;
  /** Null when what was typed is not a quantity. */
  units: bigint | null;
  /** The least the seller accepts per unit. Null when what was typed is not a price. */
  minPx: bigint | null;
  market: ApiMarket;
  /** Null while the relayer cannot be reached. */
  health: ApiHealth | null;
  /** Null until the wallet's balances have been read. */
  balances: Balances | null;
  /** The wallet's tokens of the chosen side, in units. Null until they have been read. */
  heldUnits: bigint | null;
  timeZone?: TimeOptions["timeZone"];
}

export interface SellQuote {
  /** `units * minPx`: the least the sale brings before the fee. */
  proceedsMicros: bigint;
  /** The most the venue fee can be; it is paid out of the proceeds. */
  maxFeeMicros: bigint;
  /** What reaches the wallet at the least: the minimum proceeds less the fee cap. */
  receiveMicros: bigint;
  /** The smallest quantity that covers the fee cap at this price. Null when none does, or the price is not valid. */
  minSellUnits: bigint | null;
  errors: QuoteError[];
}

/** A sale is sent to the venue as a buy of the opposite outcome at the complement of its minimum. */
export function sellFeeCap(units: bigint, minPx: bigint, slackMicros?: bigint): bigint {
  return feeCap(units, complementPx(minPx), slackMicros);
}

/** The venue rounds its fee up to a whole cent. */
const FEE_ROUNDING_MICROS = 10_000n;
/** Large enough that the fee of this many units is not rounded: it gives the exact fee rate. */
const RATE_UNITS = 10n ** 10n;
const SEARCH_STEPS = 100_000;

/**
 * The quantity from which a sale at this minimum always covers its fee cap, as the relayer
 * requires (`units * minPx > maxFee`). The fee is rounded up to a cent, so a few smaller
 * quantities can pass too; this is the one to name, because everything above it works. The fee
 * grows with the quantity as well, so at a very low price no quantity is enough: null.
 */
export function smallestSale(minPx: bigint, limits: OrderLimits, slackMicros: bigint = 30_000n): bigint | null {
  const step = limits.incrementUnits;
  // Proceeds grow by `minPx` a unit and the fee by `feeRate / RATE_UNITS` a unit, before rounding.
  const gain = minPx * RATE_UNITS - sellFeeCap(RATE_UNITS, minPx, 0n);
  if (gain <= 0n) return null;
  // Above this the proceeds exceed even a fee rounded up by a whole cent.
  const safe = ((FEE_ROUNDING_MICROS + slackMicros) * RATE_UNITS) / gain + 1n;
  const first = ((limits.minUnits + step - 1n) / step) * step;
  let units = ((safe + step - 1n) / step) * step;
  if (units < first) return first;
  const works = (candidate: bigint) => candidate * minPx > sellFeeCap(candidate, minPx, slackMicros);
  for (let tried = 0; tried < SEARCH_STEPS && units - step >= first && works(units - step); tried++) units -= step;
  return units;
}

/**
 * A sale holds the tokens and pays at least `units * minPx - maxFee`. The relayer sends it only
 * when the minimum proceeds exceed the fee cap; a sale that cannot is refused here, with the
 * smallest quantity that would work.
 */
export function quoteSell(input: SellQuoteInput): SellQuote {
  const { market, health, balances, heldUnits } = input;
  // The program's minimum quantity applies to buys only; the venue's applies to both.
  const limits: OrderLimits = { ...orderLimits(market, health), minUnits: max(1n, BigInt(market.minUnits)) };
  const errors: QuoteError[] = [];

  const closed = marketError(market, health, input.timeZone);
  if (closed) errors.push(closed);

  let quantity = quantityError(input.units, limits);
  if (heldUnits !== null && input.units !== null && (quantity === null || quantity.code === "above_max")) {
    if (heldUnits === 0n) quantity = { field: "quantity", code: "nothing_held", message: `You hold no ${sideWord(input.side)} tokens of this market.` };
    else if (input.units > heldUnits) quantity = { field: "quantity", code: "above_held", message: `You hold ${formatContracts(heldUnits)} ${sideWord(input.side)}. That is the most you can sell.` };
  }
  const price = priceError(input.minPx, limits);
  if (quantity) errors.push(quantity);
  if (price) errors.push(price);
  const slack = health ? BigInt(health.feeSlackMicros) : undefined;
  const minSellUnits = price || input.minPx === null ? null : smallestSale(input.minPx, limits, slack);
  if (quantity || price || input.units === null || input.minPx === null) {
    return { proceedsMicros: 0n, maxFeeMicros: 0n, receiveMicros: 0n, minSellUnits, errors };
  }

  const proceedsMicros = cost(input.units, input.minPx);
  const maxFeeMicros = sellFeeCap(input.units, input.minPx, slack);
  const covered = proceedsMicros > maxFeeMicros;
  if (!covered) {
    const at = formatCents(input.minPx);
    errors.push({
      field: "fee",
      code: "fee_cap",
      message:
        minSellUnits === null
          ? `At ${at} a sale cannot cover the fee cap at any quantity. Set a higher minimum price.`
          : `At ${at} a sale needs at least ${formatContracts(minSellUnits)} contracts to cover the fee cap.`,
    });
  }
  if (balances !== null && balances.lamports < MIN_LAMPORTS) errors.push(SOL_ERROR);
  return { proceedsMicros, maxFeeMicros, receiveMicros: covered ? proceedsMicros - maxFeeMicros : 0n, minSellUnits, errors };
}
