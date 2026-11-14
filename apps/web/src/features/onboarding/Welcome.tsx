"use client";

import { useCallback, useState } from "react";
import { explorerTxUrl, useConfig } from "@/lib/config";
import { formatLocalTime } from "@/lib/format";
import { useAccount } from "@/lib/privy/account";
import { WelcomeView, type WelcomeState } from "./WelcomeView";

const MESSAGES: Record<string, string> = {
  unauthorized: "Your login has expired. Log out, log in again, then retry.",
  wallet_not_linked: "This wallet is not linked to your login. Log in with the wallet you want to trade with.",
  bad_request: "The request was not understood. Reload the page and retry.",
};

type Local = { kind: "idle" } | Extract<WelcomeState, { kind: "working" | "done" | "error" | "already" | "not_bootstrapped" }>;

/** The first-run screen: registers the wallet as a trader and sends starter funds. */
export function Welcome() {
  const config = useConfig();
  const account = useAccount();
  const [local, setLocal] = useState<Local>({ kind: "idle" });
  const { wallet, getAccessToken, refresh } = account;

  const start = useCallback(async () => {
    if (!wallet) return;
    setLocal({ kind: "working", step: "login" });
    try {
      const token = await getAccessToken();
      if (!token) {
        setLocal({ kind: "error", message: MESSAGES.unauthorized as string });
        return;
      }
      setLocal({ kind: "working", step: "funding" });
      const response = await fetch("/api/onboard", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ wallet: wallet.address }),
      });
      const body = (await response.json().catch(() => ({}))) as { registered?: boolean; signature?: string; error?: string; detail?: string };
      if (response.ok && body.registered && body.signature) {
        setLocal({ kind: "done", signature: body.signature, at: formatLocalTime(Date.now(), { seconds: true }) });
        refresh();
      } else if (response.ok) {
        setLocal({ kind: "already" });
        refresh();
      } else if (response.status === 503) {
        setLocal({ kind: "not_bootstrapped" });
      } else if (body.error === "transaction_failed") {
        setLocal({ kind: "error", message: `The transaction failed and nothing was sent. ${body.detail ?? ""} You can try again.`.replace("  ", " ") });
      } else {
        setLocal({ kind: "error", message: MESSAGES[body.error ?? ""] ?? "The server could not complete the request. Nothing was sent; you can try again." });
      }
    } catch {
      setLocal({ kind: "error", message: "The app server did not answer. Check your connection, then try again." });
    }
  }, [getAccessToken, refresh, wallet]);

  let state: WelcomeState;
  if (!config.bootstrapped) state = { kind: "not_bootstrapped" };
  else if (local.kind !== "idle") state = local;
  else if (!wallet || account.trader === "unknown") state = { kind: "loading" };
  else if (account.trader === "registered") state = { kind: "already" };
  else state = { kind: "ready" };

  return (
    <WelcomeView
      state={state}
      wallet={wallet}
      balances={account.balances}
      txUrl={(signature) => explorerTxUrl(config, signature)}
      onStart={() => void start()}
    />
  );
}
