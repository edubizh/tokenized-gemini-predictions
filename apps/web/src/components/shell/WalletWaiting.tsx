"use client";

import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { useAccount } from "@/lib/privy/account";
import { useWalletDesk } from "@/lib/privy/wallet-desk";
import { waitingWords } from "@/lib/privy/wallet-request";
import styles from "./WalletWaiting.module.css";

/**
 * Shown while a wallet is being waited for, at login and for every signature: which wallet, where
 * it asks, Cancel at all times, Try again once the wallet is slow to answer, and Reload page once
 * it has gone silent. `pinned` is the copy the shell keeps in view above the page; it steps aside
 * while the login dialog shows its own.
 */
export function WalletWaiting({ pinned = false }: { pinned?: boolean }) {
  const { wait, retry, cancel } = useWalletDesk();
  const { loginOpen } = useAccount();
  if (!wait || (pinned && loginOpen)) return null;
  const { title, body } = waitingWords(wait);

  return (
    <div className={pinned ? styles.pinned : undefined} data-testid="wallet-waiting" data-wallet={wait.wallet} data-slow={wait.slow || undefined} data-silent={wait.silent || undefined}>
      <Notice
        tone={wait.slow ? "caution" : "neutral"}
        title={title}
        action={
          <span className={styles.actions}>
            {wait.silent ? (
              <Button size="row" variant="primary" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            ) : (
              wait.slow && (
                <Button size="row" variant="primary" onClick={retry}>
                  Try again
                </Button>
              )
            )}
            <Button size="row" onClick={cancel}>
              Cancel
            </Button>
          </span>
        }
      >
        {body}
      </Notice>
    </div>
  );
}
