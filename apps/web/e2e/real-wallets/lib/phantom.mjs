// Phantom in the test browser: first-run set-up with a throwaway key, its request windows and side
// panel, and a driver (`phantom`) with the same functions as the other wallets' drivers.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { attachSidePanel, panelGone, panelShowing, unlockWith, waitForRequest, windowSurface } from "./side-panel.mjs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  for (; value > 0n; value /= 58n) text = ALPHABET[Number(value % 58n)] + text;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

const base = (browser) => `chrome-extension://${browser.extension("phantom").id}`;

/** The name each account was given in the wallet, by address: how an account is found again. */
const names = new Map();

/** A new key made here: the account's address, and the secret in the form Phantom imports. */
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const secret = Buffer.concat([privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32), publicBytes]);
  return { address: base58(publicBytes), secret: base58(secret) };
}

/**
 * Gives a newly installed Phantom one empty Solana account: a key generated here and imported
 * through the extension's own first-run page. Returns the account's address and the wallet's
 * password; the key itself is not kept anywhere.
 */
export async function setUpPhantom(browser) {
  const url = `${base(browser)}/onboarding.html`;
  // Phantom opens its first-run page by itself a moment after it is installed.
  const page =
    browser.context.pages().find((candidate) => candidate.url() === url) ??
    (await browser.context.waitForEvent("page", { predicate: (candidate) => candidate.url() === url, timeout: 15_000 }).catch(() => null)) ??
    (await browser.context.newPage());
  if (page.url() !== url) await page.goto(url);

  const key = newKey();
  // Phantom wants a special character in the password.
  const password = `${randomBytes(12).toString("base64url")}!`;

  await page.getByRole("button", { name: "I Already Have a Wallet" }).click();
  await page.getByText("Import Private Key").click();
  await page.getByPlaceholder("Name").fill("Test");
  await page.getByPlaceholder("Private key").fill(key.secret);
  await page.getByTestId("onboarding-form-submit-button").click();
  await page.getByTestId("onboarding-form-password-input").fill(password);
  await page.getByTestId("onboarding-form-confirm-password-input").fill(password);
  await page.getByTestId("onboarding-form-terms-of-service-checkbox").click();
  await page.getByTestId("onboarding-form-submit-button").click();
  // The wallet exists once the password is set. The next step asks for a public username, which
  // a test wallet has no use for, so the set-up stops here.
  await page.getByText("Choose a username").waitFor();
  await page.close();
  const wallet = { address: key.address, password };
  names.set(wallet.address, "Test");
  browser.log("wallet", `Phantom account ${wallet.address}`);
  return wallet;
}

/** Opens the wallet's own page (what the toolbar icon shows) in a tab. */
export async function openPhantom(browser) {
  const page = await browser.context.newPage();
  await page.goto(`${base(browser)}/popup.html`);
  return page;
}

/** Approves the request a Phantom window shows (Connect, or Confirm for a signature). */
export const approve = (window) => window.getByTestId("primary-button").click();

/** Declines the request a Phantom window shows (Cancel). */
export const reject = (window) => window.getByTestId("secondary-button").click();

/** What a Phantom window says, on one line. */
export const windowText = async (window) => (await window.locator("body").innerText()).replace(/\s+/g, " ").trim();

/** The buttons of a request shown in Phantom's side panel, for `attachSidePanel(...).click()`. */
export const PANEL_APPROVE = '[data-testid="primary-button"]';
export const PANEL_REJECT = '[data-testid="secondary-button"]';

/** Matches the address of Phantom's side panel. */
export const panelUrl = (browser) => new RegExp(`^${base(browser)}/popup\\.html`);

/**
 * Opens Phantom's side panel in the browser window, the way its "open in side panel" control does.
 * While the panel is open and the browser has one window, Phantom shows every request there and
 * opens no window of its own.
 */
export async function openSidePanel(browser) {
  const page = await openPhantom(browser);
  // The control opens the panel and closes the tab it was clicked in.
  await Promise.all([page.waitForEvent("close", { timeout: 15_000 }), page.getByTestId("side-panel-menu-open-button").click()]);
}

