import { describe, expect, it } from "vitest";
import { onboardOutcome } from "./onboarding";

describe("what the answer to a request for test funds means", () => {
  it("is funded when the wallet was registered now, with the transaction that did it", () => {
    expect(onboardOutcome(200, { registered: true, signature: "5sig" })).toEqual({ kind: "funded", signature: "5sig" });
  });

  it("is nothing new when the wallet was a trader already", () => {
    expect(onboardOutcome(200, { registered: false })).toEqual({ kind: "already" });
    expect(onboardOutcome(200, {})).toEqual({ kind: "already" });
  });

  it("says so when nothing is deployed to send funds from", () => {
    expect(onboardOutcome(503, { error: "not_bootstrapped" })).toEqual({ kind: "not_deployed" });
  });

  it("says what went wrong and that nothing was sent", () => {
    expect(onboardOutcome(401, { error: "unauthorized" })).toEqual({ kind: "error", message: "Your login has expired. Log out, log in again, then retry." });
    expect(onboardOutcome(403, { error: "wallet_not_linked" })).toEqual({ kind: "error", message: "This wallet is not linked to your login. Log in with the wallet you want to trade with." });
    expect(onboardOutcome(400, { error: "bad_request" })).toEqual({ kind: "error", message: "The request was not understood. Reload the page and retry." });
    expect(onboardOutcome(502, { error: "transaction_failed", detail: "Blockhash not found." })).toEqual({ kind: "error", message: "The transaction failed and nothing was sent. Blockhash not found. You can try again." });
    expect(onboardOutcome(502, { error: "transaction_failed" })).toEqual({ kind: "error", message: "The transaction failed and nothing was sent. You can try again." });
    expect(onboardOutcome(500, {})).toEqual({ kind: "error", message: "The server could not complete the request. Nothing was sent; you can try again." });
    expect(onboardOutcome(500, { error: 42 })).toEqual({ kind: "error", message: "The server could not complete the request. Nothing was sent; you can try again." });
  });
});
