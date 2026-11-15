// Exercises every function of a wallet driver (lib/phantom.mjs, lib/metamask.mjs) against a blank
// test site, with the real extension in a test browser on an empty profile and a wallet created by
// this script (new and empty; nothing of anyone's own wallet or browser is involved).
//
//   cd apps/web && node e2e/real-wallets/check-drivers.mjs <phantom|metamask>
//
// The app is not needed. One PASS or FAIL line per check, repeated together at the end; exit code
// 0 only when every check passes. Evidence: e2e/out/real-wallets/check-drivers-<wallet>/events.log.
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { launch } from "./lib/browser.mjs";
import { metamask } from "./lib/metamask.mjs";
import { phantom } from "./lib/phantom.mjs";
import { openTestSite } from "./lib/site.mjs";

const wallet = { phantom, metamask }[process.argv[2]];
if (!wallet) throw new Error("usage: check-drivers.mjs <phantom|metamask>");
const { label } = wallet;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** The bytes a base58 text stands for. */
function unbase58(text) {
  let value = 0n;
  for (const character of text) value = value * 58n + BigInt(ALPHABET.indexOf(character));
  const bytes = [];
  for (; value > 0n; value >>= 8n) bytes.unshift(Number(value & 0xffn));
  for (const character of text) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}
const isAddress = (text) => typeof text === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) && unbase58(text).length === 32;
/** True when `signature` is the account's signature of the text. */
const signedBy = (address, text, signature) =>
  verify(null, Buffer.from(text), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), unbase58(address)]), format: "der", type: "spki" }), Buffer.from(signature));

