// Display formatting. Everything is exact integer math on bigint; nothing passes through a float.

import { formatPx, formatUnits } from "@outcome/relayer/money";

const MINUS = "−";

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Scaled integer to a decimal string: at least `minDecimals`, more only when needed to stay exact. */
function scaled(value: bigint, decimals: number, minDecimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  let fraction = digits.slice(-decimals);
  while (fraction.length > minDecimals && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${group(whole)}.${fraction}`;
}

/** Micro-dollars as dollars: `$1,234.56`. Sub-cent amounts keep their extra digits. */
export function formatDollars(micros: bigint): string {
  const sign = micros < 0n ? MINUS : "";
  return `${sign}$${scaled(micros < 0n ? -micros : micros, 6, 2)}`;
}

/** Like `formatDollars`, with an explicit plus for money coming in. Zero has no sign. */
export function formatSignedDollars(micros: bigint): string {
  return micros > 0n ? `+${formatDollars(micros)}` : formatDollars(micros);
}

/** Price per contract in dollars from px (micro-dollars per unit): `$0.57`. */
export function formatPrice(px: bigint): string {
  return `$${formatPx(px)}`;
}

/** Cents shorthand, for price buttons only: `57¢`. */
export function formatCents(px: bigint): string {
  formatPx(px); // range check
  const fraction = (px % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${px / 100n}${fraction ? `.${fraction}` : ""}¢`;
}

/** Units as contracts, always two decimals: `1.50`. */
export function formatContracts(units: bigint): string {
  const [whole = "0", fraction = "00"] = formatUnits(units).split(".");
  return `${group(whole)}.${fraction}`;
}

/** Lamports as SOL with four decimals: `0.0984`. The rest is cut off, never rounded up. */
export function formatSol(lamports: bigint): string {
  return scaled(lamports / 100_000n, 4, 4);
}

/** `8rj8…DK8p` */
export function shortAddress(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Wall-clock time in the viewer's zone with the zone named: `14:05 UTC`. */
export function formatLocalTime(atMs: number, options: { timeZone?: string; seconds?: boolean } = {}): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: options.seconds ? "2-digit" : undefined,
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone: options.timeZone,
  }).formatToParts(new Date(atMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const clock = [part("hour"), part("minute"), ...(options.seconds ? [part("second")] : [])].join(":");
  return `${clock} ${part("timeZoneName")}`;
}
