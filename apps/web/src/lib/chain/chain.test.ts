import { describe, expect, it } from "vitest";
import { AccountRole, address, type Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { findVaultPda, OUTCOME_TOKENS_PROGRAM_ADDRESS, parseRedeemInstruction } from "@outcome/program-client";
import { buildRedeem, COMPUTE_BUDGET_PROGRAM_ADDRESS, computeUnitLimitInstruction } from "./instructions";
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

  it("builds the test-dollar account and place_sell for one transaction", async () => {
    const { buildPlaceSell } = await import("./instructions");
    const { parsePlaceSellInstruction } = await import("@outcome/program-client");
    const { order, instructions } = await buildPlaceSell({ programId: program, user, stableMint, market, outcomeMint, side: "YES", units: 300n, minPx: 5_500n, maxFeeMicros: 90_000n, nonce: 17n });
    expect(order).toBe(await findOrderAddress(program, user, 17n));
    expect(instructions).toHaveLength(2);

    // A fill pays test dollars, so the account they go to is created if it is missing.
    const [userStable] = await findAssociatedTokenPda({ owner: user, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const create = instructions[0]!;
    expect(create.accounts?.map((account) => account.address).slice(0, 4)).toEqual([user, userStable, user, stableMint]);
    expect(create.accounts?.at(-1)?.address).toBe(TOKEN_PROGRAM_ADDRESS);

    const placed = parsePlaceSellInstruction(instructions[1] as Parameters<typeof parsePlaceSellInstruction>[0]);
    const [userOutcome] = await findAssociatedTokenPda({ owner: user, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    expect(placed.programAddress).toBe(program);
    expect(placed.accounts.user.address).toBe(user);
    expect(placed.accounts.payer.address).toBe(user);
    expect(placed.accounts.trader.address).toBe((await findTraderPda({ user }))[0]);
    expect(placed.accounts.market.address).toBe(market);
    expect(placed.accounts.order.address).toBe(order);
    expect(placed.accounts.escrow.address).toBe((await findEscrowPda({ order }))[0]);
    expect(placed.accounts.userOutcome.address).toBe(userOutcome);
    expect(placed.accounts.outcomeMint.address).toBe(outcomeMint);
    expect(placed.accounts.tokenProgram.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(placed.data).toMatchObject({ side: 0, qtyUnits: 300n, minPx: 5_500, maxFee: 90_000n });
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

describe("buildRedeem", () => {
  const holder = address("8rj8Yq7cTmWXxvPx9aK9JVnRjUhhQn4SV1vLx9pYDK8p");
  const market = address("So11111111111111111111111111111111111111112");
  const outcomeMint = address("SysvarRent111111111111111111111111111111111");
  const stableMint = address("SysvarC1ock11111111111111111111111111111111");

  it("creates the holder's test-dollar account if it is missing, then redeems from the associated accounts", async () => {
    const instructions = await buildRedeem({ programId: program, holder, market, outcomeMint, stableMint, amount: 500n });
    expect(instructions).toHaveLength(2);
    const [create, redeem] = instructions as [Instruction, Instruction];

    const [holderStable] = await findAssociatedTokenPda({ owner: holder, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [holderOutcome] = await findAssociatedTokenPda({ owner: holder, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const [vault] = await findVaultPda({ market }, { programAddress: program });

    expect(create.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    // Discriminator 1 is the idempotent create: it does nothing when the account exists.
    expect(Array.from(create.data ?? [])).toEqual([1]);
    const created = (create.accounts ?? []).map((account) => account.address);
    expect(created.slice(0, 4)).toEqual([holder, holderStable, holder, stableMint]);
    expect(created).toContain(TOKEN_PROGRAM_ADDRESS);

    expect(redeem.programAddress).toBe(program);
    const parsed = parseRedeemInstruction(redeem as Parameters<typeof parseRedeemInstruction>[0]);
    expect(parsed.data.amount).toBe(500n);
    expect(parsed.accounts.holder.address).toBe(holder);
    expect(parsed.accounts.holder.role).toBe(AccountRole.READONLY_SIGNER);
    expect(parsed.accounts.market.address).toBe(market);
    expect(parsed.accounts.outcomeMint.address).toBe(outcomeMint);
    expect(parsed.accounts.holderOutcome.address).toBe(holderOutcome);
    expect(parsed.accounts.vault.address).toBe(vault);
    expect(parsed.accounts.holderStable.address).toBe(holderStable);
    expect(parsed.accounts.stableMint.address).toBe(stableMint);
    expect(parsed.accounts.stableTokenProgram.address).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(parsed.accounts.outcomeTokenProgram.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);
  });

  it("refuses an amount of zero before anything is built", async () => {
    await expect(buildRedeem({ programId: program, holder, market, outcomeMint, stableMint, amount: 0n })).rejects.toThrow("Nothing to redeem.");
  });
});
