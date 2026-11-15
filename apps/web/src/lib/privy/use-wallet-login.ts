"use client";

import { useConnectWallet, useLoginWithSiws, usePrivy } from "@privy-io/react-auth";
import { useStandardWallets } from "@privy-io/react-auth/solana";
import { useCallback, useMemo, useRef, useState } from "react";
import { useAccount } from "./account";
import { useWalletDesk } from "./wallet-desk";
import { isLoginWallet, logInWithWallet, type WalletLoginState, type WalletLoginSteps } from "./wallet-login";

/** One wallet's part in a login, and the names the login provider files it under. */
interface WalletSteps extends Pick<WalletLoginSteps, "connect" | "sign"> {
  name: string;
  clientType: string;
  connectorType: string;
}

export interface WalletLogin {
  /** True while the login dialog is asked for. */
  open: boolean;
  state: WalletLoginState;
  /** The Solana wallet extensions found in this browser, by the name and icon they list themselves with. */
  wallets: readonly { name: string; icon: string }[];
  withWallet(name: string): void;
  /** The login provider's own window, for email only. */
  withEmail(): void;
  /** The login provider's window with the WalletConnect code; the signature step is then the app's own. */
  withWalletConnect(): void;
  /** After a failure: the same wallet once more. */
  retry(): void;
  /** Back to the list of ways to log in, giving up on a wallet that is being waited for. */
  back(): void;
  close(): void;
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** The app's own login: which ways there are, and the state of a login with a wallet. */
export function useWalletLogin(): WalletLogin {
  const { loginOpen, login: openDialog, closeLogin } = useAccount();
  const { login: openProviderWindow } = usePrivy();
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws();
  const { wallets: listed } = useStandardWallets();
  const { ask, cancel } = useWalletDesk();
  const [state, setState] = useState<WalletLoginState>({ step: "choose" });
  /** Counts the logins started. A login whose number is no longer the current one was abandoned. */
  const run = useRef(0);
  const last = useRef<WalletSteps | null>(null);
  const viaWalletConnect = useRef(false);

  const back = useCallback(() => {
    run.current++;
    cancel();
    setState({ step: "choose" });
  }, [cancel]);
  const close = useCallback(() => {
    back();
    closeLogin();
  }, [back, closeLogin]);

  const start = useCallback(
    (wallet: WalletSteps) => {
      const mine = ++run.current;
      last.current = wallet;
      void logInWithWallet(
        wallet.name,
        {
          connect: wallet.connect,
          message: (address) => generateSiwsMessage({ address }),
          sign: wallet.sign,
          verify: async (message, signature) => {
            await loginWithSiws({ message, signature: btoa(String.fromCharCode(...signature)), walletClientType: wallet.clientType, connectorType: wallet.connectorType });
          },
        },
        (next) => {
          if (next.step !== "done") return setState(next);
          setState({ step: "choose" });
          closeLogin();
        },
        () => run.current !== mine,
      );
    },
    [closeLogin, generateSiwsMessage, loginWithSiws],
  );

  const withWallet = useCallback(
    (name: string) => {
      const wallet = listed.find((candidate) => candidate.name === name && isLoginWallet(candidate));
      const connecting = wallet?.features["standard:connect"];
      const signing = wallet?.features["solana:signMessage"];
      if (!wallet || !connecting || !signing) return;
      start({
        name,
        // The names the login provider's own window files an extension under.
        clientType: name,
        connectorType: "solana_adapter",
        connect: async () => {
          const { accounts } = await ask(name, "connect", () => connecting.connect());
          return accounts.find((account) => account.chains.some((chain) => chain.startsWith("solana:")))?.address ?? null;
        },
        sign: async (address, message) => {
          const account = wallet.accounts.find((candidate) => candidate.address === address);
          if (!account) throw new Error("The wallet is no longer on the account that connected.");
          const [signed] = await ask(name, "sign", () => signing.signMessage({ account, message: bytes(message) }));
          if (!signed) throw new Error("The wallet returned no signature.");
          return signed.signature;
        },
      });
    },
    [ask, listed, start],
  );

  const withEmail = useCallback(() => {
    close();
    openProviderWindow({ loginMethods: ["email"] });
  }, [close, openProviderWindow]);

  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (!viaWalletConnect.current || wallet.type !== "solana") return;
      viaWalletConnect.current = false;
      const name = wallet.meta.name;
      openDialog();
      start({
        name,
        clientType: wallet.walletClientType,
        connectorType: wallet.connectorType,
        connect: async () => wallet.address,
        sign: async (_address, message) => (await ask(name, "sign", () => wallet.provider.signMessage({ message: bytes(message) }))).signature,
      });
    },
    onError: () => {
      viaWalletConnect.current = false;
    },
  });
  const withWalletConnect = useCallback(() => {
    close();
    viaWalletConnect.current = true;
    connectWallet({ walletList: ["wallet_connect_qr_solana"], walletChainType: "solana-only", description: "Connect a Solana wallet on your phone with WalletConnect." });
  }, [close, connectWallet]);

  const retry = useCallback(() => {
    if (last.current) start(last.current);
  }, [start]);
  const wallets = useMemo(() => listed.filter(isLoginWallet).map(({ name, icon }) => ({ name, icon })), [listed]);

  return { open: loginOpen, state, wallets, withWallet, withEmail, withWalletConnect, retry, back, close };
}
