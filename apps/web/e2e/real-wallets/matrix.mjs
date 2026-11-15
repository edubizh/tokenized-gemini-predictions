// The wallet matrix: logging in and signing with the real Phantom and MetaMask extensions, each in
// a test browser on an empty profile with a wallet created by the run (new, empty, devnet only).
//
//   cd apps/web && pnpm exec next dev -p 3200
//   node e2e/real-wallets/matrix.mjs <phantom|metamask> <case>
//
// Cases that need the web app only (the fixtures server will do: LIVE_BASE_URL=http://localhost:3100):
//   first-login     connect, then sign, in the wallet's default place (Phantom: a window; MetaMask: its side panel)
//   side-panel      the same with the wallet's side panel open
//   reject-connect  the user declines the connection: a message and Try again
//   reject-sign     the user declines the signature: a message and Try again
//   close-window    the user closes the wallet's window without answering (wallets that open one)
//   no-answer       the user closes the side panel without answering: "Still waiting", Try again, Cancel
//   locked          the wallet is locked: Cancel works, and unlocking completes the login
//   relogin         log out and in again, the site now trusted
//   two-wallets     both wallets installed, the other one's side panel open
// Cases on the live stack (also the relayer, with the simulated venue; see the README of the repo):
//   live            first-run test funds in the trade panel, an order to FILLED or REFUNDED, an account
//                   switch inside the wallet, reload then Reconnect wallet, and a settled position
//                   redeemed on the portfolio. MetaMask
//                   confirms Solana mainnet transactions only: for it the run checks that the app
//                   says so instead of asking for a signature it cannot give.
//   reclaim         an order nobody fills is reclaimed after its deadline. The run prints READY once
//                   the order's signature is asked for and then waits for the relayer to be stopped;
//                   the expired order is reclaimed on the activity page.
//
// Each line of a run is a PASS or a FAIL; the exit code is 0 only when every one passed.
// LIVE_BASE_URL overrides http://localhost:3200; HEADED=1 opens real windows. MARKETS overrides the
// query of the markets index a live case picks its market from (default "?cadence=15m").
// Evidence: e2e/out/real-wallets/matrix-<wallet>-<case>/ (events.log and screenshots).
import { BASE, listedWallets, loginDialog, loginStep, loginText, logOut, openApp, openLogin, pickWallet, waitForLogin, waiting, waitingSlow, waitingText } from "./lib/app.mjs";
import { launch } from "./lib/browser.mjs";
import { metamask, panelUrl as metamaskPanel } from "./lib/metamask.mjs";
import { phantom, panelUrl as phantomPanel } from "./lib/phantom.mjs";
import { attachSidePanel } from "./lib/side-panel.mjs";
import { traceWalletCalls } from "./lib/trace.mjs";

const DRIVERS = { phantom, metamask };
const [walletName, caseName] = process.argv.slice(2);
const driver = DRIVERS[walletName];
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8787";
/** How long a 15-minute event of the simulated venue lasts (the relayer's MOCK_WINDOW_SECS); windows start on multiples of it. */
const MARKET_WINDOW_SECS = Number(process.env.MOCK_WINDOW_SECS ?? 180);
const MARKETS = process.env.MARKETS ?? "?cadence=15m";
/** MetaMask confirms Solana mainnet transactions only: it can log in, and the app refuses to ask it for a devnet signature. */
const cannotTrade = walletName === "metamask";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const oneLine = (text) => text.replace(/\s+/g, " ").trim();
const short = (address) => `${address.slice(0, 4)}…${address.slice(-4)}`;
/** Polls `probe` until it returns something truthy; resolves with that, or false after `timeout`. */
async function until(probe, timeout = 15_000) {
  for (const deadline = Date.now() + timeout; ; await sleep(250)) {
    const value = await Promise.resolve().then(probe).catch(() => false);
    if (value || Date.now() > deadline) return value || false;
  }
}

let log = console.log;
/** The run's browser, page and wallet; set by `start`. */
let session = null;
const results = [];
function check(passed, what) {
  results.push(Boolean(passed));
  log(passed ? "PASS" : "FAIL", what);
  return Boolean(passed);
}

