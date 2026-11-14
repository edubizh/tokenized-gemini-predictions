// A wallet login outlives a page reload, but the connection to the wallet itself does not: the
// account is still logged in while nothing in the tab can sign. Pure helpers for that state.

import { shortAddress } from "@/lib/format";

/** What a view needs to offer reconnecting in place of an action that needs a signature. */
export interface ReconnectView {
  onReconnect(): void;
  /** Why the last attempt did not reconnect the trading wallet, in plain words. */
  problem: string | null;
}

/** Shown beside a Reconnect wallet button. */
export const RECONNECT_WORDS = "Your wallet is not connected in this tab. Reconnect it to sign.";

interface WalletState {
  ready: boolean;
  wallet: { address: string; embedded: boolean; signer: unknown } | null;
}

/**
 * True when the account trades with a wallet the user connected themselves and that wallet is not
 * connected in this tab. An embedded wallet is restored by the login provider, never by hand.
 */
export function needsReconnect({ ready, wallet }: WalletState): boolean {
  return ready && wallet !== null && !wallet.embedded && wallet.signer === null;
}

/** What to say after a wallet other than the trading wallet was connected; null for the right one. */
export function wrongWalletMessage(expected: string, connected: string): string | null {
  if (expected === connected) return null;
  return `That was a different wallet, ${shortAddress(connected)}. This account trades with ${shortAddress(expected)}. Switch to it in your wallet, then reconnect.`;
}
