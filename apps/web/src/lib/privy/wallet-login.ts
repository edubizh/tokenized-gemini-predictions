// Logging in with a wallet extension, as a sequence the app owns from the first click to the
// session: connect, sign the login provider's message, have the signature verified. Each step that
// can go wrong ends in a state that says why, so no step waits without a way on.

import { WalletCancelled } from "./wallet-request";

export type LoginFailure = "connection_declined" | "signature_declined" | "no_solana_account" | "wallet_busy" | "wallet_error" | "network_error";

export type WalletLoginState =
  | { step: "choose" }
  | { step: "connecting"; wallet: string }
  | { step: "signing"; wallet: string }
  | { step: "verifying"; wallet: string }
  | { step: "failed"; wallet: string; reason: LoginFailure }
  | { step: "done" };

/** What a login needs from outside. The wallet's two steps go through the wallet desk. */
export interface WalletLoginSteps {
  /** Asks the wallet to connect. Resolves with its Solana address, or null when it has none. */
  connect(): Promise<string | null>;
  /** Fetches the message to sign for that address from the login provider. */
  message(address: string): Promise<string>;
  /** Asks the wallet to sign the message with that address. */
  sign(address: string, message: string): Promise<Uint8Array>;
  /** Has the login provider check the signature and start the session. */
  verify(message: string, signature: Uint8Array): Promise<void>;
}

/**
 * Why a wallet did not answer a request with what was asked. Wallets reject a request the user
 * declined with code 4001 or words to that effect ("User rejected the request."); MetaMask refuses
 * a new request while an earlier one is unanswered ("... already pending for origin ...").
 */
export function walletFailure(error: unknown, declined: LoginFailure): LoginFailure {
  const { code, message } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const words = typeof message === "string" ? message : String(error);
  if (/already pending/i.test(words)) return "wallet_busy";
  return code === 4001 || /reject|declin|denied/i.test(words) ? declined : "wallet_error";
}

/** How long the login provider has to verify a signature before the login ends in a network error. */
export const VERIFY_TIMEOUT_MS = 20_000;

/** The step's answer, or a rejection once `ms` have passed without one. */
function within<T>(step: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no answer in time")), ms);
  });
  return Promise.race([step, late]).finally(() => clearTimeout(timer));
}

/**
 * Runs one login with the wallet named `wallet`, reporting each state through `show`. Stops
 * without a word once `abandoned()` is true (the user closed the dialog): nothing more is asked of
 * the wallet and no session is started with an answer that arrives late.
 */
export async function logInWithWallet(
  wallet: string,
  steps: WalletLoginSteps,
  show: (state: WalletLoginState) => void,
  abandoned: () => boolean = () => false,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
): Promise<void> {
  const fail = (reason: LoginFailure) => show({ step: "failed", wallet, reason });
  /** Runs one step. Null when the login does not go on, and the state then already says why. */
  const attempt = async <T>(step: () => Promise<T>, reason: (error: unknown) => LoginFailure): Promise<{ answer: T } | null> => {
    try {
      const answer = await step();
      return abandoned() ? null : { answer };
    } catch (error) {
      if (abandoned()) return null;
      if (error instanceof WalletCancelled) show({ step: "choose" });
      else fail(reason(error));
      return null;
    }
  };
  const byWallet = (declined: LoginFailure) => (error: unknown) => walletFailure(error, declined);
  const byNetwork = (): LoginFailure => "network_error";

  show({ step: "connecting", wallet });
  const connected = await attempt(steps.connect, byWallet("connection_declined"));
  if (!connected) return;
  const address = connected.answer;
  if (address === null) return fail("no_solana_account");
  const message = await attempt(() => steps.message(address), byNetwork);
  if (!message) return;

  show({ step: "signing", wallet });
  const signature = await attempt(() => steps.sign(address, message.answer), byWallet("signature_declined"));
  if (!signature) return;

  show({ step: "verifying", wallet });
  if (await attempt(() => within(steps.verify(message.answer, signature.answer), verifyTimeoutMs), byNetwork)) show({ step: "done" });
}

/** One sentence for a failed login: what happened, and what to do next. */
export function failureWords(reason: LoginFailure, wallet: string): string {
  switch (reason) {
    case "connection_declined":
      return `You declined the connection in ${wallet}.`;
    case "signature_declined":
      return `You declined the signature in ${wallet}.`;
    case "no_solana_account":
      return "This wallet has no Solana account. Add one in the wallet, or log in with email.";
    case "wallet_busy":
      return `${wallet} is still showing an earlier request. Click the ${wallet} icon in the browser toolbar, answer or cancel it there, then try again.`;
    case "wallet_error":
      return `${wallet} could not complete the request. Try again, or log in with email.`;
    case "network_error":
      return "The login service did not answer. Check your connection, then try again.";
  }
}

interface ListedWallet {
  name: string;
  chains: readonly string[];
  features: Readonly<Record<string, unknown>>;
  /** Set on the login provider's WalletConnect entry. */
  isWalletConnectSolana?: boolean;
}

/**
 * True for a wallet extension that can log in here: it connects and signs for Solana. The login
 * provider lists two entries of its own beside the extensions (its embedded wallet and
 * WalletConnect), and a wallet may register a second time under the same name for another chain.
 */
export function isLoginWallet(wallet: ListedWallet): boolean {
  const { features } = wallet;
  return (
    wallet.chains.some((chain) => chain.startsWith("solana:")) &&
    "standard:connect" in features &&
    "solana:signMessage" in features &&
    "solana:signTransaction" in features &&
    !("privy:" in features) &&
    !wallet.isWalletConnectSolana
  );
}

/** "Phantom" and "phantom", "OKX Wallet" and "okx_wallet": the login provider stores a wallet's name in either form. */
export function sameWallet(a: string, b: string): boolean {
  const plain = (name: string) => name.toLowerCase().replace(/[\s_]+/g, " ");
  return plain(a) === plain(b);
}
