import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cannotSignWords, createWalletDesk, loginOnlyWords, SLOW_AFTER_MS, waitingWords, WalletCancelled, type WalletWait } from "./wallet-request";

/** A wallet request the test answers by hand, as a person would in the wallet. */
function wallet<T>() {
  const requests: { resolve(value: T): void; reject(error: unknown): void }[] = [];
  const request = () => new Promise<T>((resolve, reject) => requests.push({ resolve, reject }));
  return { request, requests };
}

function desk() {
  const shown: (WalletWait | null)[] = [];
  return { shown, desk: createWalletDesk((wait) => shown.push(wait)) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createWalletDesk", () => {
  it("says which wallet is being waited for, then resolves with its answer", async () => {
    const { desk: d, shown } = desk();
    const phantom = wallet<string>();
    const answer = d.ask("Phantom", "connect", phantom.request);
    expect(shown).toEqual([{ wallet: "Phantom", action: "connect", slow: false, silent: false }]);
    phantom.requests[0]?.resolve("address");
    await expect(answer).resolves.toBe("address");
    expect(shown.at(-1)).toBeNull();
  });

  it("passes on the wallet's refusal and stops waiting", async () => {
    const { desk: d, shown } = desk();
    const phantom = wallet<string>();
    const answer = d.ask("Phantom", "sign", phantom.request);
    const refusal = Object.assign(new Error("User rejected the request."), { code: 4001 });
    phantom.requests[0]?.reject(refusal);
    await expect(answer).rejects.toBe(refusal);
    expect(shown.at(-1)).toBeNull();
  });

  it("marks the wait as slow when the wallet has not answered for a while", () => {
    const { desk: d, shown } = desk();
    void d.ask("Phantom", "sign", wallet<string>().request);
    vi.advanceTimersByTime(SLOW_AFTER_MS - 1);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: false, silent: false });
    vi.advanceTimersByTime(1);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: true, silent: false });
  });

  it("asks the wallet again on Try again, and no longer listens to the request it gave up on", async () => {
    const { desk: d, shown } = desk();
    const phantom = wallet<string>();
    const answer = d.ask("Phantom", "sign", phantom.request);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    d.retry();
    expect(phantom.requests).toHaveLength(2);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: false, silent: false });

    phantom.requests[0]?.resolve("late answer to the first request");
    await Promise.resolve();
    expect(shown.at(-1)).not.toBeNull();

    phantom.requests[1]?.resolve("answer to the second request");
    await expect(answer).resolves.toBe("answer to the second request");
  });

  it("is not failed by a late refusal of the request it gave up on", async () => {
    const { desk: d } = desk();
    const phantom = wallet<string>();
    const answer = d.ask("Phantom", "sign", phantom.request);
    d.retry();
    phantom.requests[0]?.reject(new Error("User rejected the request."));
    phantom.requests[1]?.resolve("signed");
    await expect(answer).resolves.toBe("signed");
  });

  it("rejects with WalletCancelled on Cancel, and a later answer changes nothing", async () => {
    const { desk: d, shown } = desk();
    const phantom = wallet<string>();
    const answer = d.ask("Phantom", "sign", phantom.request);
    d.cancel();
    await expect(answer).rejects.toBeInstanceOf(WalletCancelled);
    expect(shown.at(-1)).toBeNull();

    const before = shown.length;
    phantom.requests[0]?.resolve("too late");
    await Promise.resolve();
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown).toHaveLength(before);
  });

  it("gives up on a pending request when another one is asked for", async () => {
    const { desk: d, shown } = desk();
    const first = d.ask("Phantom", "connect", wallet<string>().request);
    const metamask = wallet<string>();
    const second = d.ask("MetaMask", "connect", metamask.request);
    await expect(first).rejects.toBeInstanceOf(WalletCancelled);
    expect(shown.at(-1)).toEqual({ wallet: "MetaMask", action: "connect", slow: false, silent: false });
    metamask.requests[0]?.resolve("address");
    await expect(second).resolves.toBe("address");
  });

  it("says the wallet has gone silent when it leaves the second request unanswered too", () => {
    const { desk: d, shown } = desk();
    void d.ask("Phantom", "sign", wallet<string>().request);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: true, silent: false });
    d.retry();
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: true, silent: true });
  });

  it("remembers a wallet that left a cancelled request unanswered", async () => {
    const { desk: d, shown } = desk();
    const first = d.ask("Phantom", "sign", wallet<string>().request);
    d.cancel();
    await expect(first).rejects.toBeInstanceOf(WalletCancelled);
    void d.ask("Phantom", "connect", wallet<string>().request);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "connect", slow: true, silent: true });
  });

  it("no longer calls a wallet silent once it has answered the request that was given up on", async () => {
    const { desk: d, shown } = desk();
    const phantom = wallet<string>();
    const first = d.ask("Phantom", "sign", phantom.request);
    d.cancel();
    await expect(first).rejects.toBeInstanceOf(WalletCancelled);
    phantom.requests[0]?.reject(new Error("User rejected the request."));
    await vi.advanceTimersByTimeAsync(0);
    void d.ask("Phantom", "sign", phantom.request);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown.at(-1)).toEqual({ wallet: "Phantom", action: "sign", slow: true, silent: false });
  });

  it("does not hold one wallet's silence against another", async () => {
    const { desk: d, shown } = desk();
    const first = d.ask("Phantom", "sign", wallet<string>().request);
    void d.ask("MetaMask", "sign", wallet<string>().request);
    await expect(first).rejects.toBeInstanceOf(WalletCancelled);
    vi.advanceTimersByTime(SLOW_AFTER_MS);
    expect(shown.at(-1)).toEqual({ wallet: "MetaMask", action: "sign", slow: true, silent: false });
  });

  it("treats a request that throws at once as a refusal", async () => {
    const { desk: d, shown } = desk();
    const broken = new Error("wallet is gone");
    await expect(
      d.ask("Phantom", "sign", () => {
        throw broken;
      }),
    ).rejects.toBe(broken);
    expect(shown.at(-1)).toBeNull();
  });

  it("does nothing on Try again or Cancel when no wallet is being waited for", () => {
    const { desk: d, shown } = desk();
    d.retry();
    d.cancel();
    expect(shown).toEqual([]);
  });
});

