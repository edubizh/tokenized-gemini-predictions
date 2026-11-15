// The registrar key registers wallets as traders and pays starter funds. It is read from
// REGISTRAR_KEYPAIR (a path, or the 64-byte JSON array itself) or `.keys/registrar-keypair.json`
// in the repo root. Its bytes are never logged or returned.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getTransferCheckedInstruction } from "@solana-program/token";
import { getRegisterTraderInstructionAsync } from "@outcome/program-client";
import { fetchBalances, fetchTrader, stableAccountAddress } from "@/lib/chain/accounts";
import { confirmSignature } from "@/lib/chain/confirm";
import { describeTransactionError } from "@/lib/chain/errors";
import { computeUnitLimitInstruction } from "@/lib/chain/instructions";
import { getRpc } from "@/lib/chain/rpc";
import { REPO_ROOT, type Deployment } from "@/lib/config.server";
import { STARTER, type FundingChain } from "./onboard";

const STABLE_DECIMALS = 6;
const REGISTER_COMPUTE_UNITS = 150_000;
const TOP_UP_COMPUTE_UNITS = 80_000;

let registrar: Promise<KeyPairSigner> | null = null;

async function loadRegistrar(): Promise<KeyPairSigner> {
  const setting = process.env.REGISTRAR_KEYPAIR;
  const text = setting?.trim().startsWith("[")
    ? setting
    : await readFile(/* turbopackIgnore: true */ setting ?? path.join(REPO_ROOT, ".keys", "registrar-keypair.json"), "utf8");
  const bytes: unknown = JSON.parse(text);
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error("The registrar key is not a 64-byte keypair.");
  return createKeyPairSignerFromBytes(Uint8Array.from(bytes as number[]));
}

function registrarSigner(): Promise<KeyPairSigner> {
  registrar ??= loadRegistrar().catch((error: unknown) => {
    registrar = null;
    throw new Error(`The registrar key could not be loaded: ${error instanceof Error ? error.message : "unknown error"}`);
  });
  return registrar;
}

export function createFundingChain(deployment: Deployment, rpcUrl: string): FundingChain {
  const rpc = getRpc(rpcUrl);
  const programAddress = address(deployment.programId);
  const stableMint = address(deployment.stableMint);

  async function send(signer: KeyPairSigner, computeUnits: number, instructions: Instruction[]): Promise<string> {
    const all = [computeUnitLimitInstruction(computeUnits), ...instructions];
    const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(all, m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
    const confirmation = await confirmSignature(rpc, signature, latestBlockhash.lastValidBlockHeight);
    if (confirmation.outcome === "failed") {
      throw new Error(describeTransactionError(confirmation.err, all.map((i) => i.programAddress), deployment.programId).message);
    }
    if (confirmation.outcome === "expired") throw new Error("The transaction was not confirmed before its blockhash expired.");
    if (confirmation.outcome === "unknown") throw new Error("The transaction was sent, but Solana did not say whether it landed.");
    return signature;
  }

  async function fundingInstructions(signer: KeyPairSigner, wallet: string, amounts: { stableMicros: bigint; lamports: bigint }): Promise<Instruction[]> {
    const user = address(wallet);
    const instructions: Instruction[] = [];
    if (amounts.stableMicros > 0n) {
      const destination = await stableAccountAddress(wallet, deployment.stableMint);
      instructions.push(
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: user, mint: stableMint }),
        getTransferCheckedInstruction({
          source: address(deployment.faucet),
          mint: stableMint,
          destination,
          authority: signer,
          amount: amounts.stableMicros,
          decimals: STABLE_DECIMALS,
        }),
      );
    }
    if (amounts.lamports > 0n) {
      instructions.push(getTransferSolInstruction({ source: signer, destination: user, amount: amounts.lamports }));
    }
    return instructions;
  }

  return {
    async traderExists(wallet) {
      return (await fetchTrader(rpc, deployment.programId, wallet)) !== null;
    },
    balances(wallet) {
      return fetchBalances(rpc, wallet, deployment.stableMint);
    },
    async registerAndFund(wallet) {
      const signer = await registrarSigner();
      const register = await getRegisterTraderInstructionAsync({ registrar: signer, payer: signer, user: address(wallet) }, { programAddress });
      return send(signer, REGISTER_COMPUTE_UNITS, [register, ...(await fundingInstructions(signer, wallet, STARTER))]);
    },
    async topUp(wallet, amounts) {
      const signer = await registrarSigner();
      return send(signer, TOP_UP_COMPUTE_UNITS, await fundingInstructions(signer, wallet, amounts));
    },
  };
}
