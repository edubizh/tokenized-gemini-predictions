import { describe, expect, it } from "vitest";
import { address } from "@solana/kit";
import { OUTCOME_TOKENS_PROGRAM_ADDRESS } from "@outcome/program-client";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, computeUnitLimitInstruction } from "./instructions";
import { describeTransactionError, programErrorName } from "./errors";

const program = OUTCOME_TOKENS_PROGRAM_ADDRESS;
const other = address("11111111111111111111111111111111");

describe("computeUnitLimitInstruction", () => {
  it("encodes tag 2 and a little-endian u32 for the ComputeBudget program", () => {
    const instruction = computeUnitLimitInstruction(200_000);
    expect(instruction.programAddress).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS);
    expect(COMPUTE_BUDGET_PROGRAM_ADDRESS).toBe("ComputeBudget111111111111111111111111111111");
    expect(Array.from(instruction.data ?? [])).toEqual([2, 0x40, 0x0d, 0x03, 0x00]);
    expect(instruction.accounts ?? []).toEqual([]);
  });

  it("refuses a limit that is not a u32", () => {
    expect(() => computeUnitLimitInstruction(-1)).toThrow(/compute unit limit/);
    expect(() => computeUnitLimitInstruction(1.5)).toThrow(/compute unit limit/);
    expect(() => computeUnitLimitInstruction(2 ** 32)).toThrow(/compute unit limit/);
  });
});

describe("program errors", () => {
  it("names a program error by its code", () => {
    expect(programErrorName(6002)).toBe("Paused");
    expect(programErrorName(6011)).toBe("TooCloseToClose");
    expect(programErrorName(6026)).toBe("WrongOwner");
    expect(programErrorName(1)).toBeNull();
  });

  it("decodes a custom error raised by the program", () => {
    const err = { InstructionError: [1, { Custom: 6013 }] };
    expect(describeTransactionError(err, [other, program], program)).toEqual({
      name: "BadPrice",
      code: 6013,
      message: "The program refused the transaction: BadPrice (6013).",
    });
  });

  it("does not put a program error name on another program's custom error", () => {
    const err = { InstructionError: [0, { Custom: 6013 }] };
    expect(describeTransactionError(err, [other, program], program)).toEqual({
      name: null,
      code: 6013,
      message: "Instruction 1 failed with custom error 6013.",
    });
  });

  it("describes the other shapes an RPC node returns", () => {
    expect(describeTransactionError("BlockhashNotFound", [program], program).message).toBe("The transaction failed: BlockhashNotFound.");
    expect(describeTransactionError({ InstructionError: [0, "InvalidAccountData"] }, [program], program).message).toBe(
      "Instruction 1 failed: InvalidAccountData.",
    );
    expect(describeTransactionError({ InsufficientFundsForRent: { account_index: 2 } }, [program], program).message).toBe(
      "The transaction failed: InsufficientFundsForRent.",
    );
  });
});
