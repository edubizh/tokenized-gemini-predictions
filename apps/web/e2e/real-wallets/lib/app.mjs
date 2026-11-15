// The app's own login and wallet waits, driven the way a user drives them.

export const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

/** The app's login dialog. Its `data-step` is the state of a login with a wallet. */
export const loginDialog = (page) => page.locator('[data-testid="login-dialog"]');
export const loginStep = (page) => loginDialog(page).getAttribute("data-step");
/** What the login dialog says right now, on one line; empty while it is closed. */
export const loginText = async (page) => ((await loginDialog(page).isVisible()) ? oneLine(await loginDialog(page).innerText()) : "");

/**
 * The block the app shows while it waits for a wallet (in the login dialog, or pinned above the
 * page for a signature). `data-slow` is set once it offers Try again.
 */
export const waiting = (page) => page.locator('[data-testid="wallet-waiting"]:visible');
export const waitingText = async (page) => ((await waiting(page).count()) > 0 ? oneLine(await waiting(page).first().innerText()) : "");
/** True once the wait has gone on long enough for the app to offer Try again. */
export const waitingSlow = async (page) => (await page.locator('[data-testid="wallet-waiting"][data-slow]:visible').count()) > 0;

/** Opens the app's entry page and waits until its Log in button can be used. */
export async function openApp(page) {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="login"]:not([disabled])').waitFor({ timeout: 60_000 });
}

/** Log in: leaves the login dialog on its list of ways to log in. */
export async function openLogin(page) {
  await page.click('[data-testid="login"]:not([disabled])');
  await loginDialog(page).locator('[data-testid="login-email"]').waitFor();
}

/** The names of the wallets the login dialog lists. */
export const listedWallets = (page) => loginDialog(page).locator('[data-testid="login-wallet"]').evaluateAll((buttons) => buttons.map((button) => button.dataset.wallet));

/** Picks a wallet in the login dialog by the name it is listed under. */
export const pickWallet = (page, label) => loginDialog(page).locator(`[data-testid="login-wallet"][data-wallet="${label}"]`).click();

/** True once the app has left the entry page for a page behind the login. */
export const loggedIn = (page) => /\/(welcome|markets)/.test(new URL(page.url()).pathname);

/** Waits until the app is logged in; false when it is not within `timeout`. */
export async function waitForLogin(page, timeout = 30_000) {
  return page.waitForURL(/\/(welcome|markets)/, { timeout }).then(
    () => true,
    () => false,
  );
}

/** Logs out through the account menu in the top bar. */
export async function logOut(page) {
  await page.getByRole("button", { name: /^Account / }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await page.locator('[data-testid="login"]:not([disabled])').waitFor({ timeout: 30_000 });
}
