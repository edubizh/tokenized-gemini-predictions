// A minimal Wallet Standard wallet for browser tests: it is injected into the page before the app
// loads, shows up in the login dialog like any installed Solana wallet, and signs messages and
// transactions with a throwaway devnet key. It never sends anything itself.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const TEST_WALLET_NAME = "Test Wallet";

/** Loads the 64-byte keypair file (secret seed, then public key), creating it on first use. */
export function loadTestWalletKey(file) {
  if (!existsSync(file)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    writeFileSync(file, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  }
  const bytes = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${file} is not a 64-byte keypair file`);
  return bytes;
}

/** Runs in the page. `keypair` is the 64-byte array; `name` the wallet's display name. */
export function installTestWallet({ keypair, name }) {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const base58 = (bytes) => {
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    let text = "";
    while (value > 0n) {
      text = ALPHABET[Number(value % 58n)] + text;
      value /= 58n;
    }
    for (const byte of bytes) {
      if (byte !== 0) break;
      text = "1" + text;
    }
    return text;
  };
  const seed = Uint8Array.from(keypair.slice(0, 32));
  const publicKey = Uint8Array.from(keypair.slice(32));
  const address = base58(publicKey);
  const CHAINS = ["solana:devnet", "solana:testnet", "solana:mainnet"];
  const FEATURES = ["solana:signMessage", "solana:signTransaction"];

  // PKCS#8 wrapping of a raw Ed25519 seed.
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await key, bytes));

  /** Fills this wallet's signature slot of a serialized (legacy or version 0) transaction. */
  const signTransaction = async (transaction) => {
    const bytes = Uint8Array.from(transaction);
    // Signatures: a compact-u16 count (one byte for fewer than 128), then 64 bytes each.
    if (bytes[0] >= 0x80) throw new Error("too many signatures");
    const count = bytes[0];
    const messageStart = 1 + 64 * count;
    const message = bytes.subarray(messageStart);
    // Message: an optional version byte (high bit set), a 3-byte header, then the account keys.
    const versioned = (message[0] & 0x80) !== 0;
    const keysStart = (versioned ? 1 : 0) + 3 + 1;
    let slot = -1;
    for (let i = 0; i < count; i++) {
      const candidate = message.subarray(keysStart + 32 * i, keysStart + 32 * (i + 1));
      if (candidate.every((byte, index) => byte === publicKey[index])) slot = i;
    }
    if (slot === -1) throw new Error("this wallet is not a signer of the transaction");
    bytes.set(await sign(message), 1 + 64 * slot);
    return bytes;
  };

  const account = { address, publicKey, chains: CHAINS, features: FEATURES };
  // A second account of the same wallet, for the user switching account inside it. It signs nothing.
  const otherKey = crypto.getRandomValues(new Uint8Array(32));
  const other = { address: base58(otherKey), publicKey: otherKey, chains: CHAINS, features: FEATURES };
  const listeners = new Set();
  let accounts = [];
  const mine = (input) => {
    if (input.account?.address !== address) throw new Error("invalid account");
    return input;
  };
  const wallet = {
    version: "1.0.0",
    name,
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNiIgZmlsbD0iIzIyMjYzNCIvPjwvc3ZnPg==",
    chains: CHAINS,
    get accounts() {
      return accounts;
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          accounts = [account];
          for (const listener of listeners) listener({ accounts });
          return { accounts };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          accounts = [];
          for (const listener of listeners) listener({ accounts });
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: (event, listener) => {
          if (event !== "change") return () => {};
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      "solana:signMessage": {
        version: "1.1.0",
        signMessage: async (...inputs) =>
          Promise.all(inputs.map(mine).map(async ({ message }) => ({ signedMessage: message, signature: await sign(message), signatureType: "ed25519" }))),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => Promise.all(inputs.map(mine).map(async ({ transaction }) => ({ signedTransaction: await signTransaction(transaction) }))),
      },
    },
  };

  const register = ({ register: add }) => add(wallet);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  } catch {
    // The app registers the listener later; the app-ready event below covers that.
  }
  window.addEventListener("wallet-standard:app-ready", (event) => register(event.detail));
  window.__testWalletAddress = address;
  /** Stands for the user switching account inside the connected wallet: to the other account, or back. */
  window.__testWalletSwitch = (toOther) => {
    accounts = [toOther ? other : account];
    for (const listener of listeners) listener({ accounts });
  };
}
