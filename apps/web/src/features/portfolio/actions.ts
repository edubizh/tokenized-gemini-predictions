"use client";

import { useCallback, useState } from "react";
import { describeSendError, sentWithoutAnswer } from "@/features/ticket/actions";
import type { SendProgress } from "@/features/ticket/Ticket";
import { TransactionError } from "@/lib/chain/errors";
import { buildRedeem } from "@/lib/chain/instructions";
import { useConfig } from "@/lib/config";
import { useAccount } from "@/lib/privy/account";
import { useSendTransaction } from "@/lib/privy/wallet";
import type { PositionRow } from "./positions";

/** What the program's refusals mean for someone redeeming tokens. */
const PROGRAM_ERRORS: Record<string, string> = {
  RedeemLocked: "Redemption has not opened for this market yet. Nothing was burned; wait for the countdown.",
  NotSettled: "This market is not settled on Solana, so there is nothing to redeem yet. Nothing was burned.",
  BadQuantity: "There are no tokens to redeem. Nothing was burned.",
};

function describeRedeemError(error: unknown): string {
  if (error instanceof TransactionError && error.programError && PROGRAM_ERRORS[error.programError]) return PROGRAM_ERRORS[error.programError] as string;
  return describeSendError(error).replace("Nothing was held.", "Nothing was burned.");
}

export interface RedeemState {
  /** The mint being redeemed, or the one whose last attempt failed. */
  mint: string | null;
  progress: SendProgress | null;
  error: string | null;
}

export interface Redeem extends RedeemState {
  /** Resolves with the signature of the redemption, or null when it failed. */
  redeem(row: Pick<PositionRow, "mint" | "units" | "market">): Promise<string | null>;
}

/**
 * Redeems a whole position in one transaction signed by the holder: the test-dollar account if
 * it is missing, then `redeem` for the full balance. Tokens that lost are burned for nothing.
 */
export function useRedeem(): Redeem {
  const config = useConfig();
  const account = useAccount();
  const send = useSendTransaction();
  const [state, setState] = useState<RedeemState>({ mint: null, progress: null, error: null });
  const wallet = account.wallet?.address ?? null;
  const { refresh } = account;

  const redeem = useCallback<Redeem["redeem"]>(
    async (row) => {
      if (!wallet || !config.stableMint || !row.market.onchain) return null;
      setState({ mint: row.mint, progress: "wallet", error: null });
      try {
        const instructions = await buildRedeem({
          programId: config.programId,
          holder: wallet,
          market: row.market.onchain.market,
          outcomeMint: row.mint,
          stableMint: config.stableMint,
          amount: row.units,
        });
        const signature = await send({
          instructions,
          onStage: (stage) => setState({ mint: row.mint, progress: stage === "preparing" || stage === "signing" ? "wallet" : "sending", error: null }),
        });
        refresh();
        setState({ mint: null, progress: null, error: null });
        return signature;
      } catch (caught) {
        // Sent, outcome not read: the next read of the wallet shows whether the tokens were redeemed.
        if (sentWithoutAnswer(caught)) refresh();
        setState({ mint: row.mint, progress: null, error: sentWithoutAnswer(caught) ? null : describeRedeemError(caught) });
        return null;
      }
    },
    [config, refresh, send, wallet],
  );

  return { ...state, redeem };
}
