"use client";

import { usePathname } from "next/navigation";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { useConfig } from "@/lib/config";
import { formatDollars, formatSol } from "@/lib/format";
import { useAccount } from "@/lib/privy/account";
import { AccountMenu, type FaucetStatus } from "./AccountMenu";
import { Footer } from "./Footer";
import { TopBar } from "./TopBar";
import styles from "./Shell.module.css";

/** Asks the faucet for a top-up and turns the answer into one plain sentence. */
export function useFaucet(): { status: FaucetStatus; request(): void } {
  const config = useConfig();
  const account = useAccount();
  const [status, setStatus] = useState<FaucetStatus>({ kind: "idle" });
  const { getAccessToken, refresh, wallet } = account;

  const request = useCallback(async () => {
    if (!wallet) return;
    if (config.fixtures) {
      setStatus({ kind: "done", text: "Fixtures mode: balances are simulated, so nothing was sent." });
      return;
    }
    setStatus({ kind: "working" });
    try {
      const token = await getAccessToken();
      const response = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok && body.toppedUp === true) {
        const parts = [
          BigInt(String(body.stableMicros ?? "0")) > 0n ? `${formatDollars(BigInt(String(body.stableMicros)))} in test dollars` : "",
          BigInt(String(body.lamports ?? "0")) > 0n ? `${formatSol(BigInt(String(body.lamports)))} devnet SOL` : "",
        ].filter(Boolean);
        setStatus({ kind: "done", text: `Sent ${parts.join(" and ")}.` });
        refresh();
      } else if (response.ok) {
        setStatus({ kind: "done", text: "Nothing sent. The faucet tops up below 100 test dollars or 0.01 SOL." });
      } else if (response.status === 429) {
        const minutes = Math.max(1, Math.ceil(Number(body.retryAfterSecs ?? 60) / 60));
        setStatus({ kind: "error", text: `One top-up per ten minutes. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.` });
      } else if (response.status === 503) {
        setStatus({ kind: "error", text: "The demo is not set up yet, so there are no test funds to send." });
      } else if (response.status === 409) {
        setStatus({ kind: "error", text: "This wallet is not registered yet. Use Get test funds on the welcome page first." });
      } else if (response.status === 401) {
        setStatus({ kind: "error", text: "Your login has expired. Log in again, then retry." });
      } else {
        setStatus({ kind: "error", text: "The top-up failed and nothing was sent. Try again in a moment." });
      }
    } catch {
      setStatus({ kind: "error", text: "The app server did not answer. Check your connection and retry." });
    }
  }, [config.fixtures, getAccessToken, refresh, wallet]);

  return { status, request: () => void request() };
}

/** The top bar wired to the login state and the wallet's balances. */
function ConnectedTopBar() {
  const pathname = usePathname();
  const config = useConfig();
  const account = useAccount();
  const faucet = useFaucet();
  const loggedIn = account.ready && account.authenticated;

  let right: ReactNode = null;
  if (loggedIn && account.wallet) {
    right = (
      <AccountMenu
        address={account.wallet.address}
        embedded={account.wallet.embedded}
        faucet={faucet.status}
        onGetTestFunds={faucet.request}
        onLogout={() => void account.logout()}
      />
    );
  } else if (account.ready && !account.authenticated) {
    right = (
      <Button size="row" onClick={account.login} data-testid="login-top">
        Log in
      </Button>
    );
  }

  return (
    <TopBar
      pathname={pathname}
      showNav={loggedIn}
      balanceMicros={loggedIn && config.bootstrapped ? (account.balances?.stableMicros ?? null) : undefined}
      account={right}
    />
  );
}

/** The frame of every page: top bar, the page column, footer. The network strip sits above it. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <ConnectedTopBar />
      <main className={styles.main}>{children}</main>
      <Footer />
    </>
  );
}

/** A page title with an optional line under it. */
export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <h1>{title}</h1>
      {children && <p className={styles.lead}>{children}</p>}
    </header>
  );
}
