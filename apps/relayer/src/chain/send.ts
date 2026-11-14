// Builds, signs, sends and confirms one transaction over HTTP RPC, and turns failures into
// readable messages.

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getSolanaErrorFromTransactionError,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Address,
  type createSolanaRpc,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import * as programClient from "@outcome/program-client";
import { getOutcomeTokensErrorMessage, type OutcomeTokensError } from "@outcome/program-client";
import { computeUnitLimitInstruction } from "./compute-budget.ts";

export type ChainRpc = ReturnType<typeof createSolanaRpc<string>>;
export type Commitment = "confirmed" | "finalized";

const ERROR_CONSTANT_PREFIX = "OUTCOME_TOKENS_ERROR__";

/** Error code -> name as declared in the program (`OrderExpired`), from the generated constants. */
const ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(programClient as Record<string, unknown>)
    .filter((entry): entry is [string, number] => entry[0].startsWith(ERROR_CONSTANT_PREFIX) && typeof entry[1] === "number")
    .map(([constant, code]) => [code, pascalCase(constant.slice(ERROR_CONSTANT_PREFIX.length))]),
);

function pascalCase(constant: string): string {
  return constant
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join("");
}

/** Name of one of the program's own error codes, or null. */
export function programErrorName(code: number): string | null {
  return ERROR_NAMES.get(code) ?? null;
}

/**
 * One line describing why a transaction failed. `error` is a thrown value or the `err` of a
 * transaction status. A custom error of an instruction that belongs to `programId` is named.
 */
export function describeTransactionError(
  error: unknown,
  instructions: ReadonlyArray<{ programAddress: Address }> = [],
  programId?: Address,
): string {
  let failure: unknown = error;
  if (isSolanaError(failure, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE) && failure.cause !== undefined) {
    failure = failure.cause;
  }
  if (!(failure instanceof Error)) {
    try {
      failure = getSolanaErrorFromTransactionError(failure as Parameters<typeof getSolanaErrorFromTransactionError>[0]);
    } catch {
      return typeof failure === "string" ? failure : JSON.stringify(failure, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    }
  }
  if (isSolanaError(failure, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
    const { code, index } = failure.context;
    const own = programId !== undefined && instructions[index]?.programAddress === programId;
    const name = own ? programErrorName(code) : null;
    if (name !== null) {
      return `${name} (${code}): ${getOutcomeTokensErrorMessage(code as OutcomeTokensError)} [instruction ${index}]`;
    }
    return `custom program error ${code} [instruction ${index}]`;
  }
  return (failure as Error).message;
}

export interface SenderOptions {
  rpc: ChainRpc;
  /** Custom errors of this program's instructions are named in error messages. */
  programId: Address;
  commitment: Commitment;
  computeUnitLimit: number;
  /** Upper bound for the confirmation polling of one transaction. */
  confirmTimeoutMs: number;
  /** Delay between status polls. Default 500 ms. */
  pollMs?: number;
}

export interface Sender {
  /**
   * Sends one version-0 transaction (compute-unit limit first, blockhash fetched now, preflight
   * on) and resolves with its signature once it reached the commitment. Rejects when it failed,
   * when its blockhash expired without a known outcome (it can never land afterwards), or when
   * the polling timed out.
   */
  send(feePayer: TransactionSigner, instructions: readonly Instruction[], options?: { computeUnitLimit?: number }): Promise<string>;
}

export function createSender(options: SenderOptions): Sender {
  const { rpc, programId, commitment, confirmTimeoutMs } = options;
  const pollMs = options.pollMs ?? 500;

  return {
    async send(feePayer, instructions, sendOptions = {}) {
      const all = [computeUnitLimitInstruction(sendOptions.computeUnitLimit ?? options.computeUnitLimit), ...instructions];
      const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();
      const transaction = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayerSigner(feePayer, message),
          (message) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
          (message) => appendTransactionMessageInstructions(all, message),
        ),
      );
      const signature = getSignatureFromTransaction(transaction);
      try {
        await rpc
          .sendTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: "base64",
            skipPreflight: false,
            preflightCommitment: commitment,
          })
          .send();
      } catch (error) {
        throw new Error(`transaction rejected: ${describeTransactionError(error, all, programId)}`, { cause: error });
      }

      const deadline = Date.now() + confirmTimeoutMs;
      for (;;) {
        const outcome = await signatureOutcome(rpc, signature, commitment);
        if (outcome.kind === "reached") return signature;
        if (outcome.kind === "failed") {
          throw new Error(`transaction ${signature} failed: ${describeTransactionError(outcome.err, all, programId)}`);
        }
        if (outcome.kind === "unseen") {
          const height = await rpc.getBlockHeight({ commitment }).send();
          if (height > latestBlockhash.lastValidBlockHeight) {
            // It may have landed between the two reads: look once more before giving up.
            const last = await signatureOutcome(rpc, signature, commitment);
            if (last.kind === "reached") return signature;
            if (last.kind === "failed") {
              throw new Error(`transaction ${signature} failed: ${describeTransactionError(last.err, all, programId)}`);
            }
            if (last.kind === "unseen") {
              throw new Error(`transaction ${signature} expired: its blockhash is no longer valid and it never landed`);
            }
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`transaction ${signature} was not confirmed within ${confirmTimeoutMs} ms`);
        }
        await sleep(pollMs);
      }
    },
  };
}

type SignatureOutcome = { kind: "reached" } | { kind: "failed"; err: unknown } | { kind: "pending" } | { kind: "unseen" };

async function signatureOutcome(rpc: ChainRpc, signature: Signature, commitment: Commitment): Promise<SignatureOutcome> {
  const { value } = await rpc.getSignatureStatuses([signature]).send();
  const status = value[0] ?? null;
  if (status === null) return { kind: "unseen" };
  if (status.err !== null) return { kind: "failed", err: status.err };
  const level = status.confirmationStatus;
  const reached = level === "finalized" || (commitment === "confirmed" && level === "confirmed");
  return reached ? { kind: "reached" } : { kind: "pending" };
}

/**
 * Waits until a signature that was sent by other means (an airdrop) reached the commitment.
 * Rejects when the transaction failed or `timeoutMs` passed.
 */
export async function waitForSignature(rpc: ChainRpc, signature: Signature, commitment: Commitment, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await signatureOutcome(rpc, signature, commitment);
    if (outcome.kind === "reached") return;
    if (outcome.kind === "failed") throw new Error(`transaction ${signature} failed: ${describeTransactionError(outcome.err)}`);
    if (Date.now() >= deadline) throw new Error(`transaction ${signature} was not confirmed within ${timeoutMs} ms`);
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
