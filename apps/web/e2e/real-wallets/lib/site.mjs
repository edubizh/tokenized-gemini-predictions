// A blank test site on http://localhost:3299/. A wallet extension only injects into http(s) pages,
// so this page is how a script makes a wallet show a request without the app: it collects the
// wallets that register through the Wallet Standard and calls their features from a real click.
import { createServer } from "node:http";

export const SITE_PORT = 3299;

/** The page's own script: the wallets it has seen and every request it has made to them. */
function sitePage() {
  const wallets = [];
  const api = Object.freeze({
    register: (...added) => {
      for (const wallet of added) if (!wallets.includes(wallet)) wallets.push(wallet);
      return () => {};
    },
  });
  // A wallet that loads after the page announces itself; one that is already there is asked.
  window.addEventListener("wallet-standard:register-wallet", (event) => event.detail(api));
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));

  const calls = [];
  const changes = [];
  const listening = new Set();
  // MetaMask registers a second wallet of the same name for Bitcoin: take the Solana one.
  const find = (label) => wallets.find((wallet) => wallet.name === label && wallet.chains.some((chain) => chain.startsWith("solana:")));
  const addresses = (accounts) => (accounts ?? []).map((account) => account.address);

  const requests = {
    connect: (wallet) => wallet.features["standard:connect"].connect().then((result) => ({ accounts: addresses(result.accounts) })),
    signMessage: (wallet, text) =>
      wallet.features["solana:signMessage"]
        .signMessage({ account: wallet.accounts[0], message: new TextEncoder().encode(text) })
        .then(([signed]) => ({ account: wallet.accounts[0]?.address, signature: [...signed.signature] })),
    signTransaction: (wallet, transaction) =>
      wallet.features["solana:signTransaction"]
        .signTransaction({ account: wallet.accounts[0], transaction: new Uint8Array(transaction), chain: "solana:devnet" })
        .then(([signed]) => ({ account: wallet.accounts[0]?.address, signedTransaction: [...signed.signedTransaction] })),
  };

  /** Makes one request and records how it ends; the caller does not wait for the wallet. */
  const ask = ({ kind, label, input }) => {
    const call = { kind, label, state: "pending" };
    calls.push(call);
    const settle = (state, rest) => Object.assign(call, { state, ...rest });
    try {
      const wallet = find(label);
      if (!wallet) throw new Error(`no wallet named ${label} has registered`);
      if (!listening.has(wallet)) {
        listening.add(wallet);
        wallet.features["standard:events"]?.on("change", (change) => changes.push({ label, accounts: change.accounts ? addresses(change.accounts) : null }));
      }
      requests[kind](wallet, input).then(
        (result) => settle("resolved", result),
        (error) => settle("rejected", { error: { name: error?.name, code: error?.code, message: String(error?.message ?? error) } }),
      );
    } catch (error) {
      settle("rejected", { error: { name: error?.name, code: error?.code, message: String(error?.message ?? error) } });
    }
  };

  window.site = { wallets, calls, changes, next: null };
  document.getElementById("ask").addEventListener("click", () => ask(window.site.next));
}

const HTML = `<!doctype html><meta charset="utf-8"><title>Wallet test site</title><button id="ask">Ask the wallet</button><script>(${sitePage})()</script>`;

/**
 * Serves the test site and opens it in a new tab. `connect`, `signMessage` and `signTransaction`
 * make the request from a click on the page and return at once: the wallet's answer is read later
 * with `outcome()`. `label` is the wallet's Wallet Standard name ("Phantom", "MetaMask").
 */
export async function openTestSite(browser) {
  const server = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" }).end(HTML));
  await new Promise((resolve, reject) => server.once("error", reject).listen(SITE_PORT, "127.0.0.1", resolve));
  const page = await browser.context.newPage();
  await page.goto(`http://localhost:${SITE_PORT}/`);

  const ask = async (kind, label, input) => {
    // A wallet registers a moment after the page loads.
    await page.waitForFunction((name) => window.site.wallets.some((wallet) => wallet.name === name), label, { timeout: 15_000 });
    await page.evaluate((next) => void (window.site.next = next), { kind, label, input });
    await page.click("#ask");
    browser.log("site", `${kind} asked of ${label}`);
  };

  return {
    page,
    connect: (label) => ask("connect", label),
    signMessage: (label, text) => ask("signMessage", label, text),
    /** `transaction` is a serialized transaction (bytes); it is asked for on devnet. */
    signTransaction: (label, transaction) => ask("signTransaction", label, [...transaction]),
    /**
     * How the latest request ended: `{ kind, label, state: "pending" | "resolved" | "rejected", ... }`
     * with `accounts` (connect), `signature` (message), `signedTransaction`, or `error: { name, code,
     * message }`. Waits up to `wait` ms for it to settle.
     */
    async outcome({ wait = 0 } = {}) {
      const latest = () => page.evaluate(() => window.site.calls.at(-1) ?? null);
      for (const deadline = Date.now() + wait; (await latest())?.state === "pending" && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 200));
      return latest();
    },
    /** Every request made so far, oldest first, in the form `outcome()` returns. */
    calls: () => page.evaluate(() => window.site.calls),
    /** The account lists the wallets have announced through their `change` event, oldest first. */
    changes: () => page.evaluate(() => window.site.changes),
    /** The addresses the wallet currently shares with the site. */
    accounts: (label) => page.evaluate((name) => window.site.wallets.find((wallet) => wallet.name === name && wallet.chains.some((chain) => chain.startsWith("solana:")))?.accounts.map((account) => account.address) ?? [], label),
    async close() {
      await page.close().catch(() => {});
      // The browser keeps its connection to the server open: drop it instead of waiting for it.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
