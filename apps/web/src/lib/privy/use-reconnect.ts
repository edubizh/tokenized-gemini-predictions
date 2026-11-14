"use client";

import { useConnectWallet } from "@privy-io/react-auth";
import { useMemo, useState } from "react";
import { shortAddress } from "@/lib/format";
import { needsReconnect, wrongWalletMessage, type ReconnectView } from "./reconnect";
import { useTradingWallet } from "./wallet";

/** The login provider's code for a dialog the user closed themselves, which is not a problem to report. */
const USER_CLOSED = /^exited_|^user_exited_/;

/**
 * Null while the trading wallet can sign. For a wallet login whose wallet is not connected in
 * this tab (as after a page reload), the way to reconnect it: the login provider's wallet dialog.
 * The view shows Reconnect wallet in place of its action until the wallet with the trading
 * address is connected; connecting any other wallet leaves a message naming the expected one.
 */
export function useReconnect(): ReconnectView | null {
  const { ready, wallet } = useTradingWallet();
  const [problem, setProblem] = useState<string | null>(null);
  const expected = wallet?.address ?? null;
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet: connected }) => setProblem(expected === null ? null : wrongWalletMessage(expected, connected.address)),
    onError: (code) => setProblem(USER_CLOSED.test(String(code)) ? null : "The wallet did not connect. Try again."),
  });
  const needed = needsReconnect({ ready, wallet });

  return useMemo(() => {
    if (!needed || expected === null) return null;
    return {
      problem,
      onReconnect: () => {
        setProblem(null);
        connectWallet({ walletChainType: "solana-only", description: `Connect the wallet this account trades with, ${shortAddress(expected)}.` });
      },
    };
  }, [connectWallet, expected, needed, problem]);
}
