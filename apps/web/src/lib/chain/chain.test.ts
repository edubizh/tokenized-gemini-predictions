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

describe("order instructions", async () => {
  const { buildCancelOrder, buildPlaceBuy, findOrderAddress } = await import("./instructions");
  const { parseCancelOrderInstruction, parsePlaceBuyInstruction, findEscrowPda, findTraderPda } = await import("@outcome/program-client");
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  const { TOKEN_2022_PROGRAM_ADDRESS } = await import("@solana-program/token-2022");
  const user = address("8rj8sEKjMCkBxMhAKYEz3ZVfGJDqZ6SVSMQBKKmKDK8p");
  const stableMint = address("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  const market = address("AGwgzb61Yk65RXb1AeYDgL2bSGdERLS6imKd5EbSP45r");
  const outcomeMint = address("Dn1CjUXg22r4bD3VeC6H5Fm8dT4zXbMQMh9pfzFNL3PF");

  it("derives a different order address for every nonce", async () => {
    const first = await findOrderAddress(program, user, 0n);
    expect(await findOrderAddress(program, user, 0n)).toBe(first);
    expect(await findOrderAddress(program, user, 1n)).not.toBe(first);
    expect(await findOrderAddress(program, user, 256n)).not.toBe(await findOrderAddress(program, user, 1n));
  });

  it("builds the outcome token account and place_buy for one transaction", async () => {
    const { order, instructions } = await buildPlaceBuy({ programId: program, user, stableMint, market, outcomeMint, side: "NO", units: 200n, limitPx: 4_500n, maxFeeMicros: 70_000n, nonce: 16n });
    expect(order).toBe(await findOrderAddress(program, user, 16n));
    expect(instructions).toHaveLength(2);

    const [userOutcome] = await findAssociatedTokenPda({ owner: user, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const create = instructions[0]!;
    expect(create.accounts?.map((account) => account.address).slice(0, 4)).toEqual([user, userOutcome, user, outcomeMint]);
    expect(create.accounts?.at(-1)?.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);

    const placed = parsePlaceBuyInstruction(instructions[1] as Parameters<typeof parsePlaceBuyInstruction>[0]);
    const [userStable] = await findAssociatedTokenPda({ owner: user, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(placed.programAddress).toBe(program);
    expect(placed.accounts.user.address).toBe(user);
    expect(placed.accounts.payer.address).toBe(user);
    expect(placed.accounts.trader.address).toBe((await findTraderPda({ user }))[0]);
    expect(placed.accounts.market.address).toBe(market);
    expect(placed.accounts.order.address).toBe(order);
    expect(placed.accounts.escrow.address).toBe((await findEscrowPda({ order }))[0]);
    expect(placed.accounts.userStable.address).toBe(userStable);
    expect(placed.accounts.stableMint.address).toBe(stableMint);
    expect(placed.data).toMatchObject({ side: 1, qtyUnits: 200n, limitPx: 4_500, maxFee: 70_000n });
  });

  it("cancels a buy back to the user's test-dollar account", async () => {
    const order = await findOrderAddress(program, user, 16n);
    const [cancel] = await buildCancelOrder({ programId: program, caller: user, order: { address: order, user, market, kind: 0, rentPayer: user }, stableMint });
    const parsed = parseCancelOrderInstruction(cancel as Parameters<typeof parseCancelOrderInstruction>[0]);
    const [userStable] = await findAssociatedTokenPda({ owner: user, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(parsed.accounts.caller.address).toBe(user);
    expect(parsed.accounts.order.address).toBe(order);
    expect(parsed.accounts.escrowMint.address).toBe(stableMint);
    expect(parsed.accounts.userToken.address).toBe(userStable);
    expect(parsed.accounts.rentPayer.address).toBe(user);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS);
  });

  it("needs the outcome mint to cancel a sell", async () => {
    await expect(buildCancelOrder({ programId: program, caller: user, order: { address: user, user, market, kind: 1, rentPayer: user }, stableMint })).rejects.toThrow(/outcome mint/);
  });
});
