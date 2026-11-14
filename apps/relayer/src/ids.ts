import { createHash } from "node:crypto";

const ADDRESS_BYTES = 32;
const HEX_CHARS = 32;

/**
 * Venue client order id for an on-chain order: `"o-"` plus the first 32 hex characters of the
 * SHA-256 of the 32-byte order address. An order address never repeats, so neither does the id.
 * The result is 34 characters; the venue allows `[:\-_.#a-zA-Z0-9]{1,36}`.
 */
export function clientOrderIdFor(orderAddressBytes: Uint8Array): string {
  if (!(orderAddressBytes instanceof Uint8Array) || orderAddressBytes.length !== ADDRESS_BYTES) {
    throw new RangeError(`order address must be exactly ${ADDRESS_BYTES} bytes`);
  }
  return "o-" + createHash("sha256").update(orderAddressBytes).digest("hex").slice(0, HEX_CHARS);
}
