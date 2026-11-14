import type { ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/Button";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Skeleton } from "@/components/ui/Skeleton";
import { Timeline, type TimelineStep } from "@/components/ui/Timeline";
import { formatDollars, formatSol, shortAddress } from "@/lib/format";
import styles from "./WelcomeView.module.css";

/** Starter funds, as sent by the onboarding transaction: 1,000 test dollars and 0.05 SOL. */
export const STARTER_STABLE_MICROS = 1_000_000_000n;
export const STARTER_LAMPORTS = 50_000_000n;

export type WelcomeState =
  /** Waiting for the wallet or for the first read of the account. */
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "working"; step: "login" | "funding" }
  | { kind: "done"; signature: string; at: string }
  | { kind: "already" }
  | { kind: "not_bootstrapped" }
  | { kind: "error"; message: string };

export interface WelcomeViewProps {
  state: WelcomeState;
  wallet: { address: string; embedded: boolean } | null;
  /** Current balances, shown once the wallet is set up. */
  balances?: { stableMicros: bigint; lamports: bigint } | null;
  /** Explorer URL of a transaction signature. */
  txUrl(signature: string): string;
  onStart(): void;
}

function steps(state: WelcomeState, txUrl: (signature: string) => string): TimelineStep[] {
  const login = state.kind === "working" && state.step === "login" ? "current" : state.kind === "ready" || state.kind === "error" ? "pending" : "done";
  const funding = state.kind === "done" ? "done" : state.kind === "working" && state.step === "funding" ? "current" : "pending";
  return [
    {
      id: "login",
      status: login,
      title: "Check your login",
      description: "The server verifies your login and that this wallet belongs to it.",
    },
    {
      id: "funding",
      status: funding,
      title: "Register your wallet and send test funds",
      description:
        state.kind === "done"
          ? "Your wallet is registered as a trader, and the starter funds have arrived."
          : "One Solana transaction, signed and paid for by the demo. You sign nothing.",
      time: state.kind === "done" ? state.at : undefined,
      link:
        state.kind === "done" ? (
          <ExternalLink href={txUrl(state.signature)} mono>
            {shortAddress(state.signature)}
          </ExternalLink>
        ) : undefined,
    },
  ];
}

export function WelcomeView({ state, wallet, balances, txUrl, onStart }: WelcomeViewProps) {
  const settled = state.kind === "already";
  let action: ReactNode = null;
  if (state.kind === "ready") {
    action = (
      <Button variant="primary" onClick={onStart} data-testid="get-test-funds">
        Get test funds
      </Button>
    );
  } else if (state.kind === "working") {
    action = (
      <Button variant="primary" busy={state.step === "login" ? "Checking login" : "Sending"}>
        Get test funds
      </Button>
    );
  } else if (state.kind === "error") {
    action = (
      <Button variant="primary" onClick={onStart}>
        Try again
      </Button>
    );
  } else if (state.kind === "done" || state.kind === "already") {
    action = (
      <ButtonLink variant="primary" href="/markets">
        Go to markets
      </ButtonLink>
    );
  }

  return (
    <div className={styles.welcome} data-state={state.kind} data-testid="welcome">
      <div className={styles.main}>
        <h1>{settled ? "Your wallet is set up" : state.kind === "done" ? "Test funds sent" : "Get test funds"}</h1>

        {state.kind === "loading" ? (
          <div className={styles.loading} aria-busy="true">
            <span className="sr-only">Loading your account</span>
            <Skeleton width="34rem" height="1.25rem" />
            <Skeleton width="28rem" height="1.25rem" />
            <Skeleton width="9.5rem" height="40px" />
          </div>
        ) : (
          <>
            <p className={styles.lead}>
              {settled
                ? "This wallet is already registered as a trader. Starter funds are sent once per wallet; if you run low, use Get test funds in the account menu."
                : "To place an order your wallet needs to be registered as a trader, and it needs test dollars to trade with and a little devnet SOL for network fees. One transaction does all of it, once per wallet."}
            </p>

            {state.kind === "not_bootstrapped" && (
              <Notice tone="caution" title="Not set up yet" action={<ButtonLink href="/system" size="row">How it works</ButtonLink>}>
                The program and its test dollars have not been deployed to devnet for this demo yet, so there is nothing to send. Your login is fine; come back once the deployment is done.
              </Notice>
            )}

            {state.kind === "error" && (
              <Notice tone="negative" title="Test funds were not sent">
                {state.message}
              </Notice>
            )}

            {(state.kind === "ready" || state.kind === "working" || state.kind === "done" || state.kind === "error") && (
              <div className={styles.steps}>
                <Timeline label="Steps" steps={steps(state, txUrl)} />
              </div>
            )}

            {action && <div className={styles.action}>{action}</div>}

            {wallet && !wallet.embedded && state.kind !== "not_bootstrapped" && (
              <p className={styles.hint}>
                Using your own wallet? Switch it to devnet before you trade. In Phantom, turn on Testnet Mode under Settings, Developer Settings.
              </p>
            )}
          </>
        )}
      </div>

      <aside className={styles.aside} aria-label={settled ? "Your balances" : "Starter funds"}>
        {settled ? (
          <Receipt title="Your balances" edge="top" note="Test tokens on Solana devnet. No value.">
            <ReceiptLine label="Test dollars">{balances ? formatDollars(balances.stableMicros) : "…"}</ReceiptLine>
            <ReceiptLine label="Devnet SOL">{balances ? formatSol(balances.lamports) : "…"}</ReceiptLine>
            <ReceiptLine label="Wallet">{wallet ? shortAddress(wallet.address) : "…"}</ReceiptLine>
          </Receipt>
        ) : (
          <Receipt title={state.kind === "done" ? "Received" : "Starter funds"} edge="top" note="Test tokens on Solana devnet. No value.">
            <ReceiptLine label="Test dollars">{formatDollars(STARTER_STABLE_MICROS)}</ReceiptLine>
            <ReceiptLine label="Devnet SOL, for fees">{formatSol(STARTER_LAMPORTS)}</ReceiptLine>
            <ReceiptLine label="Trader registration">{state.kind === "done" ? "done" : "included"}</ReceiptLine>
            <ReceiptLine label="To wallet" total>
              {wallet ? shortAddress(wallet.address) : "…"}
            </ReceiptLine>
          </Receipt>
        )}
      </aside>
    </div>
  );
}
