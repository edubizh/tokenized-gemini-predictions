// Turns the `err` value of a simulation or a signature status into something a person can read.

import * as programClient from "@outcome/program-client";

const ERROR_PREFIX = "OUTCOME_TOKENS_ERROR__";

/** Code to name, built from the generated error constants so new errors are picked up. */
const ERROR_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(programClient)
    .filter((entry): entry is [string, number] => entry[0].startsWith(ERROR_PREFIX) && typeof entry[1] === "number")
    .map(([key, code]) => [code, pascalCase(key.slice(ERROR_PREFIX.length))]),
);

function pascalCase(constant: string): string {
  return constant
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** `BadPrice` for 6013; null for a code the program does not define. */
export function programErrorName(code: number): string | null {
  return ERROR_NAMES.get(code) ?? null;
}

export interface TransactionErrorInfo {
  /** Program error name when the failing instruction belongs to the program. */
  name: string | null;
  code: number | null;
  message: string;
}

function variantName(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return Object.keys(value)[0] ?? "unknown error";
  return "unknown error";
}

/**
 * @param err the JSON `err` an RPC node returns
 * @param instructionPrograms program address of every instruction in the message, in order
 */
export function describeTransactionError(err: unknown, instructionPrograms: readonly string[], programId: string): TransactionErrorInfo {
  const instructionError =
    typeof err === "object" && err !== null ? (err as { InstructionError?: unknown }).InstructionError : undefined;
  if (Array.isArray(instructionError)) {
    const index = Number(instructionError[0]);
    const detail: unknown = instructionError[1];
    const custom = typeof detail === "object" && detail !== null ? (detail as { Custom?: unknown }).Custom : undefined;
    if (custom !== undefined) {
      const code = Number(custom);
      const name = instructionPrograms[index] === programId ? programErrorName(code) : null;
      if (name) return { name, code, message: `The program refused the transaction: ${name} (${code}).` };
      return { name: null, code, message: `Instruction ${index + 1} failed with custom error ${code}.` };
    }
    return { name: null, code: null, message: `Instruction ${index + 1} failed: ${variantName(detail)}.` };
  }
  return { name: null, code: null, message: `The transaction failed: ${variantName(err)}.` };
}

/** `unknown`: sent and taken by the network, but whether it landed could not be read. */
export type TransactionStage = "simulate" | "sign" | "send" | "confirm" | "expired" | "unknown";

/** Thrown by the send helper. `stage` says how far the transaction got. */
export class TransactionError extends Error {
  readonly stage: TransactionStage;
  readonly programError: string | null;
  readonly signature: string | null;
  readonly logs: readonly string[];

  constructor(stage: TransactionStage, message: string, extra: { programError?: string | null; signature?: string | null; logs?: readonly string[] } = {}) {
    super(message);
    this.name = "TransactionError";
    this.stage = stage;
    this.programError = extra.programError ?? null;
    this.signature = extra.signature ?? null;
    this.logs = extra.logs ?? [];
  }
}