describe("waitingWords", () => {
  it("names the wallet and says where it asks", () => {
    expect(waitingWords({ wallet: "Phantom", action: "connect", slow: false, silent: false })).toEqual({
      title: "Approve the connection in Phantom",
      body: "Phantom asks in its own window or in its side panel. Click the Phantom icon in the browser toolbar if you see neither.",
    });
    expect(waitingWords({ wallet: "MetaMask", action: "sign", slow: false, silent: false }).title).toBe("Approve the signature in MetaMask");
  });

  it("offers a way on once the wallet is slow to answer", () => {
    expect(waitingWords({ wallet: "Phantom", action: "sign", slow: true, silent: false })).toEqual({
      title: "Still waiting for Phantom",
      body: "Phantom asks in its own window or in its side panel. Click the Phantom icon in the browser toolbar if you see neither. If it shows nothing, try again.",
    });
  });
});

describe("waitingWords for a wallet that has gone silent", () => {
  it("says to reload the page, which is what brings such a wallet back", () => {
    expect(waitingWords({ wallet: "Phantom", action: "sign", slow: true, silent: true })).toEqual({
      title: "Still nothing from Phantom",
      body: "Phantom seems to have stopped answering this page, as a wallet does when its side panel is closed while it is asking. Reload the page, then start again.",
    });
  });
});

describe("waitingWords for a transaction", () => {
  const where = (wallet: string) => `${wallet} asks in its own window or in its side panel. Click the ${wallet} icon in the browser toolbar if you see neither.`;

  it("says that a wallet set to mainnet cannot preview a devnet transaction", () => {
    expect(waitingWords({ wallet: "Solflare", action: "transaction", slow: false, silent: false })).toEqual({
      title: "Approve the transaction in Solflare",
      body: `${where("Solflare")} A wallet set to mainnet cannot preview a devnet transaction and may warn about it.`,
    });
  });

  it("names the setting Phantom needs to preview it", () => {
    expect(waitingWords({ wallet: "Phantom", action: "transaction", slow: false, silent: false }).body).toBe(
      `${where("Phantom")} Phantom previews a devnet transaction only with its Testnet Mode on (Settings, Developer Settings); without a preview it calls the transaction unsafe.`,
    );
  });

  it("keeps saying so once the wallet is slow, and offers the way on", () => {
    expect(waitingWords({ wallet: "Phantom", action: "transaction", slow: true, silent: false })).toEqual({
      title: "Still waiting for Phantom",
      body: `${where("Phantom")} Phantom previews a devnet transaction only with its Testnet Mode on (Settings, Developer Settings); without a preview it calls the transaction unsafe. If it shows nothing, try again.`,
    });
  });
});

describe("cannotSignWords", () => {
  it("says plainly that MetaMask cannot sign for a devnet demo, and what to do", () => {
    expect(cannotSignWords("MetaMask")).toBe(
      "MetaMask confirms Solana mainnet transactions only, so it cannot sign in this devnet demo. Log out, then log in with another wallet or with email to trade.",
    );
    expect(cannotSignWords("metamask")).not.toBeNull();
  });
  it("has nothing to say about a wallet that signs devnet transactions", () => {
    expect(cannotSignWords("Phantom")).toBeNull();
    expect(cannotSignWords("Test Wallet")).toBeNull();
  });
});

describe("loginOnlyWords", () => {
  it("warns in the login dialog that MetaMask can log in but not trade", () => {
    expect(loginOnlyWords("MetaMask")).toBe("MetaMask can log in, but it confirms Solana mainnet transactions only, so it cannot trade in this devnet demo.");
  });
  it("has nothing to say about a wallet that can trade", () => {
    expect(loginOnlyWords("Phantom")).toBeNull();
  });
});