/** Closes Phantom's side panel, as the user does with the panel's close button. */
export async function closeSidePanel(browser) {
  const worker = browser.context.serviceWorkers().find((candidate) => candidate.url().startsWith(base(browser)));
  await worker.evaluate(async () => {
    for (const window of await chrome.windows.getAll()) await chrome.sidePanel.close({ windowId: window.id }).catch(() => {});
  });
}

const UNLOCK_INPUT = '[data-testid="unlock-form-password-input"]';
const UNLOCK_SUBMIT = '[data-testid="unlock-form-submit-button"]';

/** The open side panel, or null. */
const panelOf = async (browser) => {
  const anyPage = browser.context.pages()[0];
  return anyPage ? attachSidePanel(anyPage, panelUrl(browser)) : null;
};

/** Where Phantom can be showing a request right now: its request windows and its side panel. */
async function surfaces(browser) {
  const found = browser.windows
    .filter((entry) => entry.extension.name === "phantom" && !entry.page.isClosed() && entry.page.url().includes("/notification.html"))
    .map((entry) => windowSurface(entry.page));
  const panel = await panelOf(browser);
  return panel ? [...found, panel] : found;
}

/**
 * Names what a surface shows. In the side panel a request is drawn over the wallet's home screen,
 * and a locked wallet shows its unlock form there whether or not a site has asked.
 */
async function read(surface) {
  if (await surface.has(UNLOCK_INPUT)) return { kind: "unlock", why: "an unlock form is answered with unlock()" };
  const text = await surface.text();
  // Phantom sometimes puts its own notice of a policy update over a request; the user continues past it.
  if (/We've updated our (Privacy Policy|terms)/i.test(text)) {
    await surface.click(PANEL_APPROVE);
    return null;
  }
  // A transaction Phantom cannot simulate gets no Confirm button, only "Confirm (unsafe)" and then
  // a screen saying the request is blocked: `approve` does not press through that. A test that
  // needs the signature says so by calling `confirmUnsimulated`.
  const unsafe = /Confirm \(unsafe\)/.test(text);
  if (!unsafe && !(await surface.has(PANEL_APPROVE))) return null;
  const kind = /Only connect to websites you trust/.test(text) ? "connect" : /Sign Message|Sign In/.test(text) ? "message" : /transaction/i.test(text) ? "transaction" : null;
  // A request drawn over the side panel's home screen shows its buttons before its words: read it again.
  if (!kind) return null;
  return { kind, approve: unsafe ? null : PANEL_APPROVE, reject: PANEL_REJECT, why: 'Phantom could not simulate the request and offers only "Confirm (unsafe)", which approve() does not press' };
}

