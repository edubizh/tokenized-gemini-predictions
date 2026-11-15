// Live check of a wallet login after a page reload, against a real cluster and a running relayer.
// A reload leaves the user logged in but the wallet no longer connected in the tab, so the app
// offers Reconnect wallet wherever a signature is needed. This logs in with the injected test
// wallet, reloads, reconnects on the portfolio and redeems or clears a settled position when there
// is one, then opens a contract from the markets index, reloads its event page, reconnects in the
// trade panel, switches account inside the wallet and back, and places one order.
//
//   pnpm dev                                   (relayer and web app)
//   node e2e/live-reconnect.mjs [search] [YES|NO] [contracts]
//
// The optional search is typed into the index's search field.
// LIVE_BASE_URL overrides http://localhost:3200. The wallet's throwaway devnet key is kept in
// <repo>/.keys/e2e-wallet-keypair.json (git-ignored); run live-wallet.mjs once first so that the
// wallet is registered and funded.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");
const [searchArg, sideArg = "YES", quantity = "1.00"] = process.argv.slice(2);
const side = sideArg.toUpperCase();
const sideWord = side === "NO" ? "No" : "Yes";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
await context.addInitScript(installTestWallet, { keypair: loadTestWalletKey(KEY_FILE), name: TEST_WALLET_NAME });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console.error: ${message.text().slice(0, 300)}`);
});
const shoot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log("wrote", `e2e/out/${name}.png`);
};
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const reconnectButtons = page.getByRole("button", { name: /^Reconnect wallet/ });
const reconnect = async () => {
  await reconnectButtons.first().click();
};

let exitCode = 1;
try {
  // Log in with the wallet.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  console.log("wallet address:", await page.evaluate(() => window.__testWalletAddress));
  // The login service sometimes refuses or answers slowly, so it is tried once more.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.locator('[data-testid="login-top"]:not([disabled])').click({ timeout: 30_000 });
      await page.click(`[data-testid="login-wallet"][data-wallet="${TEST_WALLET_NAME}"]`);
      await page.locator('[data-testid="account"]').waitFor({ timeout: 90_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log("the login did not finish; trying once more");
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    }
  }

  // Reload on the portfolio: still logged in, wallet not connected.
  await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
  await page.locator('[data-testid="portfolio-balance"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000);
  const balance = page.locator('[data-testid="portfolio-balance"]');
  if ((await reconnectButtons.count()) > 0) {
    console.log("after a reload the portfolio offers:", await text(reconnectButtons.first()));
    await shoot("reconnect-live-portfolio");
    const before = await text(balance);
    await reconnect();
    const action = page.locator('[data-testid="position-redeem"], [data-testid="position-clear"], [data-testid="order-reclaim"]').first();
    await action.waitFor({ timeout: 60_000 });
    console.log("after reconnecting the action is back:", await text(action));
    if ((await action.getAttribute("data-testid")) === "order-reclaim") {
      console.log("the action is a reclaim of an expired order; it is left for live-offline.mjs");
    } else {
      // A redemption shows up as a new row under Settled with its transaction.
      const receipts = page.locator('[data-testid="redemption-tx"]');
      const receiptsBefore = await receipts.count();
      const started = Date.now();
      await action.click();
      await receipts.nth(receiptsBefore).waitFor({ timeout: 120_000 });
      console.log(`transaction after ${((Date.now() - started) / 1000).toFixed(1)} s:`, (await text(receipts.nth(receiptsBefore))).slice(0, 120));
    }
    await page.waitForTimeout(8_000);
    console.log("balance before and after:", before, "->", await text(balance));
  } else {
    console.log("the portfolio has nothing that needs a signature right now");
  }

  // Reload on the markets index, open a contract, and place an order from the trade panel after
  // reloading the event page and reconnecting there.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const cards = page.locator('[data-testid="event-card"]');
  await cards.first().waitFor({ timeout: 60_000 });
  if (searchArg) {
    await page.locator('[data-testid="filter-search"]').fill(searchArg);
    await page.waitForTimeout(800);
  }
  const buyLink = cards.getByRole("link", { name: new RegExp(`^${sideWord}\\b`) }).first();
  if ((await buyLink.count()) === 0) {
    console.log("no market takes orders on that side right now: the order after a reload was not tried");
  } else {
    await buyLink.click();
    await page.waitForURL(/\/markets\/.+/);
    console.log("event page:", new URL(page.url()).pathname + new URL(page.url()).search);
    const ticket = page.locator('[data-testid="ticket"]');
    await ticket.waitFor({ timeout: 120_000 });
    await page.reload({ waitUntil: "networkidle" });
    await ticket.waitFor({ timeout: 120_000 });
    await ticket.locator('[data-testid="reconnect"]').waitFor({ timeout: 60_000 });
    await shoot("reconnect-live-ticket");
    console.log("after a reload the ticket offers:", await text(ticket.locator('[data-testid="reconnect"]')));
    await ticket.locator('[data-testid="reconnect"]').click();
    const placeButton = ticket.locator('[data-testid="place"]');
    await placeButton.waitFor({ timeout: 60_000 });
    console.log("after reconnecting the ticket offers:", await text(placeButton));
    // The user switches account inside the wallet: the ticket says which account to go back to and
    // offers nothing to sign, and offers the order again once the wallet is back on it.
    await page.evaluate(() => window.__testWalletSwitch(true));
    const switchBack = ticket.getByText(/Switch back to .+ in the wallet, or log out and log in with the new account\./);
    await switchBack.waitFor({ timeout: 30_000 });
    console.log("with the wallet on another account the ticket says:", await text(switchBack));
    if ((await placeButton.count()) > 0) throw new Error("the ticket offers the order button while the wallet is on another account");
    await page.evaluate(() => window.__testWalletSwitch(false));
    await placeButton.waitFor({ timeout: 30_000 });
    console.log("back on the trading account the ticket offers:", await text(placeButton));
    const quantityField = ticket.locator('[data-testid="ticket-quantity"]');
    if (await quantityField.isDisabled()) throw new Error("this market no longer takes orders: run again earlier in a market's window");
    await quantityField.fill(quantity);
    if (await placeButton.isDisabled()) throw new Error("the ticket does not allow an order right now");
    const started = Date.now();
    await placeButton.click();
    const slip = page.locator('[data-testid="order-slip"]');
    await slip.waitFor({ timeout: 90_000 });
    await page.locator('[data-testid="order-slip"][data-stamp="FILLED"], [data-testid="order-slip"][data-stamp="REFUNDED"]').waitFor({ timeout: 150_000 });
    console.log(`order ${await slip.getAttribute("data-stamp")} after ${((Date.now() - started) / 1000).toFixed(1)} s:`, (await text(slip)).slice(0, 400));
    await shoot("reconnect-live-order");
  }
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot("reconnect-live-failure").catch(() => {});
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