/** A browser with the wallets set up, and the app open on its entry page. */
async function start(wallets = [walletName]) {
  const browser = await launch({ wallets, profile: `matrix-${walletName}-${caseName}`, run: `matrix-${walletName}-${caseName}`, fresh: true, headless: process.env.HEADED !== "1" });
  log = browser.log;
  const accounts = {};
  for (const name of wallets) accounts[name] = await DRIVERS[name].setUp(browser);
  const page = await browser.context.newPage();
  const calls = await traceWalletCalls(page, browser.log);
  await openApp(page);
  session = { browser, page, calls, account: accounts[walletName] };
  return session;
}

/** Waits for the wallet to ask the user something and answers it. Resolves with the request, or null when it asks nothing. */
async function answer(s, action = "approve", { kind, timeout = 20_000 } = {}) {
  const request = await driver.pendingRequest(s.browser, { timeout });
  const asksFor = { connect: "the connection", unlock: "its password", message: "the signature of the login message", transaction: "the signature of the transaction" };
  if (kind) check(request?.kind === kind, `${driver.label} asks for ${asksFor[kind]}${request ? ` (in its ${request.where}${request.kind === kind ? "" : `, as "${request.kind}"`})` : ""}`);
  if (!request) return null;
  log("wallet-ui", `${request.where} ${request.kind}: ${oneLine(await request.text()).slice(0, 100)}`);
  await request[action]();
  return request;
}

/**
 * Approves whatever the wallet asks until the app is logged in. When the wallet shows nothing, the
 * user does what the app says: click the wallet's icon and answer what it then shows, and after a
 * failure press Try again.
 */
async function approveUntilLoggedIn(s) {
  for (let asked = 0; asked < 8 && !(await waitForLogin(s.page, 1_500)); asked++) {
    if (await answer(s, "approve", { timeout: 8_000 })) continue;
    const tab = await driver.open(s.browser);
    const answered = await answer(s, "approve", { timeout: 6_000 });
    await tab.close().catch(() => {});
    await s.page.bringToFront();
    if (!answered && (await loginStep(s.page)) === "failed") await loginDialog(s.page).getByRole("button", { name: "Try again" }).click();
  }
  return waitForLogin(s.page, 30_000);
}

const says = (page, read, words, timeout) => until(async () => (await read(page)).includes(words), timeout);
const calledFor = (s, feature) => s.calls.filter((call) => call.feature === feature && call.phase === "called").length;

/** Opens the login dialog, picks the wallet and approves what it asks. */
async function logIn(s) {
  await openLogin(s.page);
  await pickWallet(s.page, driver.label);
  return approveUntilLoggedIn(s);
}

/** Row 1: pick the wallet, approve the connection, approve the signature. */
async function firstLogin(s, where) {
  const { page } = s;
  if ((await loginText(page)) === "") await openLogin(page);
  check((await listedWallets(page)).includes(driver.label), `the login dialog lists ${driver.label}`);
  await pickWallet(page, driver.label);
  check(await says(page, waitingText, `Approve the connection in ${driver.label}`), "the app says it waits for the connection, and names the wallet");
  const connect = await answer(s, "approve", { kind: "connect" });
  if (where) check(connect?.where === where, `the wallet shows the request in its ${where}`);
  check(await says(page, waitingText, `Approve the signature in ${driver.label}`), "the app says it waits for the signature, and names the wallet");
  await s.browser.shoot(page, "app-waits-for-the-signature");
  await answer(s, "approve", { kind: "message" });
  check(await waitForLogin(page), "logged in");
  check(await says(page, (p) => p.locator("header").first().innerText(), short(s.account.address), 30_000), "the top bar shows the wallet's address");
  check((await loginText(page)) === "", "the login dialog is closed");
}

/** A declined request: the dialog says so and Try again leads to a login. */
async function declined(s, words) {
  const { page } = s;
  check(await until(async () => (await loginStep(page)) === "failed"), "the login stops instead of waiting");
  check((await loginText(page)).includes(words), `it says "${words}"`);
  await s.browser.shoot(page, "app-after-declining");
  await loginDialog(page).getByRole("button", { name: "Try again" }).click();
  check(await approveUntilLoggedIn(s), "Try again leads to a login");
}

async function upToTheSignature(s) {
  await openLogin(s.page);
  await pickWallet(s.page, driver.label);
  await answer(s, "approve", { kind: "connect" });
}

// ---- The live stack: funds, orders, redemption -------------------------------------------------

