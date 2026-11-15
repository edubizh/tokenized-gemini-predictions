import { describe, expect, it } from "vitest";
import type { Signature } from "@solana/kit";
import { confirmSignature } from "./confirm";
import type { AppRpc } from "./rpc";

const SIGNATURE = "5".repeat(88) as Signature;
const LAST_VALID = 1_000n;
const rateLimited = () => new Error("HTTP error (429): Too Many Requests");

type Status = { err: unknown; confirmationStatus: string } | null;
type Answer = Status | Error;

/** An RPC that answers status reads and block heights from scripts; the last entry repeats. */
function fakeRpc(statuses: Answer[], heights: (bigint | Error)[] = [0n]) {
  const next = <T>(script: T[]) => (script.length > 1 ? script.shift() : script[0]) as T;
  const reply = <T>(answer: T | Error) => ({ send: async () => { if (answer instanceof Error) throw answer; return answer; } });
  return {
    getSignatureStatuses: () => {
      const answer = next(statuses);
      return reply(answer instanceof Error ? answer : { value: [answer] });
    },
    getBlockHeight: () => reply(next(heights)),
  } as unknown as AppRpc;
}

/** Records the pauses instead of waiting. */
function pauses() {
  const taken: number[] = [];
  return { taken, sleep: async (ms: number) => void taken.push(ms) };
}

describe("confirmSignature", () => {
  it("keeps asking through rate-limited reads and resolves as confirmed, pausing longer after a failed read", async () => {
    const wait = pauses();
    const rpc = fakeRpc([rateLimited(), rateLimited(), { err: null, confirmationStatus: "confirmed" }]);
    await expect(confirmSignature(rpc, SIGNATURE, LAST_VALID, { sleep: wait.sleep })).resolves.toEqual({ outcome: "confirmed" });
    expect(wait.taken).toHaveLength(2);
    expect(wait.taken[1]).toBeGreaterThan(wait.taken[0] as number);
  });

  it("follows a confirmed transaction as before: no pause when the first read answers", async () => {
    const wait = pauses();
    await expect(confirmSignature(fakeRpc([{ err: null, confirmationStatus: "finalized" }]), SIGNATURE, LAST_VALID, { sleep: wait.sleep })).resolves.toEqual({ outcome: "confirmed" });
    expect(wait.taken).toEqual([]);
  });

  it("ends as expired once a read shows the blockhash has expired, even after failed reads", async () => {
    const wait = pauses();
    const rpc = fakeRpc([rateLimited(), rateLimited(), null], [LAST_VALID + 1n]);
    await expect(confirmSignature(rpc, SIGNATURE, LAST_VALID, { sleep: wait.sleep })).resolves.toEqual({ outcome: "expired" });
  });

  it("ends as unknown, not as an exception, when the reads keep failing for the whole wait", async () => {
    const wait = pauses();
    const rpc = fakeRpc([rateLimited()], [rateLimited()]);
    await expect(confirmSignature(rpc, SIGNATURE, LAST_VALID, { sleep: wait.sleep, maxWaitMs: 30_000 })).resolves.toEqual({ outcome: "unknown" });
    expect(wait.taken.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(30_000);
  });

  it("still reports a transaction that failed on-chain as failed", async () => {
    const err = { InstructionError: [1, { Custom: 6013 }] };
    const rpc = fakeRpc([rateLimited(), { err, confirmationStatus: "confirmed" }]);
    await expect(confirmSignature(rpc, SIGNATURE, LAST_VALID, pauses())).resolves.toEqual({ outcome: "failed", err });
  });
});
