"use client";

import { useStandardWallets } from "@privy-io/react-auth/solana";
import { useMemo, useState } from "react";
import { otherAccountMessage, needsReconnect, type ReconnectView } from "./reconnect";
import { useTradingWallet } from "./wallet";
import { useWalletDesk } from "./wallet-desk";
import { failureWords, isLoginWallet, sameWallet, walletFailure } from "./wallet-login";
import { WalletCancelled } from "./wallet-request";

/**
 * Null while the trading wallet can sign. For a wallet login whose wallet is not connected in
 * this tab (as after a page reload), the way to reconnect it: the wallet the user logged in with
 * is asked to connect again. The view shows Reconnect wallet in place of its action until the
 * trading address is connected; while the wallet is on another account, the words say which one
 * to switch back to.
 */
export function useReconnect(): ReconnectView | null {
  const { ready, wallet } = useTradingWallet();
  const { wallets } = useStandardWallets();
  const { ask } = useWalletDesk();
  const [problem, setProblem] = useState<string | null>(null);
  const needed = needsReconnect({ ready, wallet });
  const client = wallet?.client ?? null;
  const extension = useMemo(() => wallets.find((candidate) => isLoginWallet(candidate) && client !== null && sameWallet(candidate.name, client)) ?? null, [wallets, client]);
  const otherAccount = wallet ? otherAccountMessage(wallet.address, wallet.connected) : null;

  return useMemo(() => {
    if (!needed) return null;
    return {
      problem: otherAccount ?? problem,
      onReconnect: () => {
        const connect = extension?.features["standard:connect"]?.connect;
        if (!extension || !connect) {
          setProblem("The wallet you logged in with was not found in this browser. Log out, then log in with a wallet that is installed here.");
          return;
        }
        setProblem(null);
        ask(extension.name, "connect", () => connect()).catch((error: unknown) => {
          if (error instanceof WalletCancelled) return;
          const reason = walletFailure(error, "connection_declined");
          setProblem(reason === "wallet_error" ? `${extension.name} did not connect. Try again.` : failureWords(reason, extension.name));
        });
      },
    };
  }, [ask, extension, needed, otherAccount, problem]);
}
