"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ExternalLink } from "@/components/ui/ExternalLink";
import { Notice } from "@/components/ui/Notice";
import { explorerTxUrl, useConfig, type PublicConfig } from "@/lib/config";
import { useAccount, type Account } from "@/lib/privy/account";
import { onboardOutcome, type OnboardOutcome } from "./onboarding";

/** True for a logged-in wallet that cannot trade yet: it has no Trader account, or nothing is deployed to trade on. */
export function needsTestFunds(config: Pick<PublicConfig, "bootstrapped">, account: Pick<Account, "authenticated" | "trader">): boolean {
  return account.authenticated && (!config.bootstrapped || account.trader === "missing");
}

type State = { kind: "idle" } | { kind: "working" } | Exclude<OnboardOutcome, { kind: "already" }>;

/**
 * The first run, in place: one step that registers the wallet as a trader and sends it starter
 * test dollars and devnet SOL, in a transaction the demo signs and pays for. Put it where such a
 * wallet would trade. It draws nothing for a wallet that is set up, except what it has just done.
 */
export function GetTestFunds() {
  const config = useConfig();
  const account = useAccount();
  const [state, setState] = useState<State>({ kind: "idle" });
  const { wallet, getAccessToken, refresh } = account;

  const start = useCallback(async () => {
    if (!wallet) return;
    setState({ kind: "working" });
    try {
      const token = await getAccessToken();
      const response = await fetch("/api/onboard", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token ?? ""}` },
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const outcome = onboardOutcome(response.status, (await response.json().catch(() => ({}))) as Record<string, unknown>);
      // Registered either way: the account is read again, and with it this block steps aside.
      if (outcome.kind === "funded" || outcome.kind === "already") refresh();
      setState(outcome.kind === "already" ? { kind: "idle" } : outcome);
    } catch {
      setState({ kind: "error", message: "The app server did not answer. Check your connection, then try again." });
    }
  }, [getAccessToken, refresh, wallet]);

  if (state.kind === "funded") {
    return (
      <Notice tone="positive" title="Test funds sent">
        Your wallet is registered, and test dollars and a little devnet SOL for fees have arrived. <ExternalLink href={explorerTxUrl(config, state.signature)}>View transaction</ExternalLink>
      </Notice>
    );
  }
  if (!needsTestFunds(config, account)) return null;
  if (!config.bootstrapped || state.kind === "not_deployed") {
    return <Notice title="Not set up yet">The program and its test dollars have not been deployed to devnet for this demo yet, so there are no test funds to send.</Notice>;
  }
  if (state.kind === "error") {
    return (
      <Notice tone="negative" title="Test funds were not sent" action={<Button size="row" onClick={() => void start()}>Try again</Button>}>
        {state.message}
      </Notice>
    );
  }
  const working = state.kind === "working";
  return (
    <Notice
      title="Get test funds"
      busy={working}
      action={
        <Button variant="primary" size="row" onClick={() => void start()} busy={working ? "Sending" : false} data-testid="get-test-funds">
          Get test funds
        </Button>
      }
    >
      To trade, this wallet needs to be registered and to hold test dollars and a little devnet SOL for fees. One transaction does all of it, and you sign nothing.
    </Notice>
  );
}
