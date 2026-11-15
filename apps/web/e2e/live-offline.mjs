// Live check of the app with the relayer stopped, against a real cluster: log in with the injected
// test wallet, see the offline notice on the markets index, read the portfolio from Solana (redeeming or
// clearing a settled position when there is one), then reclaim an expired open order from the
// activity page. Nothing here needs the relayer; that is the point.
//
// Before running it: stop the relayer and place an order that nobody will fill, as the same wallet:
//
//   DEMO_USER_KEYPAIR=.keys/e2e-wallet-keypair.json pnpm demo buy <symbol> yes 1 0.50   (limit in dollars)
//   pnpm web                                   (the web app alone)
//   node e2e/live-offline.mjs
//
// LIVE_BASE_URL overrides http://localhost:3200. The wallet's throwaway devnet key is kept in
// <repo>/.keys/e2e-wallet-keypair.json (git-ignored).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
await context.addInitScript(installTestWallet, { keypair: loadTestWalletKey(KEY_FILE), name: TEST_WALLET_NAME });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
const shoot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log("wrote", `e2e/out/${name}.png`);
};
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
// Pages are reached through the app's own links, so the wallet stays connected.
const open = async (name, pathname) => {
  await page.getByRole("link", { name, exact: true }).first().click();
  await page.waitForURL(new RegExp(`${pathname}$`), { timeout: 60_000 });
};

let exitCode = 1;
try {
  // Log in with the wallet. The login provider is separate from the relayer.
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
  await page.waitForTimeout(8_000);
  await shoot("offline-live-markets");
  console.log("markets:", (await text(page.locator("main").first())).slice(0, 400));

  // Portfolio, read from Solana alone.
  await open("Portfolio", "/portfolio");
  const balance = page.locator('[data-testid="portfolio-balance"]');
  await balance.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(12_000);
  await shoot("offline-live-portfolio");
  console.log("portfolio:", (await text(page.locator("main").first())).slice(0, 1500));
  const action = page.locator('[data-testid="position-redeem"], [data-testid="position-clear"]').first();
  if ((await action.count()) > 0) {
    const label = await text(action);
    const before = await text(balance);
    // A redemption shows up as a new row under Settled with its transaction.
    const receipts = page.locator('[data-testid="redemption-tx"]');
    const receiptsBefore = await receipts.count();
    const started = Date.now();
    await action.click();
    await receipts.nth(receiptsBefore).waitFor({ timeout: 120_000 });
    console.log(`${label} with the relayer stopped: transaction after ${((Date.now() - started) / 1000).toFixed(1)} s:`, (await text(receipts.nth(receiptsBefore))).slice(0, 120));
    await page.waitForTimeout(12_000);
    console.log("balance before and after:", before, "->", await text(balance));
  } else {
    console.log("nothing to redeem or clear right now");
  }

  // Activity: the open order is read from Solana; once it has expired the wallet reclaims it.
  await open("Activity", "/activity");
  const orders = page.locator('[data-testid="activity-order"]');
  await orders.first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(3_000);
  console.log("activity rows:", await orders.count());
  console.log("newest order:", await orders.first().getAttribute("data-stamp"), (await text(orders.first())).slice(0, 300));
  await shoot("offline-live-activity");
  // The newest order is the one placed just before this run. It is reclaimed the moment the page
  // stamps it EXPIRED: that only happens when the page counts the expiry on the cluster's clock.
  // Orders that expired earlier are reclaimed after it, so nothing stays held. A row that can be
  // reclaimed shows its steps open, with Reclaim among them.
  await page.locator('[data-testid="activity-order"]').first().and(page.locator('[data-stamp="EXPIRED"]')).waitFor({ timeout: 180_000 });
  await shoot("offline-live-expired");
  const expiredRows = page.locator('[data-testid="activity-order"][data-stamp="EXPIRED"]');
  const buttons = page.locator('[data-testid="activity-steps"]').getByRole("button", { name: /^Reclaim/ });
  const refused = page.getByText(/was not reclaimed|Nothing was reclaimed/i).first();
  const before = await text(page.locator("header").first());
  for (let left = await expiredRows.count(); left > 0; left = await expiredRows.count()) {
    await buttons.first().waitFor({ timeout: 60_000 });
    console.log(`${left} expired order(s); offered:`, await text(buttons.first()));
    const started = Date.now();
    await buttons.first().click();
    await Promise.race([
      page.waitForFunction((count) => document.querySelectorAll('[data-testid="activity-order"][data-stamp="EXPIRED"]').length < count, left, { timeout: 120_000 }),
      refused.waitFor({ timeout: 120_000 }),
    ]);
    if ((await refused.count()) > 0) throw new Error(`the reclaim was refused: ${(await text(refused.locator("xpath=..")).catch(() => "")).slice(0, 300)}`);
    console.log(`reclaimed after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }
  await page.waitForTimeout(12_000);
  await shoot("offline-live-reclaimed");
  console.log("newest order now:", (await orders.count()) > 0 ? `${await orders.first().getAttribute("data-stamp")} ${(await text(orders.first())).slice(0, 300)}` : "(no rows)");
  console.log("top bar before:", before.slice(0, 120));
  console.log("top bar after: ", (await text(page.locator("header").first())).slice(0, 120));
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot("offline-live-failure").catch(() => {});
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