/** Runs `steps` on the wallet's own page in a tab of its own, then closes the tab. */
async function onOwnPage(browser, steps) {
  const page = await openPhantom(browser);
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

/** From the wallet's home screen to its Settings. */
async function openSettings(page) {
  await page.getByTestId("settings-menu-open-button").click();
  await page.getByTestId("sidebar_menu-button-settings").click();
}

/** Phantom behind the functions every wallet driver has (see check-drivers.mjs for their use). */
export const phantom = {
  name: "phantom",
  label: "Phantom",
  setUp: setUpPhantom,

  /**
   * Waits until Phantom shows something that needs the user, in a window of its own or in its
   * side panel: `{ where, kind, text(), approve(), reject(), dismiss() }`, or null on timeout.
   */
  pendingRequest: (browser, { timeout = 15_000 } = {}) => waitForRequest({ surfaces: () => surfaces(browser), read, closePanel: () => phantom.closeSidePanel(browser), timeout }),

  /** Types the password into the unlock form: in a request window, in the side panel, or on the wallet's own page. */
  unlock: (browser, password) => unlockWith({ surfaces: () => surfaces(browser), open: () => openPhantom(browser), input: UNLOCK_INPUT, submit: UNLOCK_SUBMIT, password }),

  /** Locks the wallet through Settings > Lock Wallet. */
  lock: (browser) =>
    onOwnPage(browser, async (page) => {
      await openSettings(page);
      await page.getByTestId("lock-menu-item").click();
      await page.locator(UNLOCK_INPUT).waitFor();
      // An open side panel shows the form a moment later, and `unlock` has to find it there: a
      // panel left on the form stays on it when the wallet is unlocked from another page.
      if (await phantom.sidePanelOpen(browser)) await panelShowing(() => panelOf(browser), UNLOCK_INPUT);
    }),

  /**
   * Imports one more key made here (Add Account > Import Private Key) and returns its address.
   * Phantom registers a new account with its own service before keeping it, and shows "Your
   * account wasn't added" when that call is refused: this then throws.
   */
  addAccount: (browser) =>
    onOwnPage(browser, async (page) => {
      const key = newKey();
      const name = `Test ${names.size + 1}`;
      await page.getByTestId("settings-menu-open-button").click();
      await page.getByTestId("sidebar_menu-button-add_account").click();
      await page.getByText("Import Private Key").click();
      await page.getByPlaceholder("Name").fill(name);
      await page.getByPlaceholder("Private key").fill(key.secret);
      await page.locator('button[type="submit"]').click();
      const refused = page.getByText("Your account wasn't added");
      await Promise.race([refused.waitFor(), page.getByPlaceholder("Private key").waitFor({ state: "detached" })]);
      if (await refused.count()) throw new Error("Phantom did not add the account: its service refused the call the wallet makes to register it");
      names.set(key.address, name);
      browser.log("wallet", `Phantom account ${key.address} added`);
      return { address: key.address };
    }),

  /** Makes the account with this address the active one, through the account menu. */
  switchAccount: (browser, address) =>
    onOwnPage(browser, async (page) => {
      const name = names.get(address);
      if (!name) throw new Error(`Phantom has no account ${address} added by this harness`);
      await page.getByTestId("settings-menu-open-button").click();
      await page.getByTestId("account-menu").locator("button", { hasText: new RegExp(`${name}$`) }).click();
      await page.getByTestId("home-header-account-name").filter({ hasText: new RegExp(`^${name}$`) }).waitFor();
    }),

  /** Opens the wallet's own page (what the toolbar icon shows) in a tab. */
  open: openPhantom,

  /**
   * Signs a transaction Phantom could not preview, shown in a request window. In this test browser
   * Phantom's own service refuses every call (HTTP 403), so Phantom previews nothing and puts
   * each transaction behind "Confirm (unsafe)", an acknowledgement and "Yes, confirm (unsafe)".
   * The wallet here is a throwaway that holds devnet test funds only, the one case in which
   * pressing through is harmless. Nobody should do this with a wallet of their own.
   */
  async confirmUnsimulated(browser) {
    const shown = browser.windows.findLast((entry) => entry.extension.name === "phantom" && !entry.page.isClosed() && entry.page.url().includes("/notification.html"));
    if (!shown) throw new Error("Phantom shows no request window");
    await shown.page.getByText("Confirm (unsafe)", { exact: true }).click();
    await shown.page.getByTestId("acknowledge--button").click();
    await shown.page.getByText("Yes, confirm (unsafe)", { exact: true }).click();
  },

  async sidePanelOpen(browser) {
    const panel = await panelOf(browser);
    await panel?.detach();
    return Boolean(panel);
  },
  /** Opens the side panel unless it is open already (the wallet has to be unlocked), and waits until it has drawn the wallet. */
  async openSidePanel(browser) {
    if (await phantom.sidePanelOpen(browser)) return;
    await openSidePanel(browser);
    if (!(await panelShowing(() => panelOf(browser), '[data-testid="settings-menu-open-button"]'))) throw new Error("Phantom's side panel did not open");
  },
  /** Closes the side panel and waits until it is gone. A request waiting there is never answered. */
  async closeSidePanel(browser) {
    await closeSidePanel(browser);
    await panelGone(() => panelOf(browser));
  },

  /** Settings > Developer Settings > Testnet Mode, on or off. When on, Solana is put on devnet. */
  setTestnetMode: (browser, on) =>
    onOwnPage(browser, async (page) => {
      await openSettings(page);
      await page.getByTestId("settings-item-developer-settings").click();
      const toggle = page.getByTestId("toggleTestNetwork");
      if (((await toggle.locator("input").getAttribute("aria-checked")) === "true") !== on) await toggle.click();
      // The switch's own checkbox is never visible; its state is what is waited for.
      await toggle.locator(`input[aria-checked="${on}"]`).waitFor({ state: "attached" });
      if (on) await page.getByRole("button", { name: "Solana Devnet" }).click();
    }),
};
