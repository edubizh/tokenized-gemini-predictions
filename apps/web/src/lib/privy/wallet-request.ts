// Every request to a wallet extension goes through one desk, because a wallet may never answer.
// Wallets now show a request in their side panel as often as in a window of their own; a panel
// that is closed, or hidden behind another one, leaves the request pending for ever. So the desk
// says which wallet is being waited for, can ask again, and can give up, and it no longer listens
// to a request it has given up on.

/** `sign` is the signature of the login message; `transaction` the signature of a transaction. */
export type WalletAction = "connect" | "sign" | "transaction";

/** What the interface shows while a wallet is being waited for. */
export interface WalletWait {
  /** The wallet's name as it lists itself ("Phantom"). */
  wallet: string;
  action: WalletAction;
  /** True once the wallet has not answered for a while: time to offer Try again. */
  slow: boolean;
  /**
   * True once slow, when the wallet has also left an earlier request of this page unanswered. A
   * wallet whose side panel was closed on a request shows nothing for the next ones either, until
   * the page is reloaded: asking again does not help then.
   */
  silent: boolean;
}

/** What the caller of `ask` gets when the wait was given up. */
export class WalletCancelled extends Error {
  constructor() {
    super("The wallet request was cancelled.");
    this.name = "WalletCancelled";
  }
}

export const SLOW_AFTER_MS = 20_000;

export interface WalletDesk {
  /** Sends the request to the wallet and resolves with its answer. A request still pending is given up. */
  ask<T>(wallet: string, action: WalletAction, request: () => Promise<T>): Promise<T>;
  /** Sends the pending request again and stops listening to the one before. */
  retry(): void;
  /** Gives up: the pending `ask` rejects with `WalletCancelled`. */
  cancel(): void;
}

/** `onChange` receives what to show: the wait, or null when no wallet is being waited for. */
export function createWalletDesk(onChange: (wait: WalletWait | null) => void): WalletDesk {
  let pending: { send(): void; giveUp(): void } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** How many requests each wallet was asked, then given up on, and has not answered since. */
  const unanswered = new Map<string, number>();
  const owe = (wallet: string, change: number) => void unanswered.set(wallet, (unanswered.get(wallet) ?? 0) + change);

  const show = (wait: WalletWait | null) => {
    clearTimeout(timer);
    if (wait && !wait.slow) timer = setTimeout(() => show({ ...wait, slow: true, silent: (unanswered.get(wait.wallet) ?? 0) > 0 }), SLOW_AFTER_MS);
    onChange(wait);
  };
  const finish = () => {
    pending = null;
    show(null);
  };

  return {
    ask<T>(wallet: string, action: WalletAction, request: () => Promise<T>) {
      pending?.giveUp();
      return new Promise<T>((resolve, reject) => {
        /** Stops listening to the request in flight; the wallet now owes it an answer. */
        let abandon = () => {};
        const send = () => {
          abandon();
          let awaited = true;
          abandon = () => {
            awaited = false;
            owe(wallet, 1);
          };
          const settle = (act: () => void) => {
            // A late answer to a request that was given up on: only proof that the wallet is alive.
            if (!awaited) return owe(wallet, -1);
            finish();
            act();
          };
          show({ wallet, action, slow: false, silent: false });
          // Called at once, inside the user's click; a wallet can also throw before it returns a promise.
          new Promise<T>((answer) => answer(request())).then(
            (value) => settle(() => resolve(value)),
            (error: unknown) => settle(() => reject(error)),
          );
        };
        pending = {
          send,
          giveUp() {
            abandon();
            finish();
            reject(new WalletCancelled());
          },
        };
        send();
      });
    },
    retry: () => pending?.send(),
    cancel: () => pending?.giveUp(),
  };
}

/** The words for a wait: which wallet, and where it shows its request. */
export function waitingWords({ wallet, action, slow, silent }: WalletWait): { title: string; body: string } {
  if (silent) {
    return {
      title: `Still nothing from ${wallet}`,
      body: `${wallet} seems to have stopped answering this page, as a wallet does when its side panel is closed while it is asking. Reload the page, then start again.`,
    };
  }
  const where = `${wallet} asks in its own window or in its side panel. Click the ${wallet} icon in the browser toolbar if you see neither.`;
  // A wallet set to mainnet cannot simulate a devnet transaction. Phantom puts a transaction it
  // could not simulate behind two "unsafe" confirmations; its Testnet Mode is what lets it
  // simulate on devnet.
  const devnet =
    action !== "transaction"
      ? ""
      : wallet === "Phantom"
        ? " Phantom previews a devnet transaction only with its Testnet Mode on (Settings, Developer Settings); without a preview it calls the transaction unsafe."
        : " A wallet set to mainnet cannot preview a devnet transaction and may warn about it.";
  if (slow) return { title: `Still waiting for ${wallet}`, body: `${where}${devnet} If it shows nothing, try again.` };
  const asked = { connect: "connection", sign: "signature", transaction: "transaction" }[action];
  return { title: `Approve the ${asked} in ${wallet}`, body: `${where}${devnet}` };
}

/**
 * Wallets that confirm Solana mainnet transactions only. Tested with MetaMask 13.56: it previews a
 * devnet transaction on mainnet, reports that it reverted, keeps its Confirm button off, and has
 * no Solana test network to switch to. Such a wallet can log in here, but it cannot trade.
 */
const MAINNET_ONLY = ["metamask"];
const mainnetOnly = (wallet: string) => MAINNET_ONLY.includes(wallet.toLowerCase());

/** What the login dialog says beside such a wallet; null for a wallet that can trade. */
export function loginOnlyWords(wallet: string): string | null {
  return mainnetOnly(wallet) ? `${wallet} can log in, but it confirms Solana mainnet transactions only, so it cannot trade in this devnet demo.` : null;
}

/** What to say instead of asking such a wallet for a transaction signature; null for a wallet that can sign it. */
export function cannotSignWords(wallet: string): string | null {
  return mainnetOnly(wallet) ? `${wallet} confirms Solana mainnet transactions only, so it cannot sign in this devnet demo. Log out, then log in with another wallet or with email to trade.` : null;
}
