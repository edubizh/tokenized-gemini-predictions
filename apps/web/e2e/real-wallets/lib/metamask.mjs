// MetaMask in the test browser: first-run set-up of a new, empty wallet, its side panel, and a
// driver (`metamask`) with the same functions as the other wallets' drivers. MetaMask guards its
// pages against scripts reading their globals, so everything here goes through locators (never
// page.evaluate).
import { randomBytes } from "node:crypto";
import { attachSidePanel, panelGone, panelShowing, unlockWith, waitForRequest, windowSurface } from "./side-panel.mjs";

const base = (browser) => `chrome-extension://${browser.extension("metamask").id}`;

/**
 * Takes a newly installed MetaMask through its own "Create a new wallet" flow. The wallet gets a
 * Solana account beside its Ethereum one by default. The recovery phrase is never revealed or read
 * ("Remind me later"), and both usage-data options are switched off. Returns the wallet's password.
 */
export async function setUpMetaMask(browser) {
  const home = `${base(browser)}/home.html`;
  // MetaMask opens its first-run page by itself a moment after it is installed.
  const page =
    browser.context.pages().find((candidate) => candidate.url().startsWith(home)) ??
    (await browser.context.waitForEvent("page", { predicate: (candidate) => candidate.url().startsWith(home), timeout: 15_000 }).catch(() => null)) ??
    (await browser.context.newPage());
  if (!page.url().startsWith(home)) await page.goto(home);
  const password = `${randomBytes(12).toString("base64url")}!`;

  await page.getByTestId("onboarding-create-wallet").click();
  await page.getByTestId("onboarding-create-with-srp-button").click();
  await page.getByTestId("create-password-new-input").fill(password);
  await page.getByTestId("create-password-confirm-input").fill(password);
  await page.locator("input[type=checkbox]").check({ force: true });
  await page.getByTestId("create-password-submit").click();
  await page.getByTestId("passkey-maybe-later-button").click();
  await page.getByTestId("recovery-phrase-remind-later").click();
  await page.getByTestId("metametrics-i-agree").waitFor();
  for (const box of await page.locator("input[type=checkbox]").all()) await box.uncheck({ force: true });
  await page.getByTestId("metametrics-i-agree").click();
  // "Open wallet" finishes the first run. It then tries to open the browser's side panel, which
  // this page does not need to wait for.
  await page.getByTestId("onboarding-complete-done").click();
  await page.waitForTimeout(1_500);
  await page.close();
  browser.log("wallet", "MetaMask wallet created (Ethereum and Solana accounts)");
  return { password };
}

/** Matches the address of MetaMask's side panel, which is where it shows a site's requests. */
export const panelUrl = (browser) => new RegExp(`^${base(browser)}/sidepanel\\.html`);

/** The buttons of a request shown in MetaMask's side panel, for `attachSidePanel(...).click()`. */
export const PANEL_APPROVE = '[data-testid="confirm-btn"], [data-testid$="-confirm-snap-footer-button"]';
export const PANEL_REJECT = '[data-testid="cancel-btn"], [data-testid$="-cancel-snap-footer-button"]';

const UNLOCK_INPUT = '[data-testid="unlock-password"]';
const UNLOCK_SUBMIT = '[data-testid="unlock-submit"]';
const ACCOUNT = '[data-testid^="multichain-account-cell-entropy"]';

/** Opens one of the wallet's own pages in a tab: `home.html` (full page) or `popup.html`. */
export async function openMetaMask(browser, file = "home.html") {
  const page = await browser.context.newPage();
  await page.goto(`${base(browser)}/${file}`);
  return page;
}

