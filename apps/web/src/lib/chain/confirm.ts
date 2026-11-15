import type { Signature } from "@solana/kit";
import type { AppRpc } from "./rpc";

const POLL_MS = 1_000;
/** The longest pause after reads that keep failing. */
const MAX_POLL_MS = 5_000;
/** Longer than a blockhash lives, so a read that answers sees it expire before this runs out. */
const MAX_WAIT_MS = 120_000;

/** `unknown`: the reads kept failing, so whether the transaction landed is not known. */
export type Confirmation = { outcome: "confirmed" } | { outcome: "failed"; err: unknown } | { outcome: "expired" } | { outcome: "unknown" };

export interface ConfirmOptions {
  sleep?(ms: number): Promise<void>;
  /** The total of the pauses after which the outcome is given as unknown. */
  maxWaitMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `getSignatureStatuses` until the transaction is confirmed, has failed, or its blockhash
 * has expired (after which it can never land). A read that fails (rate limit, server error,
 * network) is no answer: the polling goes on, pausing a little longer after each failed read,
 * and ends as unknown only when the reads have failed for the whole wait.
 */
export async function confirmSignature(rpc: AppRpc, signature: Signature, lastValidBlockHeight: bigint, options: ConfirmOptions = {}): Promise<Confirmation> {
  const { sleep = wait, maxWaitMs = MAX_WAIT_MS } = options;
  let failures = 0;
  let waited = 0;
  for (;;) {
    try {
      const { value } = await rpc.getSignatureStatuses([signature]).send();
      const status = value[0];
      if (status?.err) return { outcome: "failed", err: status.err };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { outcome: "confirmed" };
      if (!status) {
        const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
        if (height > lastValidBlockHeight) return { outcome: "expired" };
      }
      failures = 0;
    } catch {
      failures += 1;
    }
    if (waited >= maxWaitMs) return { outcome: "unknown" };
    const pause = Math.min(POLL_MS * (1 + failures / 2), MAX_POLL_MS);
    waited += pause;
    await sleep(pause);
  }
}
