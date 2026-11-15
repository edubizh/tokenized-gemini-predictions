// The one way the browser sends a transaction: version 0, explicit compute-unit limit, blockhash
// fetched at click time, simulated before anything is signed, signed by the trading wallet, and
// the signed bytes broadcast unchanged.

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Base64EncodedWireTransaction,
  type Instruction,
  type Signature,
} from "@solana/kit";
import { confirmSignature } from "./confirm";
import { describeTransactionError, TransactionError } from "./errors";
import { computeUnitLimitInstruction } from "./instructions";
import type { AppRpc } from "./rpc";

export type SendStage = "preparing" | "signing" | "sending" | "confirming";

export interface SendOptions {
  rpc: AppRpc;
  /** Used to name the program's own errors. */
  programId: string;
  /** The trading wallet: fee payer and only signer. */
  feePayer: string;
  instructions: readonly Instruction[];
  /** Signs the serialized transaction and returns the signed bytes. */
  sign(unsigned: Uint8Array): Promise<Uint8Array>;
  computeUnitLimit?: number;
  onStage?(stage: SendStage): void;
}

const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

function isRejection(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /reject|denied|cancel|closed/i.test(text);
}

/** Resolves with the signature once the transaction is confirmed. Throws `TransactionError`. */
export async function sendInstructions(options: SendOptions): Promise<string> {
  const { rpc, programId, onStage } = options;
  const instructions = [computeUnitLimitInstruction(options.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT), ...options.instructions];
  const programs = instructions.map((instruction) => instruction.programAddress);

  onStage?.("preparing");
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(options.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const unsigned = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));

  const simulation = await rpc
    .simulateTransaction(getBase64Decoder().decode(unsigned) as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      commitment: "confirmed",
    })
    .send();
  if (simulation.value.err) {
    const info = describeTransactionError(simulation.value.err, programs, programId);
    throw new TransactionError("simulate", info.message, { programError: info.name, logs: simulation.value.logs ?? [] });
  }

  onStage?.("signing");
  let signed: Uint8Array;
  try {
    signed = await options.sign(unsigned);
  } catch (error) {
    throw new TransactionError(
      "sign",
      isRejection(error) ? "The wallet did not sign. Nothing was sent." : `The wallet could not sign: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const firstSignature = Object.values(getTransactionDecoder().decode(signed).signatures)[0];
  if (!firstSignature) throw new TransactionError("sign", "The wallet returned no signature. Nothing was sent.");
  const signature = getBase58Decoder().decode(firstSignature) as Signature;

  onStage?.("sending");
  try {
    await rpc
      .sendTransaction(getBase64Decoder().decode(signed) as Base64EncodedWireTransaction, { encoding: "base64", preflightCommitment: "confirmed" })
      .send();
  } catch (error) {
    throw new TransactionError("send", `The network did not accept the transaction: ${error instanceof Error ? error.message : String(error)}`, { signature });
  }

  onStage?.("confirming");
  const confirmation = await confirmSignature(rpc, signature, latestBlockhash.lastValidBlockHeight);
  if (confirmation.outcome === "failed") {
    const info = describeTransactionError(confirmation.err, programs, programId);
    throw new TransactionError("confirm", info.message, { programError: info.name, signature });
  }
  if (confirmation.outcome === "expired") {
    throw new TransactionError("expired", "The transaction was not confirmed before its blockhash expired. It can no longer land; try again.", { signature });
  }
  if (confirmation.outcome === "unknown") {
    throw new TransactionError("unknown", "The transaction was sent, but Solana did not say whether it landed. Check again in a moment before trying again.", { signature });
  }
  return signature;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fixtures mode: nothing is signed and nothing reaches Solana. The instructions go to the app
 * server's simulated chain, which answers with a made-up signature after about a second.
 */
export async function sendFixtureInstructions(options: Pick<SendOptions, "instructions" | "onStage">): Promise<string> {
  const { onStage } = options;
  onStage?.("preparing");
  await pause(150);
  onStage?.("signing");
  await pause(450);
  onStage?.("sending");
  const instructions = options.instructions.map((instruction) => ({
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((account) => ({ address: account.address, role: account.role })),
    data: getBase64Decoder().decode(instruction.data ?? new Uint8Array()),
  }));
  let response: Response;
  try {
    response = await fetch("/api/fixtures/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instructions }) });
  } catch {
    throw new TransactionError("send", "The app server did not answer. Nothing was sent.");
  }
  const body = (await response.json().catch(() => ({}))) as { signature?: string; programError?: string };
  if (!response.ok || !body.signature) {
    const name = body.programError ?? null;
    throw new TransactionError("simulate", name ? `The program refused the transaction: ${name}.` : "The simulated chain refused the transaction.", { programError: name });
  }
  onStage?.("confirming");
  await pause(400);
  return body.signature;
}