const header = (page) => page.locator("header").first();
/** The test-dollar balance in the navbar, the only dollar amount in it: "$1,000.00", or "" while it is not shown. */
const dollars = async (page) => /\$[\d,]+\.\d\d/.exec(await header(page).innerText())?.[0] ?? "";
const ticket = (page) => page.locator('[data-testid="ticket"]');
const placeButton = (page) => ticket(page).locator('[data-testid="place"]');
const quantity = (page) => ticket(page).locator('[data-testid="ticket-quantity"]');

/**
 * Approves the transaction the app is waiting for, checking that the app says what it waits for.
 * A wallet that could not preview the transaction is pressed through its warning: the wallet here
 * is a throwaway with devnet test funds only (see `confirmUnsimulated` in lib/phantom.mjs).
 */
async function sign(s, what) {
  if (!check(await says(s.page, waitingText, `Approve the transaction in ${driver.label}`, 30_000), `the app says it waits for ${driver.label} to sign ${what}`)) {
    // Whatever stopped the app before it asked the wallet is said where the action was started.
    log("app", oneLine(await s.page.locator("main").innerText()).slice(-260));
  }
  await s.browser.shoot(s.page, `app-waits-for-${what.replace(/\s+/g, "-")}`);
  const request = await driver.pendingRequest(s.browser, { timeout: 30_000 });
  if (!check(request?.kind === "transaction", `${driver.label} asks for the signature of the transaction${request ? ` (in its ${request.where})` : ""}`)) return;
  await approveTransaction(s, request);
}

/** Approves a transaction request; one the wallet could not preview is pressed through its warning. */
async function approveTransaction(s, request) {
  log("wallet-ui", `${request.approvable ? "previewed" : "NOT previewed"}: ${oneLine(await request.text()).slice(0, 140)}`);
  if (request.approvable) await request.approve();
  else await driver.confirmUnsimulated(s.browser);
}

/** Row 10: a new wallet's trade panel offers Get test funds in place of the order button. */
async function getFunds(s) {
  const { page } = s;
  if (!check(await openTicket(s), "a market's trade panel is open")) return;
  const funds = ticket(page).locator('[data-testid="get-test-funds"]');
  if (!check(await until(() => funds.isVisible(), 90_000), "the trade panel of a new wallet offers Get test funds")) return;
  await funds.click();
  const refused = ticket(page).getByText("Test funds were not sent", { exact: true });
  await until(async () => (await placeButton(page).isVisible()) || (await refused.isVisible()), 150_000);
  if (!check(await placeButton(page).isVisible(), "Get test funds registers the wallet and sends funds: the panel offers the order")) log("app", oneLine(await ticket(page).innerText()).slice(-260));
  check(await until(async () => /^\$[1-9]/.test(await dollars(page)), 90_000), `test dollars arrive in the wallet (${await dollars(page)})`);
  await s.browser.shoot(page, "funded");
}

/**
 * Opens the ticket of a market that takes orders on `side`: the market at `marketUrl`, or else the
 * first one in the list, waiting for a new market window if none takes orders.
 */
async function openTicket(s, side = "YES", marketUrl = null) {
  const { page } = s;
  if (marketUrl) {
    const url = new URL(marketUrl);
    url.searchParams.set("side", side.toLowerCase());
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
  } else {
    // A card's price button: "Yes 57 cents, buy …".
    const buy = page.locator('[data-testid="event-card"]').getByRole("link", { name: new RegExp(`^${side === "NO" ? "No" : "Yes"}\\b`) }).first();
    // The simulated venue's 15-minute events last one window (MARKET_WINDOW_SECS) and start on multiples of it.
    await page.goto(`${BASE}/${MARKETS}`, { waitUntil: "domcontentloaded" });
    if (!(await until(() => buy.isVisible(), 240_000))) return false;
    await buy.click();
    await page.waitForURL(/\/markets\/.+/);
  }
  if (!(await until(() => ticket(page).isVisible(), 120_000))) return false;
  const again = page.locator('[data-testid="place-another"]');
  if (await until(() => again.isVisible(), 3_000)) await again.click();
  return true;
}

