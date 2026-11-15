"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createWalletDesk, type WalletDesk, type WalletWait } from "./wallet-request";

interface Desk extends WalletDesk {
  /** The wallet being waited for right now, to be shown with Cancel and Try again; null when none is. */
  wait: WalletWait | null;
}

const DeskContext = createContext<Desk | null>(null);

/** One wallet desk for the whole app: every connect and every signature is asked through it. */
export function WalletDeskProvider({ children }: { children: ReactNode }) {
  const [wait, setWait] = useState<WalletWait | null>(null);
  const desk = useMemo(() => createWalletDesk(setWait), []);
  const value = useMemo(() => ({ ...desk, wait }), [desk, wait]);
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

/** `ask`, `retry` and `cancel` keep their identity; `wait` changes as a wallet is asked and answers. */
export function useWalletDesk(): Desk {
  const desk = useContext(DeskContext);
  if (!desk) throw new Error("useWalletDesk must be used inside the app providers");
  return desk;
}
