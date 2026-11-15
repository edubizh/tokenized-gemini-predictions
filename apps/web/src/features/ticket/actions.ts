"use client";

import { useCallback, useState } from "react";
import type { ApiMarket, ApiOnchainMarket } from "@outcome/relayer/api-types";
import { TransactionError } from "@/lib/chain/errors";
import { buildCancelOrder, buildPlaceBuy, buildPlaceSell, PLACE_ORDER_COMPUTE_UNITS } from "@/lib/chain/instructions";
import { getReads, type OpenOrder } from "@/lib/chain/reads";
import type { SendStage } from "@/lib/chain/send";
import { clock } from "@/lib/clock";
import { useConfig } from "@/lib/config";
import { useAccount } from "@/lib/privy/account";
import { useSendTransaction } from "@/lib/privy/wallet";
import { ensureMarket, RelayerError } from "@/lib/relayer/client";
import type { SendProgress, TicketDraft } from "./Ticket";
import type { LocalOrder } from "./timeline";

/** What the program's refusals mean for someone placing or reclaiming an order. */
const PROGRAM_ERRORS: Record<string, string> = {
  Paused: "Trading is paused, so the program did not take the order. Nothing was held.",
  MarketNotOpen: "This market is no longer open for orders. Nothing was held.",
  MintsNotReady: "This market is still being prepared on Solana. Try again in a few seconds.",
  TooCloseToClose: "Orders for this market have closed. Nothing was held.",
  BadQuantity: "The program does not accept this quantity. Nothing was held.",
  BadPrice: "The program does not accept this price. Nothing was held.",
  OffTick: "The price is not on the market's tick. Nothing was held.",
  FeeCapTooHigh: "The fee cap is above what the program allows. Nothing was held.",
  InsufficientFunds: "The wallet does not hold enough for this order. Nothing was held.",
  OrderNotExpired: "The order has not expired yet, so it cannot be reclaimed. Wait for the countdown.",
};

/** One sentence for a failed send: what happened and what it means for the user's money. */
export function describeSendError(error: unknown): string {
  if (error instanceof TransactionError) {
    if (error.programError && PROGRAM_ERRORS[error.programError]) return PROGRAM_ERRORS[error.programError] as string;
    if (error.stage === "simulate") return `${error.message} Nothing was signed or sent.`;
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong before the transaction was sent. Nothing was held.";
}

function progressOf(stage: SendStage): SendProgress {
  return stage === "preparing" || stage === "signing" ? "wallet" : "sending";
}

/** Has the relayer create a market's account and mints on Solana, which is needed once per contract. */
async function createMarket(symbol: string, token: string | null): Promise<ApiOnchainMarket> {
  try {
    const { onchain } = await ensureMarket(symbol, token ?? "");
    if (onchain) return onchain;
  } catch (error) {
    if (error instanceof RelayerError && error.status === 401) throw new Error("Your login has expired. Log in again, then retry. Nothing was held.");
  }
  throw new Error("This market could not be prepared on Solana. Nothing was held; try again in a moment.");
}

export interface PlaceOrder {
  progress: SendProgress | null;
  error: string | null;
  /** Resolves with the browser's record of the order, or null when it was not placed. */
  place(market: ApiMarket, draft: TicketDraft, orderTtlSecs: number): Promise<LocalOrder | null>;
  clearError(): void;
}

/**
 * Places an order. The first order for a contract has the relayer create its market on Solana;
 * then one transaction: for a buy, the outcome token account if it is missing and `place_buy`;
 * for a sale, the test-dollar account if it is missing and `place_sell`.
 */
export function usePlaceOrder(): PlaceOrder {
  const config = useConfig();
  const account = useAccount();
  const send = useSendTransaction();
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallet = account.wallet?.address ?? null;
  const { refresh, getAccessToken } = account;

  const place = useCallback<PlaceOrder["place"]>(
    async (market, draft, orderTtlSecs) => {
      if (!wallet || !config.stableMint) return null;
      setError(null);
      setProgress(market.onchain ? "wallet" : "market");
      try {
        // The nonce decides the order's address, so it is read at click time.
        const trader = await getReads(config).fetchTrader(wallet);
        if (!trader) throw new Error("This wallet is not registered yet. Get test funds first.");
        const onchain = market.onchain ?? (await createMarket(market.symbol, await getAccessToken()));
        setProgress("wallet");
        const common = {
          programId: config.programId,
          user: wallet,
          stableMint: config.stableMint,
          market: onchain.market,
          outcomeMint: draft.side === "YES" ? onchain.yesMint : onchain.noMint,
          side: draft.side,
          units: draft.units,
          maxFeeMicros: draft.maxFeeMicros,
          nonce: trader.nextNonce,
        };
        const { order, instructions } = draft.action === "sell" ? await buildPlaceSell({ ...common, minPx: draft.limitPx }) : await buildPlaceBuy({ ...common, limitPx: draft.limitPx });
        const signature = await send({ instructions, computeUnitLimit: PLACE_ORDER_COMPUTE_UNITS, onStage: (stage) => setProgress(progressOf(stage)) });
        refresh();
        return {
          address: order,
          signature,
          symbol: market.symbol,
          kind: draft.action,
          side: draft.side,
          units: draft.units.toString(),
          limitPx: draft.limitPx.toString(),
          maxFeeMicros: draft.maxFeeMicros.toString(),
          placedAt: Date.now(),
          expiresAt: Math.min(Math.floor(clock.chainNowMs() / 1000) + orderTtlSecs, onchain.closeTs),
        };
      } catch (caught) {
        setError(describeSendError(caught));
        return null;
      } finally {
        setProgress(null);
      }
    },
    [config, getAccessToken, refresh, send, wallet],
  );

  return { progress, error, place, clearError: useCallback(() => setError(null), []) };
}

export interface ReclaimOrder {
  /** The order being reclaimed, if any. */
  address: string | null;
  progress: SendProgress | null;
  error: string | null;
  /** Resolves with the signature of the cancel, or null when it failed. */
  reclaim(order: OpenOrder, outcomeMint?: string): Promise<string | null>;
}

/** Sends `cancel_order` signed by the user, which the program allows once the order has expired. */
export function useReclaimOrder(): ReclaimOrder {
  const config = useConfig();
  const account = useAccount();
  const send = useSendTransaction();
  const [state, setState] = useState<{ address: string | null; progress: SendProgress | null; error: string | null }>({ address: null, progress: null, error: null });
  const wallet = account.wallet?.address ?? null;
  const { refresh } = account;

  const reclaim = useCallback<ReclaimOrder["reclaim"]>(
    async (order, outcomeMint) => {
      if (!wallet || !config.stableMint) return null;
      setState({ address: order.address, progress: "wallet", error: null });
      try {
        const instructions = await buildCancelOrder({ programId: config.programId, caller: wallet, order, stableMint: config.stableMint, outcomeMint });
        const signature = await send({ instructions, onStage: (stage) => setState({ address: order.address, progress: progressOf(stage), error: null }) });
        refresh();
        setState({ address: null, progress: null, error: null });
        return signature;
      } catch (caught) {
        setState({ address: order.address, progress: null, error: describeSendError(caught) });
        return null;
      }
    },
    [config, refresh, send, wallet],
  );

  return { ...state, reclaim };
}
