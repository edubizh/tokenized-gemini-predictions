// Integer money math. Units are outcome-token base units (2 decimals, 100 per contract),
// px is micro-dollars per unit, money is micro-dollars.

export const UNITS_PER_CONTRACT = 100n;
export const PAYOUT_PER_UNIT = 10_000n;
export const PX_MIN = 1n;
export const PX_MAX = 9_999n;

const MICROS_PER_CENT = 10_000n;
/** `7 * units * px * (10_000 - px)` divided by this is the taker fee in cents. */
const FEE_SCALE = 10n ** 10n;
/** P x (1 - P) peaks at 50 cents. */
const FEE_PEAK_PX = 5_000n;

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Strict decimal-string to scaled-integer conversion. Only plain `digits[.digits]` is accepted;
 * fractional digits beyond `decimals` are allowed only when they are all zeros.
 */
export function parseDecimal(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`invalid number of decimals: ${String(decimals)}`);
  }
  if (typeof text !== "string" || !DECIMAL.test(text)) {
    throw new RangeError(`not a plain decimal: ${display(text)}`);
  }
  const [whole = "", fraction = ""] = text.split(".");
  if (/[^0]/.test(fraction.slice(decimals))) {
    throw new RangeError(`more than ${decimals} decimals: ${text}`);
  }
  return BigInt(whole + fraction.slice(0, decimals).padEnd(decimals, "0"));
}

/** Venue quantity in contracts (`"1.00"`) to units. */
export function parseUnits(quantity: string): bigint {
  return parseDecimal(quantity, 2);
}

/** Venue price in dollars per contract (`"0.17"`) to px. */
export function parsePx(price: string): bigint {
  return checkedPx(parseDecimal(price, 4));
}

/** Dollar amount (`"0.02"`) to micro-dollars. */
export function parseMicros(dollars: string): bigint {
  return parseDecimal(dollars, 6);
}

/** Units to a venue quantity in contracts, always with 2 decimals. */
export function formatUnits(units: bigint): string {
  return formatDecimal(checkedUnits(units), 2);
}

/** Px to a venue price in dollars per contract: 2 decimals for whole cents, otherwise 4. */
export function formatPx(px: bigint): string {
  checkedPx(px);
  return px % 100n === 0n ? formatDecimal(px / 100n, 2) : formatDecimal(px, 4);
}

/** Micro-dollars paid for `units` at `px`. */
export function cost(units: bigint, px: bigint): bigint {
  return checkedUnits(units) * checkedPx(px);
}

/** Price of the opposite outcome: the two sides of a contract always sum to the payout. */
export function complementPx(px: bigint): bigint {
  return checkedPx(PAYOUT_PER_UNIT - checkedPx(px));
}

/**
 * Venue taker fee in micro-dollars: 0.07 x contracts x P x (1 - P), rounded up to the next cent.
 */
export function takerFee(units: bigint, px: bigint): bigint {
  const numerator = 7n * checkedUnits(units) * checkedPx(px) * (PAYOUT_PER_UNIT - px);
  return ((numerator + FEE_SCALE - 1n) / FEE_SCALE) * MICROS_PER_CENT;
}

/**
 * Upper bound for the taker fee of a buy with the given limit. The fee is largest at 50 cents,
 * and price improvement can move a fill from the limit toward it.
 */
export function feeCap(units: bigint, limitPx: bigint, slackMicros: bigint = 30_000n): bigint {
  if (slackMicros < 0n) throw new RangeError(`negative slack: ${slackMicros}`);
  const worstPx = checkedPx(limitPx) < FEE_PEAK_PX ? limitPx : FEE_PEAK_PX;
  return takerFee(units, worstPx) + slackMicros;
}

function checkedUnits(units: bigint): bigint {
  if (units < 0n) throw new RangeError(`negative units: ${units}`);
  return units;
}

function checkedPx(px: bigint): bigint {
  if (px < PX_MIN || px > PX_MAX) {
    throw new RangeError(`px out of range ${PX_MIN}..=${PX_MAX}: ${px}`);
  }
  return px;
}

/** `decimals` must be at least 1 and `value` non-negative. */
function formatDecimal(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function display(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : typeof value;
}
