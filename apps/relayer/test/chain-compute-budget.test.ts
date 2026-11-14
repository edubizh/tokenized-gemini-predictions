import { describe, expect, it } from "vitest";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, computeUnitLimitInstruction } from "../src/chain/compute-budget.ts";

describe("computeUnitLimitInstruction", () => {
  it("targets the ComputeBudget program with tag 2 and a little-endian u32", () => {
    const instruction = computeUnitLimitInstruction(300_000);
    expect(COMPUTE_BUDGET_PROGRAM_ADDRESS).toBe("ComputeBudget111111111111111111111111111111");
    expect(instruction.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(instruction.accounts ?? []).toEqual([]);
    // 300_000 = 0x000493e0
    expect(Array.from(instruction.data ?? [])).toEqual([2, 0xe0, 0x93, 0x04, 0x00]);
  });

  it("encodes the largest u32", () => {
    expect(Array.from(computeUnitLimitInstruction(0xffff_ffff).data ?? [])).toEqual([2, 255, 255, 255, 255]);
    expect(Array.from(computeUnitLimitInstruction(1).data ?? [])).toEqual([2, 1, 0, 0, 0]);
  });

  it("rejects values that are not a u32", () => {
    expect(() => computeUnitLimitInstruction(-1)).toThrow(RangeError);
    expect(() => computeUnitLimitInstruction(1.5)).toThrow(RangeError);
    expect(() => computeUnitLimitInstruction(2 ** 32)).toThrow(RangeError);
    expect(() => computeUnitLimitInstruction(Number.NaN)).toThrow(RangeError);
  });
});
