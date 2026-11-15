import { describe, expect, it } from "vitest";
import { TransactionError } from "@/lib/chain/errors";
import { sentWithoutAnswer } from "./actions";

describe("after a failed send", () => {
  it("treats a transaction the network took but whose outcome is unknown as sent, not as 'not placed'", () => {
    expect(sentWithoutAnswer(new TransactionError("unknown", "not known yet", { signature: "sig" }))).toBe(true);
  });

  it("reports as not placed only what was never sent, or is known to have failed or expired", () => {
    expect(sentWithoutAnswer(new TransactionError("simulate", "refused"))).toBe(false);
    expect(sentWithoutAnswer(new TransactionError("sign", "The wallet did not sign. Nothing was sent."))).toBe(false);
    expect(sentWithoutAnswer(new TransactionError("send", "The network did not accept the transaction", { signature: "sig" }))).toBe(false);
    expect(sentWithoutAnswer(new TransactionError("confirm", "failed", { signature: "sig" }))).toBe(false);
    expect(sentWithoutAnswer(new TransactionError("expired", "expired", { signature: "sig" }))).toBe(false);
    expect(sentWithoutAnswer(new Error("HTTP error (429):"))).toBe(false);
  });
});