/** Rows 5 and 11: one order, signed in the wallet. Resolves with FILLED, REFUNDED or null. */
async function placeOrder(s, what, side = "YES", marketUrl = null) {
  const { page } = s;
  if (!check((await openTicket(s, side, marketUrl)) && (await until(() => placeButton(page).isEnabled(), 15_000)), `a market takes ${side} orders`)) return null;
  await quantity(page).fill("1.00");
  await placeButton(page).click();
  await sign(s, what);
  const stamp = await until(async () => {
    const shown = await page.locator('[data-testid="order-slip"]').first().getAttribute("data-stamp", { timeout: 2_000 });
    return (shown === "FILLED" || shown === "REFUNDED") && shown;
  }, 180_000);
  check(stamp, `${what} reaches ${stamp || "neither FILLED nor REFUNDED"}`);
  await s.browser.shoot(page, `${what.replace(/\s+/g, "-")}-${stamp}`);
  return stamp || null;
}

/**
 * Row 5 with Phantom's Testnet Mode off: Phantom cannot preview a devnet transaction and blocks it
 * behind two "unsafe" confirmations. The app names the setting, and Cancel ends the wait.
 */
async function namesTestnetMode(s) {
  const { page } = s;
  if (!check(await openTicket(s), "a market takes orders")) return;
  await quantity(page).fill("1.00");
  await placeButton(page).click();
  check(await says(page, waitingText, "Phantom previews a devnet transaction only with its Testnet Mode on (Settings, Developer Settings)", 30_000), "while it waits, the app names the setting: Testnet Mode");
  const request = await driver.pendingRequest(s.browser, { timeout: 30_000 });
  check(request?.kind === "transaction" && !request.approvable && /Failed to simulate/.test(await request.text()), "with Testnet Mode off, Phantom has no preview and calls the transaction unsafe");
  await s.browser.shoot(page, "app-names-testnet-mode");
  await waiting(page).getByRole("button", { name: "Cancel" }).click();
  check(await says(page, (p) => ticket(p).innerText(), "The wallet did not sign. Nothing was sent.", 15_000), "Cancel ends the wait: nothing was signed or sent");
  await request?.reject();
}

/** Rows 5 and 11 for a wallet that confirms mainnet transactions only: a plain refusal, and no request it cannot answer. */
async function refusesToTrade(s) {
  const { page } = s;
  if (!check(await openTicket(s), "a market takes orders")) return;
  await quantity(page).fill("1.00");
  await placeButton(page).click();
  const refusal = `${driver.label} confirms Solana mainnet transactions only, so it cannot sign in this devnet demo. Log out, then log in with another wallet or with email to trade.`;
  check(await says(page, (p) => ticket(p).innerText(), refusal, 30_000), `the ticket says: ${refusal}`);
  check(calledFor(s, "solana:signTransaction") === 0, `${driver.label} is not asked for a signature it cannot give`);
  await s.browser.shoot(page, "ticket-refuses-a-mainnet-only-wallet");
}

/** Row 8: the user switches account inside the wallet while on a ticket. */
async function switchAccount(s) {
  const { page, browser } = s;
  if (!check(await openTicket(s), "a ticket is open")) return;
  await placeButton(page).waitFor({ timeout: 60_000 });
  const signaturesBefore = calledFor(s, "solana:signTransaction");
  const second = await driver.addAccount(browser);
  await driver.switchAccount(browser, second.address);
  await page.bringToFront();
  const reconnect = ticket(page).locator('[data-testid="reconnect"]');
  if (!(await until(async () => (await placeButton(page).count()) === 0, 8_000))) {
    // This wallet keeps a site on the account that connected, whichever account its own pages show.
    check((await header(page).innerText()).includes(short(s.account.address)), `${driver.label} keeps the site on the account that logged in: the app still trades with ${short(s.account.address)}`);
  } else {
    const switchBack = `Switch back to ${short(s.account.address)} in the wallet, or log out and log in with the new account.`;
    if (!(await says(page, (p) => ticket(p).innerText(), switchBack, 5_000))) {
      // The wallet reported no account at all: Reconnect wallet finds out which one it is on.
      await reconnect.click();
      await answer(s, "approve", { timeout: 8_000 });
    }
    check(await says(page, (p) => ticket(p).innerText(), switchBack, 20_000), `the ticket says: ${switchBack}`);
  }
  await browser.shoot(page, "ticket-after-the-account-switch");
  check(calledFor(s, "solana:signTransaction") === signaturesBefore, "the other account is never asked to sign");
  await driver.switchAccount(browser, s.account.address);
  await page.bringToFront();
  if (await until(() => reconnect.isVisible(), 5_000)) {
    await reconnect.click();
    await answer(s, "approve", { timeout: 5_000 });
  }
  check(await until(() => placeButton(page).isVisible(), 30_000), "back on the trading account, the ticket offers Place order");
}

