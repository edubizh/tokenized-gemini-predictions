import type { Signature } from "@solana/kit";
import type { AppRpc } from "./rpc";

const POLL_MS = 1_000;

export type Confirmation = { outcome: "confirmed" } | { outcome: "failed"; err: unknown } | { outcome: "expired" };

/**
 * Polls `getSignatureStatuses` until the transaction is confirmed, has failed, or its blockhash
 * has expired (after which it can never land).
 */
export async function confirmSignature(rpc: AppRpc, signature: Signature, lastValidBlockHeight: bigint): Promise<Confirmation> {
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) return { outcome: "failed", err: status.err };
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return { outcome: "confirmed" };
    if (!status) {
      const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
      if (height > lastValidBlockHeight) return { outcome: "expired" };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
