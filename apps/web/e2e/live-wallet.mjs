// Live check of the wallet login: a test wallet is injected the way a browser extension would
// register itself (Wallet Standard), the user logs in with it, opens a contract from the markets
// index, gets test funds in the trade panel when the wallet is new, and places one order that the
// wallet signs.
//
//   pnpm dev                                   (relayer and web app)
//   node e2e/live-wallet.mjs [search] [YES|NO] [contracts] [limit in cents]
//
// The optional search is typed into the index's search field. A dollar limit below 1 ("0.61") is
// turned into cents.
// LIVE_BASE_URL overrides http://localhost:3200. The wallet's throwaway devnet key is kept in
// <repo>/.keys/e2e-wallet-keypair.json (git-ignored) so every run is the same account.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");
const [searchArg, sideArg = "YES", quantity = "1.00", priceArg] = process.argv.slice(2);
const side = sideArg.toUpperCase();
const sideWord = side === "NO" ? "No" : "Yes";
const price = priceArg && Number(priceArg) < 1 ? String(Math.round(Number(priceArg) * 100)) : priceArg;

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

let exitCode = 1;
try {
  // Log in with the wallet.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  console.log("wallet address:", await page.evaluate(() => window.__testWalletAddress));
  // The login service sometimes refuses or answers slowly, so it is tried once more.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.locator('[data-testid="login-top"]:not([disabled])').click({ timeout: 30_000 });
      if (attempt === 1) await shoot("wallet-list");
      await page.click(`[data-testid="login-wallet"][data-wallet="${TEST_WALLET_NAME}"]`);
      await page.locator('[data-testid="account"]').waitFor({ timeout: 90_000 });
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log("the login did not finish; trying once more");
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    }
  }
  console.log("logged in with the wallet:", new URL(page.url()).pathname);

  // No page reloads from here on: a reload drops the connection to an external wallet, and this
  // check is about the first session after logging in. Pages are reached through the app's links.
  const cards = page.locator('[data-testid="event-card"]');
  await cards.first().waitFor({ timeout: 60_000 });
  if (searchArg) {
    await page.locator('[data-testid="filter-search"]').fill(searchArg);
    await page.waitForTimeout(800);
  }
  const buyLink = cards.getByRole("link", { name: new RegExp(`^${sideWord}\\b`) }).first();
  if ((await buyLink.count()) === 0) throw new Error("no market takes orders on that side right now");
  console.log("buying:", await buyLink.getAttribute("aria-label"));
  await buyLink.click();
  await page.waitForURL(/\/markets\/.+/);
  console.log("event page:", new URL(page.url()).pathname + new URL(page.url()).search);
  const ticket = page.locator('[data-testid="ticket"]');
  await ticket.waitFor({ timeout: 120_000 });

  // A new wallet is offered Get test funds in the trade panel in place of the order button.
  const placeButton = ticket.locator('[data-testid="place"]');
  const funds = ticket.locator('[data-testid="get-test-funds"]');
  await Promise.race([placeButton.waitFor({ timeout: 90_000 }), funds.waitFor({ timeout: 90_000 })]);
  if ((await funds.count()) > 0) {
    console.log("new wallet: Get test funds is offered");
    await funds.click();
    await Promise.race([placeButton.waitFor({ timeout: 120_000 }), ticket.getByText("Test funds were not sent", { exact: true }).waitFor({ timeout: 120_000 })]);
    await shoot("wallet-test-funds");
    if ((await placeButton.count()) === 0) throw new Error("test funds were not sent");
    console.log("test funds sent");
  }

  // One order, signed by the wallet.
  await ticket.locator('[data-testid="ticket-quantity"]').fill(quantity);
  if (price) await ticket.locator('[data-testid="ticket-price"]').fill(price);
  if (await placeButton.isDisabled()) {
    console.log("ticket:", (await text(ticket)).slice(0, 400));
    throw new Error("the ticket does not allow an order right now");
  }
  const started = Date.now();
  await placeButton.click();
  const slip = page.locator('[data-testid="order-slip"]');
  await slip.waitFor({ timeout: 90_000 });
  console.log(`order placed after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.locator('[data-testid="order-slip"][data-stamp="FILLED"], [data-testid="order-slip"][data-stamp="REFUNDED"]').waitFor({ timeout: 150_000 });
  console.log(`order ${await slip.getAttribute("data-stamp")} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(3_000);
  await shoot("wallet-order-done");
  console.log("timeline:", (await text(slip)).slice(0, 500));
  console.log("top bar:", (await text(page.locator("header").first())).slice(0, 160));
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot("wallet-failure").catch(() => {});
  const ticketText = await text(page.locator('[data-testid="ticket"]')).catch(() => "");
  console.log(ticketText ? `ticket: ${ticketText.slice(-500)}` : `page text: ${(await text(page.locator("body")).catch(() => "")).slice(0, 500)}`);
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
