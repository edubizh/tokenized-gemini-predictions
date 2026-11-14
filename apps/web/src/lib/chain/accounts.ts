import { address, fetchEncodedAccounts, type Address } from "@solana/kit";
import { findAssociatedTokenPda, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMaybeTrader, findTraderPda } from "@outcome/program-client";
import type { AppRpc } from "./rpc";

export interface TraderAccount {
  address: Address;
  /** Nonce the wallet's next order must use. */
  nextNonce: bigint;
}

/** The wallet's Trader account, or null when the wallet has not been registered. */
export async function fetchTrader(rpc: AppRpc, programId: string, wallet: string): Promise<TraderAccount | null> {
  const [pda] = await findTraderPda({ user: address(wallet) }, { programAddress: address(programId) });
  const account = await fetchMaybeTrader(rpc, pda, { commitment: "confirmed" });
  return account.exists ? { address: account.address, nextNonce: account.data.nextNonce } : null;
}

export async function stableAccountAddress(wallet: string, stableMint: string): Promise<Address> {
  const [ata] = await findAssociatedTokenPda({ owner: address(wallet), mint: address(stableMint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return ata;
}

export interface Balances {
  lamports: bigint;
  /** Test dollars (dUSD) in micro-dollars. Zero when the token account does not exist. */
  stableMicros: bigint;
}

/** SOL and test-dollar balances in one `getMultipleAccounts` call. */
export async function fetchBalances(rpc: AppRpc, wallet: string, stableMint: string | null): Promise<Balances> {
  const owner = address(wallet);
  if (stableMint === null) {
    const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
    return { lamports: value, stableMicros: 0n };
  }
  const ata = await stableAccountAddress(wallet, stableMint);
  const [walletAccount, tokenAccount] = await fetchEncodedAccounts(rpc, [owner, ata], { commitment: "confirmed" });
  return {
    lamports: walletAccount?.exists ? walletAccount.lamports : 0n,
    stableMicros: tokenAccount?.exists ? getTokenDecoder().decode(tokenAccount.data).amount : 0n,
  };
}