/** A transaction that only carries a memo, paid by `address`. It is never sent, so its blockhash is made up. */
function memoTransaction(address) {
  const memo = Buffer.from("driver check");
  const message = [1, 0, 1, 2, ...unbase58(address), ...unbase58("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), ...randomBytes(32), 1, 1, 0, memo.length, ...memo];
  return Uint8Array.from([1, ...new Uint8Array(64), ...message]);
}

const browser = await launch({ wallets: [wallet.name], profile: `check-drivers-${wallet.name}`, run: `check-drivers-${wallet.name}`, fresh: true });
const results = [];
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
/** Runs one check; what it returns is printed after PASS, what it throws after FAIL. */
async function check(name, run) {
  try {
    const detail = await run();
    results.push(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${String(error?.message ?? error).split("\n")[0]}`);
    await tidy().catch(() => {});
  }
  browser.log("check", results.at(-1));
}
/** After a failed check: answers whatever the wallet still shows, so the next check starts clean. */
async function tidy() {
  for (let request, turns = 0; turns < 5 && (request = await wallet.pendingRequest(browser, { timeout: 1_000 })); turns++) {
    if (request.kind === "unlock") await wallet.unlock(browser, password);
    else await request.reject().catch(() => request.dismiss());
  }
}

let site;
let address;
let password;
let setUpAt;

/** The request the wallet shows next, which has to be of this kind (and in this place). */
async function shown(kind, where) {
  const request = await wallet.pendingRequest(browser);
  expect(request, `the wallet showed no request (expected: ${kind})`);
  expect(request.kind === kind, `the wallet's ${request.where} shows "${request.kind}", expected "${kind}": ${(await request.text()).slice(-140)}`);
  expect(!where || request.where === where, `the ${kind} request is in the wallet's ${request.where}, expected its ${where}`);
  return request;
}
/** How the site's latest request ended, waiting up to 10 s for it. */
const outcome = () => site.outcome({ wait: 10_000 });
const describe = (result) => (result.state === "rejected" ? `rejected with code=${result.error.code} message=${JSON.stringify(result.error.message)}` : result.state);
/** Asks for a message signature, approves it where it shows, and checks the signature. */
async function signAndApprove(text, where) {
  await site.signMessage(label, text);
  const request = await shown("message", where);
  expect((await request.text()).includes(text), "the request does not show the message");
  await request.approve();
  const result = await outcome();
  expect(result.state === "resolved", `the site's request is ${describe(result)}`);
  expect(signedBy(result.account, text, result.signature), "the signature does not verify");
  return `approved in the wallet's ${request.where}, valid signature of ${result.account}`;
}
/** Where a request shows while the wallet's side panel is closed. MetaMask opens its panel itself. */
const whenPanelClosed = wallet.name === "phantom" ? "window" : "panel";

try {
  await check("setUp returns the wallet's Solana address", async () => {
    ({ address, password } = await wallet.setUp(browser));
    expect(isAddress(address), `"${address}" is not a Solana address`);
    return address;
  });
  if (!address) throw new Error("no wallet: the other checks cannot run");
  setUpAt = Date.now();
  site = await openTestSite(browser);

  await check("lock, then a site's connection request shows the unlock form", async () => {
    await wallet.lock(browser);
    await site.connect(label);
    return `in the wallet's ${(await shown("unlock")).where}`;
  });
  await check("unlock, and the connection request follows", async () => {
    await wallet.unlock(browser, password);
    return `in the wallet's ${(await shown("connect")).where}`;
  });
  await check("connection rejected", async () => {
    await (await shown("connect")).reject();
    const result = await outcome();
    expect(result.state === "rejected", `the site's request is ${result.state}`);
    return `the site's request is ${describe(result)}`;
  });
  await check("connection approved", async () => {
    await site.connect(label);
    await (await shown("connect")).approve();
    const result = await outcome();
    expect(result.state === "resolved" && result.accounts.includes(address), `the site's request is ${describe(result)}, accounts ${result.accounts}`);
    return `the site gets ${result.accounts.join(", ")}`;
  });
  await check("message signature rejected", async () => {
    await site.signMessage(label, "Driver check: a message to decline.");
    await (await shown("message")).reject();
    const result = await outcome();
    expect(result.state === "rejected", `the site's request is ${result.state}`);
    return `the site's request is ${describe(result)}`;
  });
  await check(`message signature approved (side panel closed: asked in the wallet's ${whenPanelClosed})`, () => signAndApprove("Driver check: a message to sign.", whenPanelClosed));

  if (wallet.name === "phantom") {
    await check("dismiss in window mode", async () => {
      await site.signMessage(label, "Driver check: a message whose window is closed.");
      await (await shown("message", "window")).dismiss();
      const result = await outcome();
      expect(!(await wallet.pendingRequest(browser, { timeout: 1_500 })), "the wallet still shows a request");
      return `10 s later the site's request is ${describe(result)}`;
    });
  }

  await check("openSidePanel, closeSidePanel", async () => {
    await wallet.openSidePanel(browser);
    expect(await wallet.sidePanelOpen(browser), "the side panel is not open after openSidePanel");
    await wallet.closeSidePanel(browser);
    expect(!(await wallet.sidePanelOpen(browser)), "the side panel is still open after closeSidePanel");
    await wallet.openSidePanel(browser);
    expect(await wallet.sidePanelOpen(browser), "the side panel did not open again");
    await site.page.bringToFront();
  });
  await check("side panel open: a request shows in the panel and no window opens", async () => {
    const since = Date.now();
    const detail = await signAndApprove("Driver check: a message for the side panel.", "panel");
    const windows = browser.windows.filter((entry) => entry.openedAt >= since).length;
    expect(windows === 0, `${windows} wallet window(s) opened`);
    return detail;
  });
  await check(`side panel closed again: a request shows in the wallet's ${whenPanelClosed}`, async () => {
    await wallet.closeSidePanel(browser);
    return signAndApprove("Driver check: a message after the panel was closed.", whenPanelClosed);
  });

  await check("lock and unlock with no request waiting", async () => {
    await wallet.lock(browser);
    await wallet.unlock(browser, password);
    return signAndApprove("Driver check: a message after unlocking.");
  });

  let second;
  await check("addAccount, switchAccount", async () => {
    second = await wallet.addAccount(browser);
    expect(isAddress(second.address) && second.address !== address, `"${second.address}" is not a second Solana address`);
    const before = (await site.changes()).length;
    await wallet.switchAccount(browser, second.address);
    await sleep(3_000);
    const events = (await site.changes()).slice(before).map((change) => JSON.stringify(change.accounts));
    return `added ${second.address}; after the switch the connected site got ${events.length} change event(s) [${events.join(" ")}] and the wallet shares [${(await site.accounts(label)).join(", ")}]`;
  });
  await check("switchAccount to the first account", async () => {
    const before = (await site.changes()).length;
    await wallet.switchAccount(browser, address);
    await sleep(3_000);
    const events = (await site.changes()).slice(before).map((change) => JSON.stringify(change.accounts));
    return `the connected site got ${events.length} change event(s) [${events.join(" ")}] and the wallet shares [${(await site.accounts(label)).join(", ")}]`;
  });

  if (wallet.setTestnetMode) {
    await check("setTestnetMode(true), then a message signature", async () => {
      await wallet.setTestnetMode(browser, true);
      const detail = await signAndApprove("Driver check: a message in Testnet Mode.");
      await wallet.setTestnetMode(browser, false);
      return detail;
    });
  }

  await check("transaction signature request rejected", async () => {
    await site.signTransaction(label, memoTransaction(address));
    const request = await shown("transaction");
    const offer = request.approvable ? "it can be approved" : "the wallet offers no ordinary approval (approve() would throw)";
    await request.reject();
    return `shown in the wallet's ${request.where}, ${offer}; declined, the site's request is ${describe(await outcome())}`;
  });

  // Last, because of what it leaves behind: a request abandoned in the side panel.
  await check("dismiss in panel mode", async () => {
    await wallet.openSidePanel(browser);
    await site.page.bringToFront();
    await site.signMessage(label, "Driver check: a message whose panel is closed.");
    await (await shown("message", "panel")).dismiss();
    const result = await outcome();
    expect(!(await wallet.sidePanelOpen(browser)), "the side panel is still open");
    // Is a later request of the same page still shown?
    await site.signMessage(label, "Driver check: a message after an abandoned one.");
    const next = await wallet.pendingRequest(browser, { timeout: 12_000 });
    let then = next ? `a new request is shown in the wallet's ${next.where}` : "a new request is shown nowhere within 12 s";
    await next?.reject();
    // Does the wallet still hold what it was asked? Its own page shows it again if so.
    const page = await wallet.open(browser);
    let kept = 0;
    for (let request; (request = await wallet.pendingRequest(browser, { timeout: 4_000 })); kept++) await request.reject();
    await page.close().catch(() => {});
    await sleep(1_000);
    const [first, second] = (await site.calls()).slice(-2).map(describe);
    then += kept ? `; the wallet's own page then shows ${kept} waiting request(s); declined there, the two requests are ${first} and ${second}` : `; the wallet's own page shows no waiting request, and the two requests stay ${first} and ${second}`;
    return `10 s later the site's request is ${describe(result)}; ${then}`;
  });

  if (wallet.name === "metamask") {
    await check("dismiss in window mode: not applicable, MetaMask opens no window", async () => {
      const windows = browser.windows.filter((entry) => entry.openedAt >= setUpAt).length;
      expect(windows === 0, `${windows} MetaMask window(s) opened during the run`);
      return "0 windows opened during the run";
    });
  }
} catch (error) {
  results.push(`FAIL ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  await site?.close();
  await browser.close();
}

console.log(`\n${label} driver checks:\n${results.join("\n")}`);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
