import { describe, expect, it } from "vitest";
import { failureWords, isLoginWallet, logInWithWallet, sameWallet, type WalletLoginState, type WalletLoginSteps } from "./wallet-login";
import { WalletCancelled } from "./wallet-request";

const ADDRESS = "8rj8sEKjMCkBxMhAKYEz3ZVfGJDqZ6SVSMQBKKmKDK8p";
const SIGNATURE = new Uint8Array(64).fill(7);
/** What Phantom and MetaMask reject with when the user declines. */
const declined = () => Object.assign(new Error("User rejected the request."), { code: 4001 });

/** A login in which every step succeeds, with the steps named in `overrides` replaced. */
async function run(overrides: Partial<WalletLoginSteps> = {}, abandoned: () => boolean = () => false) {
  const states: WalletLoginState[] = [];
  const calls: string[] = [];
  const steps: WalletLoginSteps = {
    connect: async () => ADDRESS,
    message: async (address) => `sign in ${address}`,
    sign: async () => SIGNATURE,
    verify: async () => {},
    ...overrides,
  };
  const recorded = Object.fromEntries(
    Object.entries(steps).map(([name, step]) => [
      name,
      (...inputs: unknown[]) => {
        calls.push(name);
        return (step as (...inputs: unknown[]) => unknown)(...inputs);
      },
    ]),
  ) as unknown as WalletLoginSteps;
  await logInWithWallet("Phantom", recorded, (state) => states.push(state), abandoned);
  return { states, calls, steps: states.map((state) => state.step) };
}

describe("logInWithWallet", () => {
  it("connects, signs the provider's message, has it verified, and is done", async () => {
    const verified: unknown[] = [];
    const { states, calls } = await run({ verify: async (message, signature) => void verified.push(message, signature) });
    expect(states).toEqual([
      { step: "connecting", wallet: "Phantom" },
      { step: "signing", wallet: "Phantom" },
      { step: "verifying", wallet: "Phantom" },
      { step: "done" },
    ]);
    expect(calls).toEqual(["connect", "message", "sign", "verify"]);
    expect(verified).toEqual([`sign in ${ADDRESS}`, SIGNATURE]);
  });

  it("fails with the connection declined, and asks for nothing more", async () => {
    const { states, calls } = await run({ connect: () => Promise.reject(declined()) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "connection_declined" });
    expect(calls).toEqual(["connect"]);
  });

  it("fails with a wallet error when connecting breaks for another reason", async () => {
    const { states } = await run({ connect: () => Promise.reject(new Error("Unexpected error")) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "wallet_error" });
  });

  it("says so when the wallet still holds an earlier request and refuses a new one", async () => {
    // MetaMask, asked to connect again while its first request is unanswered.
    const busy = new Error("Request of type 'wallet_requestPermissions' already pending for origin http://localhost:3200. Please wait.");
    const { states } = await run({ connect: () => Promise.reject(busy) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "wallet_busy" });
  });

  it("fails plainly when the wallet has no Solana account", async () => {
    const { states, calls } = await run({ connect: async () => null });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "no_solana_account" });
    expect(calls).toEqual(["connect"]);
  });

  it("fails with a network error when the sign-in message cannot be fetched", async () => {
    const { states, calls } = await run({ message: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "network_error" });
    expect(calls).toEqual(["connect", "message"]);
  });

  it("fails with the signature declined, and verifies nothing", async () => {
    const { states, calls } = await run({ sign: () => Promise.reject(declined()) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "signature_declined" });
    expect(calls).toEqual(["connect", "message", "sign"]);
  });

  it("fails with a wallet error when signing breaks for another reason", async () => {
    const { states } = await run({ sign: () => Promise.reject(new Error("invalid account")) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "wallet_error" });
  });

  it("fails with a network error when the signature cannot be verified", async () => {
    const { states } = await run({ verify: () => Promise.reject(new Error("HTTP 500")) });
    expect(states.at(-1)).toEqual({ step: "failed", wallet: "Phantom", reason: "network_error" });
  });

  it("goes back to the list when the user cancels while connecting", async () => {
    const { steps, calls } = await run({ connect: () => Promise.reject(new WalletCancelled()) });
    expect(steps).toEqual(["connecting", "choose"]);
    expect(calls).toEqual(["connect"]);
  });

  it("goes back to the list when the user cancels while signing", async () => {
    const { steps, calls } = await run({ sign: () => Promise.reject(new WalletCancelled()) });
    expect(steps).toEqual(["connecting", "signing", "choose"]);
    expect(calls).toEqual(["connect", "message", "sign"]);
  });

  it("stops without a word once the login was abandoned: no signature is asked for", async () => {
    let left = false;
    const { steps, calls } = await run({ message: async () => ((left = true), "message") }, () => left);
    expect(calls).toEqual(["connect", "message"]);
    expect(steps).toEqual(["connecting"]);
  });

  it("does not log in with a signature that arrives after the login was abandoned", async () => {
    let left = false;
    const { steps, calls } = await run({ sign: async () => ((left = true), SIGNATURE) }, () => left);
    expect(calls).toEqual(["connect", "message", "sign"]);
    expect(steps).toEqual(["connecting", "signing"]);
  });
});

