"use client";

import { usePrivy } from "@privy-io/react-auth";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getReads, type Balances } from "@/lib/chain/reads";
import { useConfig } from "@/lib/config";
import { usePolling } from "@/lib/polling";
import { useTradingWallet, type TradingWallet } from "./wallet";

/** Balances change only when an order of the wallet finishes or a redemption lands, and both ask for a read at once. */
const BALANCE_INTERVAL_MS = 10_000;

export type TraderStatus = "unknown" | "missing" | "registered";

export interface Account {
  /** False until the login state is known. */
  ready: boolean;
  authenticated: boolean;
  wallet: TradingWallet | null;
  /** Whether the wallet has a Trader account on-chain. "unknown" until the first read. */
  trader: TraderStatus;
  /** Null until the first read, and while the deployment does not exist. */
  balances: Balances | null;
  /** True when the last balance read failed; the previous value is kept. */
  stale: boolean;
  refresh(): void;
  /** Opens the login dialog. */
  login(): void;
  /** True while the login dialog is asked for. */
  loginOpen: boolean;
  closeLogin(): void;
  logout(): Promise<void>;
  getAccessToken(): Promise<string | null>;
}

const AccountContext = createContext<Account | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const { ready, authenticated, logout, getAccessToken } = usePrivy();
  const [loginOpen, setLoginOpen] = useState(false);
  const login = useCallback(() => setLoginOpen(true), []);
  const closeLogin = useCallback(() => setLoginOpen(false), []);
  const { wallet } = useTradingWallet();
  const address = wallet?.address ?? null;
  const registeredFor = useRef<string | null>(null);

  const active = config.bootstrapped && address !== null;
  const read = useCallback(async () => {
    if (!address) throw new Error("no wallet");
    const reads = getReads(config);
    // A Trader account is never closed, so it is read only until it has been seen once.
    const [registered, balances] = await Promise.all([
      registeredFor.current === address ? true : reads.fetchTrader(address).then((trader) => trader !== null),
      reads.fetchBalances(address),
    ]);
    if (registered) registeredFor.current = address;
    return { address, registered, balances };
  }, [address, config]);
  const polled = usePolling(read, active ? BALANCE_INTERVAL_MS : null);
  const { refresh } = polled;

  // The poll keeps its last value across a change of wallet; ignore it until it is about this one.
  const current = active && polled.data?.address === address ? polled.data : null;
  useEffect(() => {
    if (address) refresh();
  }, [address, refresh]);

  const signOut = useCallback(async () => {
    await logout();
  }, [logout]);

  const account = useMemo<Account>(
    () => ({
      ready,
      authenticated,
      wallet,
      trader: current ? (current.registered ? "registered" : "missing") : "unknown",
      balances: current?.balances ?? null,
      stale: active && polled.error !== null,
      refresh,
      login,
      loginOpen,
      closeLogin,
      logout: signOut,
      getAccessToken,
    }),
    [ready, authenticated, wallet, current, active, polled.error, refresh, login, loginOpen, closeLogin, signOut, getAccessToken],
  );

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
}

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error("useAccount must be used inside the app providers");
  return account;
}
