"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets, type ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import type { Instruction } from "@solana/kit";
import { useCallback, useMemo } from "react";
import { getRpc } from "@/lib/chain/rpc";
import { sendInstructions, type SendStage } from "@/lib/chain/send";
import { useConfig } from "@/lib/config";
import { SIGNING_CHAIN } from "./providers";

export interface TradingWallet {
  address: string;
  /** True for the wallet created at an email login; false for a wallet the user connected. */
  embedded: boolean;
  /** The object to sign with. Null while an external wallet is not connected in this tab. */
  signer: ConnectedStandardSolanaWallet | null;
}

/**
 * The account's one trading wallet: the embedded wallet for an email login, the connected wallet
 * for a wallet login. Null while logged out or while the embedded wallet is still being created.
 */
export function useTradingWallet(): { ready: boolean; wallet: TradingWallet | null } {
  const { ready, authenticated, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();

  const wallet = useMemo<TradingWallet | null>(() => {
    if (!authenticated || !user) return null;
    const linked = user.linkedAccounts.flatMap((account) => (account.type === "wallet" && account.chainType === "solana" ? [account] : []));
    const isEmbedded = (type: string | undefined) => type === "privy" || type === "privy-v2";
    const chosen = linked.find((account) => isEmbedded(account.walletClientType)) ?? linked[0];
    if (!chosen) return null;
    return {
      address: chosen.address,
      embedded: isEmbedded(chosen.walletClientType),
      signer: wallets.find((candidate) => candidate.address === chosen.address) ?? null,
    };
  }, [authenticated, user, wallets]);

  return { ready: ready && walletsReady, wallet };
}

export interface SendRequest {
  instructions: readonly Instruction[];
  computeUnitLimit?: number;
  onStage?(stage: SendStage): void;
}

/** Sends instructions as one transaction signed by the trading wallet. Resolves with the signature. */
export function useSendTransaction(): (request: SendRequest) => Promise<string> {
  const config = useConfig();
  const { wallet } = useTradingWallet();
  const { signTransaction } = useSignTransaction();

  return useCallback(
    async (request) => {
      const signer = wallet?.signer;
      if (!wallet || !signer) throw new Error("Your wallet is not connected in this tab. Log in again to reconnect it.");
      return sendInstructions({
        rpc: getRpc(config.rpcUrl),
        programId: config.programId,
        feePayer: wallet.address,
        instructions: request.instructions,
        computeUnitLimit: request.computeUnitLimit,
        onStage: request.onStage,
        sign: async (unsigned) => (await signTransaction({ transaction: unsigned, wallet: signer, chain: SIGNING_CHAIN })).signedTransaction,
      });
    },
    [config.programId, config.rpcUrl, signTransaction, wallet],
  );
}
