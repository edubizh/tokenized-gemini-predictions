"use client";

// Login spike: proves email login with an embedded Solana wallet, wallet login, signing a
// transaction built with @solana/kit, and server-side verification of the login token.
// Throwaway page; replaced by the real app.
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { getAddMemoInstruction } from "@solana-program/memo";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  devnet,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import { useState } from "react";

const RPC_URL = "https://api.devnet.solana.com";
const WS_URL = "wss://api.devnet.solana.com";
const CHAIN = "solana:devnet" as const;

const rpc = createSolanaRpc(devnet(RPC_URL));
const rpcSubscriptions = createSolanaRpcSubscriptions(devnet(WS_URL));
const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: false });

export function SpikeApp() {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <p>NEXT_PUBLIC_PRIVY_APP_ID is not set.</p>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: {
          walletChainType: "solana-only",
          walletList: ["phantom", "solflare", "backpack", "detected_solana_wallets", "wallet_connect_qr_solana"],
        },
        embeddedWallets: {
          solana: { createOnLogin: "users-without-wallets" },
          showWalletUIs: false,
        },
        externalWallets: { solana: { connectors: solanaConnectors } },
        solana: { rpcs: { [CHAIN]: { rpc, rpcSubscriptions } } },
      }}
    >
      <Spike />
    </PrivyProvider>
  );
}

function Spike() {
  const { ready, authenticated, login, logout, user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const [log, setLog] = useState<string[]>([]);
  const [signature, setSignature] = useState<string | null>(null);
  const [whoami, setWhoami] = useState<string | null>(null);
  const say = (line: string) => setLog((lines) => [...lines, line]);

  const wallet = wallets[0];

  async function sendMemo() {
    if (!wallet) return;
    try {
      setSignature(null);
      const payer = address(wallet.address);
      const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => setTransactionMessageComputeUnitLimit(20_000, m),
        (m) => appendTransactionMessageInstructions([getAddMemoInstruction({ memo: "outcome-tokens login spike" })], m),
      );
      const unsigned = new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
      say(`built ${unsigned.length} bytes`);
      const { signedTransaction } = await signTransaction({ transaction: unsigned, wallet, chain: CHAIN });
      const decoded = getTransactionDecoder().decode(signedTransaction);
      const first = Object.values(decoded.signatures)[0];
      if (!first) throw new Error("wallet returned no signature");
      const sig = getBase58Decoder().decode(first);
      const wire = getBase64Decoder().decode(signedTransaction) as Base64EncodedWireTransaction;
      await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed" }).send();
      say(`sent ${sig}`);
      for (let i = 0; i < 40; i++) {
        const { value } = await rpc.getSignatureStatuses([sig as Parameters<typeof rpc.getSignatureStatuses>[0][number]]).send();
        const status = value[0];
        if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
          setSignature(sig);
          say(`confirmed (${status.confirmationStatus})`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("not confirmed in time");
    } catch (error) {
      say(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function checkServer() {
    try {
      const token = await getAccessToken();
      const res = await fetch("/api/spike/whoami", { headers: { authorization: `Bearer ${token}` } });
      setWhoami(JSON.stringify(await res.json()));
    } catch (error) {
      setWhoami(`ERROR ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 760 }}>
      <h1>Login spike</h1>
      <p data-testid="state">{!ready ? "loading" : authenticated ? "authenticated" : "anonymous"}</p>
      {ready && !authenticated && (
        <button data-testid="login" onClick={() => login()}>
          Log in
        </button>
      )}
      {ready && authenticated && (
        <>
          <p>
            user <code data-testid="user-id">{user?.id}</code>
          </p>
          <p>
            wallets: <span data-testid="wallet-count">{wallets.length}</span>
          </p>
          <ul>
            {wallets.map((w) => (
              <li key={w.address}>
                <code data-testid="wallet-address">{w.address}</code>
              </li>
            ))}
          </ul>
          <button data-testid="send" onClick={sendMemo} disabled={!wallet}>
            Sign and send a memo on devnet
          </button>{" "}
          <button data-testid="whoami" onClick={checkServer}>
            Verify on server
          </button>{" "}
          <button data-testid="logout" onClick={() => logout()}>
            Log out
          </button>
          <p>
            signature: <code data-testid="signature">{signature ?? ""}</code>
          </p>
          <p>
            server: <code data-testid="whoami-result">{whoami ?? ""}</code>
          </p>
        </>
      )}
      <pre data-testid="log">{log.join("\n")}</pre>
    </main>
  );
}