/**
 * Row 9: after a reload the user is still logged in. The wallet is then either not connected, and
 * the ticket offers Reconnect wallet, or it has restored a trusted site's connection by itself
 * (Phantom does) and the ticket offers the order at once.
 */
async function reloadAndReconnect(s) {
  const { page } = s;
  if (!check(await openTicket(s), "a ticket is open")) return;
  await page.reload({ waitUntil: "domcontentloaded" });
  const reconnect = ticket(page).locator('[data-testid="reconnect"]');
  await ticket(page).waitFor({ timeout: 120_000 });
  await sleep(6_000);
  const offered = await until(async () => ((await reconnect.isVisible()) ? "Reconnect wallet" : (await placeButton(page).isVisible()) && "Place order"), 90_000);
  if (!check(offered, `after a reload the ticket offers ${offered || "neither Reconnect wallet nor Place order"}`)) return;
  if (offered === "Reconnect wallet") {
    await reconnect.click();
    const asked = await answer(s, "approve", { timeout: 6_000 });
    log("step", asked ? `the wallet asked again (${asked.kind})` : "the wallet reconnected without asking (the site is trusted)");
    check(await until(() => placeButton(page).isVisible(), 30_000), "after Reconnect wallet the ticket offers Place order");
  } else {
    log("step", "the wallet restored the connection by itself: no Reconnect wallet was needed");
  }
}

/** The relayer's view of the contract an event page at `url` shows (its `c` parameter). */
async function contractAt(url) {
  const { events } = await (await fetch(`${RELAYER}/events`)).json();
  return events.flatMap((event) => event.markets).find((market) => market.symbol === new URL(url).searchParams.get("c"));
}

/**
 * Row 12: a market the wallet holds both sides of settles; the winning side is redeemed on the
 * portfolio. `marketUrl` is the market's event page: the wait follows its close.
 */
async function redeem(s, marketUrl) {
  const { page } = s;
  const market = await contractAt(marketUrl);
  log("step", `${market.symbol} closes at ${new Date(market.expiresAt).toISOString()}`);
  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
  const action = page.locator('[data-testid="position-redeem"]').first();
  const settles = Math.max(market.expiresAt + 150_000 - Date.now(), 60_000);
  if (!check(await until(() => action.isVisible(), settles), "once the market settles, the portfolio offers Redeem")) return;
  const balance = () => page.locator('[data-testid="portfolio-balance"]').innerText();
  const before = await balance();
  // A redemption is listed under Settled with its transaction.
  const receipts = page.locator('[data-testid="redemption-tx"]');
  const receiptsBefore = await receipts.count();
  await action.click();
  await sign(s, "the redemption");
  check(await until(() => receipts.nth(receiptsBefore).isVisible(), 120_000), "the redemption is confirmed and listed with its transaction");
  check(await until(async () => (await balance()) !== before, 60_000), `the test dollars arrive (${before} -> ${await balance()})`);
  await s.browser.shoot(page, "redeemed");
}

