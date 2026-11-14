import { describe, expect, it } from "vitest";
import { needsReconnect, wrongWalletMessage } from "./reconnect";

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

describe("wrongWalletMessage", () => {
  it("names the wallet this account trades with when a different one was connected", () => {
    expect(wrongWalletMessage(TRADING, OTHER)).toBe("That was a different wallet, 4Nd1…DB4T. This account trades with 8rj8…DK8p. Switch to it in your wallet, then reconnect.");
  });
  it("has nothing to say about the right wallet", () => {
    expect(wrongWalletMessage(TRADING, TRADING)).toBeNull();
  });
});
