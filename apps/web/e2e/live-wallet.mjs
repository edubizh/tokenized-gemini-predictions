// Live check of the wallet login: a test wallet is injected the way a browser extension would
// register itself (Wallet Standard), the user logs in with it, gets test funds, and places one
// order that the wallet signs.
//
//   pnpm dev                                   (relayer and web app)
//   node e2e/live-wallet.mjs [underlying] [YES|NO] [contracts] [limit]
//
// LIVE_BASE_URL overrides http://localhost:3200. The wallet's throwaway devnet key is kept in
// <repo>/.keys/e2e-wallet-keypair.json (git-ignored) so every run is the same account.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");
const [underlyingArg, sideArg = "YES", quantity = "1.00", price] = process.argv.slice(2);
const side = sideArg.toUpperCase();

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
  await page.click('[data-testid="login"]:not([disabled])');
  await page.getByText("Continue with a wallet").click();
  await page.waitForTimeout(1_500);
  await shoot("wallet-list");
  await page.getByText(TEST_WALLET_NAME, { exact: false }).first().click();
  await page.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });
  console.log("logged in with the wallet:", new URL(page.url()).pathname);

  // No page reloads from here on: a reload drops the connection to an external wallet, and this
  // check is about the first session after logging in. A new wallet is sent to the welcome screen
  // by the app itself; a registered one lands on the markets.
  const welcome = '[data-testid="welcome"]';
  const marketsTable = page.getByRole("table", { name: "Markets", exact: true });
  await Promise.race([
    page.waitForSelector(`${welcome}:not([data-state="loading"])`, { timeout: 90_000 }),
    marketsTable.waitFor({ timeout: 90_000 }),
  ]);
  if (new URL(page.url()).pathname === "/welcome") {
    console.log("welcome state:", await page.getAttribute(welcome, "data-state"));
    if ((await page.getAttribute(welcome, "data-state")) === "ready") {
      await page.click('[data-testid="get-test-funds"]');
      await page.waitForSelector(`${welcome}[data-state="done"], ${welcome}[data-state="error"], ${welcome}[data-state="already"]`, { timeout: 120_000 });
      console.log("after Get test funds:", await page.getAttribute(welcome, "data-state"));
      await shoot("wallet-welcome");
    }
    await page.getByRole("link", { name: "Markets", exact: true }).first().click();
  }

  // One order, signed by the wallet.
  await marketsTable.waitFor({ timeout: 60_000 });
  const rows = page.getByRole("row").filter({ has: page.getByRole("link", { name: new RegExp(`^Buy ${side}`) }) });
  const row = underlyingArg ? rows.filter({ hasText: `${underlyingArg} Up` }).first() : rows.first();
  if ((await row.count()) === 0) throw new Error("no market takes orders on that side right now");
  await row.getByRole("link", { name: new RegExp(`^Buy ${side}`) }).click();
  await page.waitForURL(/\/markets\/.+/);
  console.log("market page:", new URL(page.url()).pathname);
  const ticket = page.locator('[data-testid="ticket"]');
  await ticket.waitFor({ timeout: 120_000 });
  await ticket.getByLabel("Quantity", { exact: true }).fill(quantity);
  if (price) await ticket.getByLabel("Limit price", { exact: true }).fill(price);
  const placeButton = ticket.getByRole("button", { name: /Place order/ });
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
