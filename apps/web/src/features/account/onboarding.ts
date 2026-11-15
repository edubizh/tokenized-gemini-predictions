// What the answer of `/api/onboard` means for the person who asked for test funds. Pure.

export type OnboardOutcome =
  /** The wallet was registered and funded now, by this transaction. */
  | { kind: "funded"; signature: string }
  /** The wallet was a registered trader already; starter funds are sent once. */
  | { kind: "already" }
  /** Nothing is deployed yet, so there are no funds to send. */
  | { kind: "not_deployed" }
  | { kind: "error"; message: string };

const MESSAGES: Record<string, string> = {
  unauthorized: "Your login has expired. Log out, log in again, then retry.",
  wallet_not_linked: "This wallet is not linked to your login. Log in with the wallet you want to trade with.",
  bad_request: "The request was not understood. Reload the page and retry.",
};

export function onboardOutcome(status: number, body: { registered?: unknown; signature?: unknown; error?: unknown; detail?: unknown }): OnboardOutcome {
  if (status >= 200 && status < 300) return body.registered === true && typeof body.signature === "string" ? { kind: "funded", signature: body.signature } : { kind: "already" };
  if (status === 503) return { kind: "not_deployed" };
  if (body.error === "transaction_failed") {
    return { kind: "error", message: `The transaction failed and nothing was sent. ${typeof body.detail === "string" ? `${body.detail} ` : ""}You can try again.` };
  }
  const known = typeof body.error === "string" ? MESSAGES[body.error] : undefined;
  return { kind: "error", message: known ?? "The server could not complete the request. Nothing was sent; you can try again." };
}