/** Runs `steps` on the wallet's own page in a tab of its own, then closes the tab. */
async function onOwnPage(browser, steps, file) {
  const page = await openMetaMask(browser, file);
  try {
    return await steps(page);
  } catch (error) {
    // What the wallet was showing says more than the name of the control that was not found.
    error.message = `${String(error.message).split("\n")[0]} (the wallet's page shows: ${(await windowSurface(page).text()).slice(0, 160)})`;
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

/** The open side panel, or null. */
const panelOf = async (browser) => {
  const anyPage = browser.context.pages()[0];
  return anyPage ? attachSidePanel(anyPage, panelUrl(browser)) : null;
};

/**
 * Where MetaMask can be showing a request right now: its side panel, and any tab of its own that
 * is open (it opens no window for a request, and shows a waiting request in whichever of its
 * pages is open).
 */
async function surfaces(browser) {
  const tabs = browser.context.pages().filter((page) => page.url().startsWith(base(browser))).map(windowSurface);
  const panel = await panelOf(browser);
  return panel ? [panel, ...tabs] : tabs;
}

/**
 * Names what a surface shows, from its address: `#/unlock`, `#/connect/<id>`, `#/confirmation/<id>`.
 * A request counts only while its buttons are there: once it is answered the address stays for a
 * moment on a "Connecting" screen.
 */
async function read(surface) {
  const url = await surface.url();
  if (/#\/unlock/.test(url)) return (await surface.has(UNLOCK_INPUT)) ? { kind: "unlock", why: "an unlock form is answered with unlock()" } : null;
  if (!/#\/(connect|confirmation|confirm-transaction)\//.test(url) || !(await surface.has(PANEL_APPROVE))) return null;
  // A signature request is told apart by its buttons: its title is the same for a message and for
  // a transaction until the simulation result arrives.
  const kind = /#\/connect\//.test(url) ? "connect" : (await surface.has('[data-testid*="sign-message"]')) ? "message" : (await surface.has('[data-testid*="transaction"]')) ? "transaction" : "other";
  return { kind, approve: PANEL_APPROVE, reject: PANEL_REJECT };
}

/** Opens the account list on the wallet's full page, the way its header does. */
async function openAccounts(browser, page) {
  await page.goto(`${base(browser)}/home.html#/`);
  await page.getByTestId("account-menu-icon").click();
  await page.locator(ACCOUNT).first().waitFor();
}

/**
 * The Solana address of the account at `index` in the account list. The list shows shortened
 * addresses; the full one is on the account's Addresses page, behind the row's QR button.
 */
async function solanaAddress(browser, page, index) {
  await openAccounts(browser, page);
  await page.getByTestId("multichain-account-cell-end-accessory").nth(index).click();
  await page.getByTestId("multichain-account-menu-item-addresses").click();
  await page.locator('[data-testid="multichain-address-row"]', { hasText: "Solana" }).first().getByTestId("multichain-address-row-qr-button").click();
  return (await page.getByTestId("account-address").innerText()).replace(/\s+/g, "");
}

/** MetaMask behind the functions every wallet driver has (see check-drivers.mjs for their use). */
export const metamask = {
  name: "metamask",
  label: "MetaMask",

  /** First-run set-up; the Solana address of the new wallet's account is read from its own pages. */
  async setUp(browser) {
    const { password } = await setUpMetaMask(browser);
    const address = await onOwnPage(browser, (page) => solanaAddress(browser, page, 0));
    browser.log("wallet", `MetaMask Solana account ${address}`);
    return { address, password };
  },

  /**
   * Waits until MetaMask shows something that needs the user, in its side panel or in a tab of
   * its own: `{ where, kind, text(), approve(), reject(), dismiss() }`, or null on timeout.
   */
  pendingRequest: (browser, { timeout = 15_000 } = {}) => waitForRequest({ surfaces: () => surfaces(browser), read, closePanel: () => metamask.closeSidePanel(browser), timeout }),

  /** Types the password into the unlock form: in the side panel, or on the wallet's own page. */
  unlock: (browser, password) => unlockWith({ surfaces: () => surfaces(browser), open: () => openMetaMask(browser), input: UNLOCK_INPUT, submit: UNLOCK_SUBMIT, password }),

  /** Locks the wallet through its menu. */
  lock: (browser) =>
    onOwnPage(browser, async (page) => {
      await page.getByTestId("account-options-menu-button").click();
      await page.getByTestId("global-menu-lock").click();
      await page.locator(UNLOCK_INPUT).waitFor();
      // An open side panel shows the form a moment later, and `unlock` has to find it there: a
      // panel left on the form stays on it when the wallet is unlocked from another page.
      if (await metamask.sidePanelOpen(browser)) await panelShowing(() => panelOf(browser), UNLOCK_INPUT);
    }),

  /** Adds an account with the wallet's own "Add account" (one more of each chain) and returns its Solana address. */
  addAccount: (browser) =>
    onOwnPage(browser, async (page) => {
      await openAccounts(browser, page);
      const before = await page.locator(ACCOUNT).count();
      // The button does nothing while the wallet is still syncing its accounts: press it again
      // until the new account is listed.
      for (let attempt = 0; attempt < 4 && (await page.locator(ACCOUNT).count()) === before; attempt++) {
        await page.getByTestId("add-multichain-account-button").click();
        await page.locator(ACCOUNT).nth(before).waitFor({ timeout: 8_000 }).catch(() => {});
      }
      if ((await page.locator(ACCOUNT).count()) === before) throw new Error("MetaMask did not add an account");
      const address = await solanaAddress(browser, page, before);
      browser.log("wallet", `MetaMask Solana account ${address} added`);
      return { address };
    }),

  /** Makes the account with this Solana address the active one: the account list is searched for it, and its row is clicked. */
  switchAccount: (browser, address) =>
    onOwnPage(browser, async (page) => {
      await openAccounts(browser, page);
      for (let index = 0, count = await page.locator(ACCOUNT).count(); index < count; index++) {
        if ((await solanaAddress(browser, page, index)) !== address) continue;
        await openAccounts(browser, page);
        await page.locator(ACCOUNT).nth(index).click();
        await page.locator(ACCOUNT).first().waitFor({ state: "detached" });
        return;
      }
      throw new Error(`MetaMask has no account with the Solana address ${address}`);
    }),

  /** Opens the wallet's own page (what the toolbar icon shows) in a tab; a waiting request shows there. */
  open: (browser) => openMetaMask(browser, "popup.html"),

  async sidePanelOpen(browser) {
    const panel = await panelOf(browser);
    await panel?.detach();
    return Boolean(panel);
  },
  /**
   * Opens the side panel unless it is open already, with the "Switch to side panel" entry of the
   * popup's menu, which closes the tab it is clicked in. The wallet has to be unlocked and idle.
   */
  async openSidePanel(browser) {
    if (await metamask.sidePanelOpen(browser)) return;
    const page = await openMetaMask(browser, "popup.html");
    try {
      await page.getByTestId("account-options-menu-button").click({ timeout: 10_000 });
      await Promise.all([page.waitForEvent("close", { timeout: 15_000 }), page.getByTestId("global-menu-toggle-view").click()]);
    } catch (error) {
      // With a request waiting (or the wallet locked) the page shows that instead of its menu.
      await page.close().catch(() => {});
      throw new Error(`MetaMask's menu could not be used to open the side panel: ${String(error.message).split("\n")[0]}`);
    }
    if (!(await panelShowing(() => panelOf(browser), '[data-testid="account-menu-icon"]'))) throw new Error("MetaMask's side panel did not open");
  },

  /**
   * Closes the side panel. MetaMask keeps a request that was waiting there: it does not answer the
   * site, and shows the request again the next time one of its pages is opened.
   */
  async closeSidePanel(browser) {
    const panel = await panelOf(browser);
    await panel?.close();
    await panel?.detach();
    await panelGone(() => panelOf(browser));
  },
};
