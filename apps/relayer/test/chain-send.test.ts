import {
  address,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
  getSolanaErrorFromTransactionError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { describeTransactionError, programErrorName } from "../src/chain/send.ts";

const PROGRAM = address("8TN1HWcEFTAcM7Vthmih1FKftTBrp3LDgTBkfhp1PRVn");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
const instructions = [{ programAddress: COMPUTE_BUDGET }, { programAddress: PROGRAM }];

describe("programErrorName", () => {
  it("names the program's error codes", () => {
    expect(programErrorName(6000)).toBe("Unauthorized");
    expect(programErrorName(6021)).toBe("OrderExpired");
    expect(programErrorName(6003)).toBe("RealStablecoinNotAllowed");
    expect(programErrorName(6030)).toBe("MathOverflow");
  });

  it("returns null for other codes", () => {
    expect(programErrorName(5999)).toBeNull();
    expect(programErrorName(6031)).toBeNull();
    expect(programErrorName(0)).toBeNull();
  });
});

describe("describeTransactionError", () => {
  it("names a program error reported by a transaction status", () => {
    const text = describeTransactionError({ InstructionError: [1, { Custom: 6021 }] }, instructions, PROGRAM);
    expect(text).toContain("OrderExpired");
    expect(text).toContain("6021");
    expect(text).toContain("instruction 1");
  });

  it("names a program error wrapped in a failed preflight", () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
      cause: getSolanaErrorFromTransactionError({ InstructionError: [1, { Custom: 6019 }] }),
    } as never);
    expect(describeTransactionError(preflight, instructions, PROGRAM)).toContain("FeeExceedsCap");
  });

  it("does not name a custom code of another program's instruction", () => {
    const text = describeTransactionError({ InstructionError: [0, { Custom: 6021 }] }, instructions, PROGRAM);
    expect(text).not.toContain("OrderExpired");
    expect(text).toContain("6021");
  });

  it("keeps an unknown custom code of the program as a number", () => {
    const text = describeTransactionError({ InstructionError: [1, { Custom: 3012 }] }, instructions, PROGRAM);
    expect(text).toContain("3012");
  });

  it("describes other failures by their message", () => {
    expect(describeTransactionError("BlockhashNotFound", instructions, PROGRAM)).toMatch(/blockhash/i);
    expect(describeTransactionError(new Error("socket hang up"), instructions, PROGRAM)).toBe("socket hang up");
  });
});
