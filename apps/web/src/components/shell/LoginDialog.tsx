"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { useWalletLogin } from "@/lib/privy/use-wallet-login";
import { failureWords } from "@/lib/privy/wallet-login";
import { loginOnlyWords } from "@/lib/privy/wallet-request";
import { WalletWaiting } from "./WalletWaiting";
import styles from "./LoginDialog.module.css";

/**
 * The app's login: an email address, any Solana wallet found in the browser, or WalletConnect.
 * A login with a wallet stays in this dialog from the first click to the session, so every step
 * says what it is waiting for and can be cancelled or tried again.
 */
export function LoginDialog() {
  const login = useWalletLogin();
  const { state } = login;
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open === login.open) return;
    if (login.open) element.showModal();
    else element.close();
  }, [login.open]);

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={login.close} data-testid="login-dialog" data-step={state.step}>
      <header className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          {state.step === "choose" ? "Log in" : `Log in with ${state.step === "done" ? "a wallet" : state.wallet}`}
        </h2>
        <Button variant="quiet" size="row" onClick={login.close}>
          Close
        </Button>
      </header>

      {state.step === "choose" && (
        <div className={styles.ways}>
          <Button block onClick={login.withEmail} data-testid="login-email">
            Email
          </Button>
          {login.wallets.map((wallet) => (
            <Button key={wallet.name} block onClick={() => login.withWallet(wallet.name)} data-testid="login-wallet" data-wallet={wallet.name}>
              <span className={styles.wallet}>
                {/* The wallet's own icon, an inline image it lists itself with. */}
                <img src={wallet.icon} alt="" width={20} height={20} />
                {wallet.name}
              </span>
            </Button>
          ))}
          <Button block onClick={login.withWalletConnect} data-testid="login-walletconnect">
            WalletConnect
          </Button>
          <p className={styles.small}>
            {login.wallets.length === 0 ? "No Solana wallet was found in this browser. " : ""}
            {login.wallets.map((wallet) => loginOnlyWords(wallet.name)).filter(Boolean).join(" ")} No real funds are involved at any point.
          </p>
        </div>
      )}

      {(state.step === "connecting" || state.step === "signing") && <WalletWaiting />}

      {state.step === "verifying" && (
        <p className={styles.small} role="status">
          Checking the signature.
        </p>
      )}

      {state.step === "failed" && (
        <Notice
          tone="negative"
          title="Not logged in"
          action={
            <span className={styles.actions}>
              <Button size="row" onClick={login.retry}>
                Try again
              </Button>
              <Button size="row" variant="quiet" onClick={login.back}>
                Back
              </Button>
            </span>
          }
        >
          {failureWords(state.reason, state.wallet)}
        </Notice>
      )}
    </dialog>
  );
}
