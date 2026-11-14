import {
  address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getUtf8Encoder,
  type Address,
  type Instruction,
} from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { getCancelOrderInstructionAsync, getPlaceBuyInstructionAsync, getRedeemInstructionAsync, Side } from "@outcome/program-client";

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

/** Placing an order creates three accounts; the default limit is too tight for that. */
export const PLACE_ORDER_COMPUTE_UNITS = 300_000;

/** An order's address: the PDA of `["order", user, nonce as little-endian u64]`. */
export async function findOrderAddress(programId: string, user: string, nonce: bigint): Promise<Address> {
  const [order] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [getUtf8Encoder().encode("order"), getAddressEncoder().encode(address(user)), getU64Encoder().encode(nonce)],
  });
  return order;
}

export interface PlaceBuyInput {
  programId: string;
  /** The trading wallet: signer, fee payer and rent payer. */
  user: string;
  stableMint: string;
  /** The on-chain market account. */
  market: string;
  /** The market's mint for the chosen side. */
  outcomeMint: string;
  side: "YES" | "NO";
  units: bigint;
  limitPx: bigint;
  maxFeeMicros: bigint;
  /** The trader's `next_nonce`, read at click time. */
  nonce: bigint;
}

/**
 * One transaction's worth of instructions for a buy: the user's token account for the outcome
 * mint (created if missing, so the fill has somewhere to mint to), then `place_buy`.
 */
export async function buildPlaceBuy(input: PlaceBuyInput): Promise<{ order: Address; instructions: Instruction[] }> {
  const programAddress = address(input.programId);
  const user = address(input.user);
  // The wallet signs the whole transaction later; the instruction only needs its signer role.
  const signer = createNoopSigner(user);
  const stableMint = address(input.stableMint);
  const outcomeMint = address(input.outcomeMint);

  const order = await findOrderAddress(input.programId, input.user, input.nonce);
  const [userStable] = await findAssociatedTokenPda({ owner: user, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [userOutcome] = await findAssociatedTokenPda({ owner: user, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

  const createOutcomeAccount = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: signer,
    ata: userOutcome,
    owner: user,
    mint: outcomeMint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const placeBuy = await getPlaceBuyInstructionAsync(
    {
      user: signer,
      payer: signer,
      market: address(input.market),
      order,
      userStable,
      stableMint,
      side: input.side === "YES" ? Side.Yes : Side.No,
      qtyUnits: input.units,
      limitPx: Number(input.limitPx),
      maxFee: input.maxFeeMicros,
    },
    { programAddress },
  );
  return { order, instructions: [createOutcomeAccount, placeBuy] };
}

export interface CancelOrderInput {
  programId: string;
  /** Whoever sends the cancel. After expiry anyone may. */
  caller: string;
  order: { address: string; user: string; market: string; kind: number; rentPayer: string };
  stableMint: string;
  /** The market's mint for the order's side; needed only to cancel a sell. */
  outcomeMint?: string;
}

/** `cancel_order`: the whole hold goes back to the order's user and the order closes. */
export async function buildCancelOrder(input: CancelOrderInput): Promise<Instruction[]> {
  const isBuy = input.order.kind === 0;
  if (!isBuy && !input.outcomeMint) throw new Error("The outcome mint is needed to cancel a sell order.");
  const escrowMint = address(isBuy ? input.stableMint : (input.outcomeMint as string));
  const tokenProgram = isBuy ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
  const [userToken] = await findAssociatedTokenPda({ owner: address(input.order.user), mint: escrowMint, tokenProgram });
  const cancel = await getCancelOrderInstructionAsync(
    {
      caller: createNoopSigner(address(input.caller)),
      market: address(input.order.market),
      order: address(input.order.address),
      escrowMint,
      userToken,
      rentPayer: address(input.order.rentPayer),
      tokenProgram,
    },
    { programAddress: address(input.programId) },
  );
  return [cancel];
}

export interface RedeemInput {
  programId: string;
  /** The trading wallet: signer and fee payer. It need not be a registered trader. */
  holder: string;
  /** The on-chain market account. */
  market: string;
  /** The market's mint for the tokens being redeemed; it decides which payout applies. */
  outcomeMint: string;
  stableMint: string;
  /** Units to burn. */
  amount: bigint;
}

/**
 * One transaction's worth of instructions for a redemption: the holder's test-dollar account
 * (created if missing, so the payout has somewhere to go), then `redeem`, which burns the tokens
 * and pays what the settlement gives their side from the market's vault. Tokens of the side that
 * lost redeem for nothing, and the transaction still succeeds.
 */
export async function buildRedeem(input: RedeemInput): Promise<Instruction[]> {
  if (input.amount <= 0n) throw new Error("Nothing to redeem.");
  const holder = address(input.holder);
  const signer = createNoopSigner(holder);
  const stableMint = address(input.stableMint);
  const outcomeMint = address(input.outcomeMint);
  const [holderStable] = await findAssociatedTokenPda({ owner: holder, mint: stableMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [holderOutcome] = await findAssociatedTokenPda({ owner: holder, mint: outcomeMint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

  const createStableAccount = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: signer,
    ata: holderStable,
    owner: holder,
    mint: stableMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  // The vault, the PDA of `["redeem", market]`, is derived by the generated client.
  const redeem = await getRedeemInstructionAsync(
    { holder: signer, market: address(input.market), outcomeMint, holderOutcome, holderStable, stableMint, amount: input.amount },
    { programAddress: address(input.programId) },
  );
  return [createStableAccount, redeem];
}