const CASES = {
  async "first-login"() {
    await firstLogin(await start(), walletName === "phantom" ? "window" : "panel");
  },

  async "side-panel"() {
    const s = await start();
    await driver.openSidePanel(s.browser);
    await s.page.bringToFront();
    await firstLogin(s, "panel");
  },

  async "reject-connect"() {
    const s = await start();
    await openLogin(s.page);
    await pickWallet(s.page, driver.label);
    await answer(s, "reject", { kind: "connect" });
    await declined(s, `You declined the connection in ${driver.label}.`);
  },

  async "reject-sign"() {
    const s = await start();
    await upToTheSignature(s);
    await answer(s, "reject", { kind: "message" });
    await declined(s, `You declined the signature in ${driver.label}.`);
  },

  async "close-window"() {
    const s = await start();
    await upToTheSignature(s);
    const request = await answer(s, "dismiss", { kind: "message" });
    check(request?.where === "window", "the request was in a window of the wallet, which the user closed");
    await declined(s, `You declined the signature in ${driver.label}.`);
  },

  async "no-answer"() {
    const s = await start();
    const { page } = s;
    await driver.openSidePanel(s.browser);
    await page.bringToFront();
    await upToTheSignature(s);
    const request = await answer(s, "dismiss", { kind: "message" });
    check(request?.where === "panel", "the request was in the wallet's side panel, which the user closed");
    const outcome = await until(async () => ((await loginStep(page)) === "failed" ? "declined" : (await waitingSlow(page)) && "slow"), 40_000);
    if (outcome === "declined") {
      // This wallet answers for a closed panel: the dialog says so at once.
      await declined(s, `You declined the signature in ${driver.label}.`);
      return;
    }
    check(outcome === "slow" && (await waitingText(page)).startsWith(`Still waiting for ${driver.label}`), `after about 20 s the app says "Still waiting for ${driver.label}"`);
    await s.browser.shoot(page, "app-still-waiting");
    const asked = calledFor(s, "solana:signMessage");
    await waiting(page).getByRole("button", { name: "Try again" }).click();
    check(await until(() => calledFor(s, "solana:signMessage") === asked + 1), "Try again asks the wallet once more");
    check(!(await waitingSlow(page)), "and the wait starts over");
    // A wallet whose panel was closed on a request shows nothing for the next one either.
    check(await says(page, waitingText, `Still nothing from ${driver.label}`, 40_000), `the wallet stays silent, and the app says "Still nothing from ${driver.label}" and to reload the page`);
    await s.browser.shoot(page, "app-says-to-reload");
    await waiting(page).getByRole("button", { name: "Cancel" }).click();
    check(await until(async () => (await loginStep(page)) === "choose"), "Cancel goes back to the list of ways to log in");
    await pickWallet(page, driver.label);
    check(await says(page, waitingText, `Still nothing from ${driver.label}`, 40_000), "a new attempt in the same page is told the same, sooner");
    await Promise.all([page.waitForEvent("load"), waiting(page).getByRole("button", { name: "Reload page" }).click()]);
    await page.locator('[data-testid="login-top"]:not([disabled])').waitFor({ timeout: 60_000 });
    check(await logIn(s), "after Reload page, the login succeeds");
  },

  async locked() {
    const s = await start();
    const { page } = s;
    await driver.lock(s.browser);
    await page.bringToFront();
    await openLogin(page);
    await pickWallet(page, driver.label);
    check(await says(page, waitingText, `Approve the connection in ${driver.label}`), "the app says which wallet it waits for");
    const locked = await answer(s, "dismiss", { kind: "unlock" });
    await s.browser.shoot(page, "app-while-the-wallet-is-locked");
    if (locked?.where === "panel") {
      await waiting(page).getByRole("button", { name: "Cancel" }).click();
      check(await until(async () => (await loginStep(page)) === "choose"), "Cancel works while the wallet is locked");
    } else {
      // Closing the wallet's own window is an answer: the wallet reports a refusal.
      check(await until(async () => (await loginStep(page)) === "failed"), "closing the locked wallet's window ends the wait with a message");
      await loginDialog(page).getByRole("button", { name: "Back" }).click();
    }
    await pickWallet(page, driver.label);
    if ((await driver.pendingRequest(s.browser, { timeout: 8_000 }))?.kind !== "unlock") {
      // The wallet still holds the first request and refuses a second one.
      const busy = `${driver.label} is still showing an earlier request. Click the ${driver.label} icon in the browser toolbar, answer or cancel it there, then try again.`;
      check((await loginText(page)).includes(busy), `the wallet refuses a second request, and the app says: ${busy}`);
      await s.browser.shoot(page, "app-while-the-wallet-holds-an-earlier-request");
    }
    await driver.unlock(s.browser, s.account.password);
    check(await approveUntilLoggedIn(s), "after unlocking, the login completes");
  },

  async relogin() {
    const s = await start();
    await firstLogin(s);
    await logOut(s.page);
    check(await logIn(s), "logged in again after logging out");
  },

  async "two-wallets"() {
    const other = walletName === "phantom" ? metamask : phantom;
    const s = await start([walletName, other.name]);
    /** Which wallet's side panel is open, and whether it is the one the window draws (meaningful in a visible window). */
    const panels = async (when) => {
      for (const [label, url] of [[phantom.label, phantomPanel(s.browser)], [metamask.label, metamaskPanel(s.browser)]]) {
        const panel = await attachSidePanel(s.page, url);
        log("panels", `${when}: ${label} ${panel ? `side panel open, ${await panel.visibility()}` : "has no side panel open"}`);
        await panel?.detach();
      }
    };
    await other.openSidePanel(s.browser);
    await s.page.bringToFront();
    await panels(`with ${other.label}'s side panel opened`);
    await openLogin(s.page);
    const listed = await listedWallets(s.page);
    check(listed.includes(phantom.label) && listed.includes(metamask.label), `the login dialog lists both wallets by name (${listed.join(", ")})`);
    await firstLogin(s);
    check(s.calls.every((call) => call.phase === "registered" || call.phase === "event" || call.wallet === driver.label), `only ${driver.label} was asked`);
    check((await other.pendingRequest(s.browser, { timeout: 2_000 })) === null, `${other.label} shows no request`);
    await panels("after the login");
  },

  async live() {
    const s = await start();
    check(await logIn(s), "logged in");
    await getFunds(s);
    if (cannotTrade) {
      await refusesToTrade(s);
      await switchAccount(s);
      await reloadAndReconnect(s);
      return;
    }
    // Rows 5 and 11. Phantom starts with Testnet Mode off and then blocks a devnet transaction.
    await namesTestnetMode(s);
    await driver.setTestnetMode(s.browser, true);
    await s.page.bringToFront();
    await placeOrder(s, "an order with Testnet Mode on");
    // Row 8 is not run with Phantom here: its service refuses the test browser the call that adds
    // a second account. The app's side of it is covered by e2e/live-reconnect.mjs.
    await reloadAndReconnect(s);
    // Row 12: both sides of one market, so that one of them wins.
    let both = false;
    const simulated = (await (await fetch(`${RELAYER}/health`)).json()).venue === "mock";
    for (let round = 0; round < 3 && !both; round++) {
      // On the simulated venue both orders have to fit into one market's window: start at the beginning of one.
      const left = MARKET_WINDOW_SECS - ((Date.now() / 1000) % MARKET_WINDOW_SECS);
      if (simulated && left < MARKET_WINDOW_SECS - 30) await sleep((left + 8) * 1000);
      if ((await placeOrder(s, "a YES order to hold")) !== "FILLED") continue;
      both = (await placeOrder(s, "a NO order in the same market", "NO", s.page.url())) === "FILLED";
    }
    if (check(both, "the wallet holds both sides of one market")) await redeem(s, s.page.url());
  },

  async reclaim() {
    const s = await start();
    const { page } = s;
    check(await logIn(s), "logged in");
    await getFunds(s);
    const funded = await dollars(page);
    await driver.setTestnetMode?.(s.browser, true);
    await page.bringToFront();
    if (!check(await openTicket(s), "a market takes orders")) return;
    await quantity(page).fill("1.00");
    await placeButton(page).click();
    const request = await driver.pendingRequest(s.browser, { timeout: 30_000 });
    if (!check(request?.kind === "transaction", "the wallet asks for the order's signature")) return;
    // The order must find nobody to fill it: it is signed only once the relayer is stopped.
    console.log("READY: stop the relayer now");
    if (!check(await until(() => fetch(`${RELAYER}/health`).then(() => false, () => true), 55_000), "the relayer is stopped")) return;
    await approveTransaction(s, request);
    await page.goto(`${BASE}/activity`, { waitUntil: "domcontentloaded" });
    // The page stamps the order EXPIRED once its deadline has passed on the cluster's clock; its steps then offer Reclaim.
    const expired = page.locator('[data-testid="activity-order"][data-stamp="EXPIRED"]');
    check(await until(() => expired.first().isVisible(), 240_000), "the order is listed and expires at its deadline");
    await page.locator('[data-testid="activity-steps"]').getByRole("button", { name: /^Reclaim/ }).first().click();
    await sign(s, "the reclaim");
    check(await until(async () => (await expired.count()) === 0, 120_000), "the order is reclaimed");
    check(await until(async () => (await dollars(page)) === funded, 60_000), `the test dollars are back in the top bar (${funded}; now ${await dollars(page)})`);
    await s.browser.shoot(page, "reclaimed");
  },
};

if (!driver || !CASES[caseName]) throw new Error(`usage: matrix.mjs <${Object.keys(DRIVERS).join("|")}> <${Object.keys(CASES).join("|")}>`);
try {
  await CASES[caseName]();
} catch (error) {
  check(false, `the run broke off: ${String(error).split("\n")[0]}`);
  for (const page of session?.browser.context.pages() ?? []) await session.browser.shoot(page, "broke-off");
} finally {
  await session?.browser.close();
}
const failed = results.filter((passed) => !passed).length;
console.log(`\n${walletName} ${caseName}: ${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
