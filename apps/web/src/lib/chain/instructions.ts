import { address, type Address, type Instruction } from "@solana/kit";

export const COMPUTE_BUDGET_PROGRAM_ADDRESS: Address = address("ComputeBudget111111111111111111111111111111");

/** ComputeBudget `SetComputeUnitLimit`: tag 2 followed by a little-endian u32. */
export function computeUnitLimitInstruction(units: number): Instruction {
  if (!Number.isInteger(units) || units < 0 || units > 0xffff_ffff) {
    throw new RangeError(`compute unit limit must be a u32, got ${units}`);
  }
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS, accounts: [], data };
}
