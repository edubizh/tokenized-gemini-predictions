import { address, type Address, type Instruction } from "@solana/kit";

export const COMPUTE_BUDGET_PROGRAM_ADDRESS: Address = address("ComputeBudget111111111111111111111111111111");

/** Instruction tag of `SetComputeUnitLimit` in the ComputeBudget program. */
const SET_COMPUTE_UNIT_LIMIT = 2;
const U32_MAX = 0xffff_ffff;

/** `SetComputeUnitLimit(units)`: the tag byte followed by the limit as a little-endian u32. */
export function computeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > U32_MAX) {
    throw new RangeError(`compute unit limit must be a u32: ${String(units)}`);
  }
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}
