import { describe, expect, it } from "vitest";
import { needsReconnect, otherAccountMessage } from "./reconnect";

const TRADING = "8rj8sEKjMCkBxMhAKYEz3ZVfGJDqZ6SVSMQBKKmKDK8p";
const OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const signer = {};

describe("needsReconnect", () => {
  it("is true for a wallet login whose wallet is not connected in this tab", () => {
    expect(needsReconnect({ ready: true, wallet: { address: TRADING, embedded: false, signer: null } })).toBe(true);
  });
  it("is false once that wallet is connected", () => {
    expect(needsReconnect({ ready: true, wallet: { address: TRADING, embedded: false, signer } })).toBe(false);
  });
  it("is false for an embedded wallet, which is never connected by hand", () => {
    expect(needsReconnect({ ready: true, wallet: { address: TRADING, embedded: true, signer: null } })).toBe(false);
  });
  it("is false while the wallets are still loading, and when logged out", () => {
    expect(needsReconnect({ ready: false, wallet: { address: TRADING, embedded: false, signer: null } })).toBe(false);
    expect(needsReconnect({ ready: true, wallet: null })).toBe(false);
  });
});

describe("otherAccountMessage", () => {
  it("says which account to switch back to when the wallet is on another one", () => {
    expect(otherAccountMessage(TRADING, [OTHER])).toBe(
      "Your wallet is on another account, 4Nd1…DB4T. Switch back to 8rj8…DK8p in the wallet, or log out and log in with the new account.",
    );
  });
  it("has nothing to say while the trading account is connected", () => {
    expect(otherAccountMessage(TRADING, [OTHER, TRADING])).toBeNull();
  });
  it("has nothing to say when the wallet is not connected at all", () => {
    expect(otherAccountMessage(TRADING, [])).toBeNull();
  });
});
