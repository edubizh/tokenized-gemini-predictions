"use client";

import { PrivyProvider, type PrivyClientConfig } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { useMemo, type ReactNode } from "react";
import { ConfigContext, type PublicConfig } from "@/lib/config";
import { AccountProvider } from "./account";

/** The login provider is always given the devnet chain id; the wallet only signs. */
export const SIGNING_CHAIN = "solana:devnet" as const;

// Auto-connect stays off: tried with it on, a wallet that was connected before a page reload did
// not come back by itself, so the app offers Reconnect wallet wherever a signature is needed.
const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: false });

function subscriptionsUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // A local validator serves subscriptions on the port after its RPC port.
  if (url.port && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) url.port = String(Number(url.port) + 1);
  return url.toString();
}

export function Providers({ config, children }: { config: PublicConfig; children: ReactNode }) {
  const privyConfig = useMemo<PrivyClientConfig>(
    () => ({
      loginMethods: ["email", "wallet"],
      appearance: {
        theme: "light",
        walletChainType: "solana-only",
        walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets", "wallet_connect_qr_solana"],
      },
      embeddedWallets: {
        solana: { createOnLogin: "users-without-wallets" },
        showWalletUIs: false,
      },
      externalWallets: { solana: { connectors: solanaConnectors } },
      solana: {
        rpcs: {
          [SIGNING_CHAIN]: {
            rpc: createSolanaRpc(config.rpcUrl),
            rpcSubscriptions: createSolanaRpcSubscriptions(subscriptionsUrl(config.rpcUrl)),
          },
        },
      },
    }),
    [config.rpcUrl],
  );

  return (
    <ConfigContext.Provider value={config}>
      <PrivyProvider appId={config.privyAppId} config={privyConfig}>
        <AccountProvider>{children}</AccountProvider>
      </PrivyProvider>
    </ConfigContext.Provider>
  );
}