describe("failureWords", () => {
  it("says who declined and what", () => {
    expect(failureWords("connection_declined", "Phantom")).toBe("You declined the connection in Phantom.");
    expect(failureWords("signature_declined", "MetaMask")).toBe("You declined the signature in MetaMask.");
  });
  it("says what to do about a wallet with no Solana account", () => {
    expect(failureWords("no_solana_account", "MetaMask")).toBe("This wallet has no Solana account. Add one in the wallet, or log in with email.");
  });
  it("says where to answer the request a busy wallet still shows", () => {
    expect(failureWords("wallet_busy", "MetaMask")).toBe("MetaMask is still showing an earlier request. Click the MetaMask icon in the browser toolbar, answer or cancel it there, then try again.");
  });
  it("tells a wallet problem from a network problem", () => {
    expect(failureWords("wallet_error", "Phantom")).toBe("Phantom could not complete the request. Try again, or log in with email.");
    expect(failureWords("network_error", "Phantom")).toBe("The login service did not answer. Check your connection, then try again.");
  });
});

describe("isLoginWallet", () => {
  const features = { "standard:connect": {}, "solana:signMessage": {}, "solana:signTransaction": {} };
  it("takes a wallet extension that can connect and sign for Solana", () => {
    expect(isLoginWallet({ name: "Phantom", chains: ["solana:mainnet", "solana:devnet"], features })).toBe(true);
  });
  it("leaves out a wallet registered for another chain under the same name", () => {
    expect(isLoginWallet({ name: "MetaMask", chains: ["bitcoin:mainnet"], features: { "bitcoin:connect": {} } })).toBe(false);
  });
  it("leaves out a wallet that cannot sign a message or a transaction", () => {
    expect(isLoginWallet({ name: "Watcher", chains: ["solana:mainnet"], features: { "standard:connect": {} } })).toBe(false);
  });
  it("leaves out the login provider's own wallet and its WalletConnect entry", () => {
    expect(isLoginWallet({ name: "Privy", chains: ["solana:mainnet"], features: { ...features, "privy:": {} } })).toBe(false);
    expect(isLoginWallet({ name: "WalletConnect", chains: ["solana:mainnet"], features, isWalletConnectSolana: true })).toBe(false);
  });
});

describe("sameWallet", () => {
  it("matches a wallet's name with the form the login provider stores", () => {
    expect(sameWallet("Phantom", "phantom")).toBe(true);
    expect(sameWallet("OKX Wallet", "okx_wallet")).toBe(true);
    expect(sameWallet("Phantom", "MetaMask")).toBe(false);
  });
});
