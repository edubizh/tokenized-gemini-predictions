// Live check of the account pages in a browser against a real cluster and a running relayer:
// log in, read the portfolio, redeem the first winning position (or clear a lost one) when there
// is one, open the newest order's steps on the activity page, and read the system page.
//
//   pnpm dev                                   (relayer and web app; or the two started separately)
//   node --env-file=../../.env e2e/live-account.mjs [--wallet] [--no-redeem]
//
// The default login is the email test account (PRIVY_TEST_EMAIL and PRIVY_TEST_OTP, never
// printed). With --wallet the injected test wallet of live-wallet.mjs logs in instead.
// LIVE_BASE_URL overrides http://localhost:3200.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");
const withWallet = process.argv.includes("--wallet");
const redeem = !process.argv.includes("--no-redeem");
const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!withWallet && (!email || !otp)) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");
const tag = withWallet ? "wallet" : "live";

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
if (withWallet) await context.addInitScript(installTestWallet, { keypair: loadTestWalletKey(KEY_FILE), name: TEST_WALLET_NAME });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console.error: ${message.text().slice(0, 300)}`);
});
const shoot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log("wrote", `e2e/out/${name}.png`);
};
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
// Pages are reached through the app's own links, as a user would, so the session is never reloaded.
const open = async (name, pathname) => {
  await page.getByRole("link", { name, exact: true }).first().click();
  await page.waitForURL(new RegExp(`${pathname}$`), { timeout: 60_000 });
};

let exitCode = 1;
try {
  // Log in. The login service sometimes refuses or answers slowly, so it is tried once more.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  for (let attempt = 1; ; attempt++) {
    try {
      await page.locator('[data-testid="login-top"]:not([disabled])').click({ timeout: 30_000 });
      if (withWallet) {
        await page.click(`[data-testid="login-wallet"][data-wallet="${TEST_WALLET_NAME}"]`);
      } else {
        await page.click('[data-testid="login-email"]');
        const emailInput = page.locator('input[type="email"]').first();
        await emailInput.waitFor({ timeout: 30_000 });
        await emailInput.fill(email);
        await emailInput.press("Enter");
        await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
        for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
      }
      await page.locator('[data-testid="account"]').waitFor({ timeout: 90_000 });
      await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log("the login did not finish; trying once more");
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    }
  }

  // Portfolio.
  await open("Portfolio", "/portfolio");
  const balance = page.locator('[data-testid="portfolio-balance"]');
  await balance.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await shoot(`${tag}-portfolio`);
  console.log("portfolio:", (await text(page.locator("main").first())).slice(0, 1800));
  const before = await text(balance);

  const winning = page.locator('[data-testid="position-redeem"]').first();
  const lost = page.locator('[data-testid="position-clear"]').first();
  const action = (await winning.count()) > 0 ? winning : lost;
  if (redeem && (await action.count()) > 0) {
    const label = await text(action);
    // A redemption shows up as a new row under Settled with its transaction.
    const receipts = page.locator('[data-testid="redemption-tx"]');
    const receiptsBefore = await receipts.count();
    const started = Date.now();
    await action.click();
    await receipts.nth(receiptsBefore).waitFor({ timeout: 120_000 });
    console.log(`${label}: transaction after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log("settled:", (await text(page.locator('[data-testid="portfolio-settled"]'))).slice(0, 500));
    await page.waitForTimeout(12_000);
    await shoot(`${tag}-portfolio-redeemed`);
    console.log("balance before and after:", before, "->", await text(balance));
  } else {
    console.log(redeem ? "nothing to redeem or clear right now" : "redemption skipped");
  }

  // Activity.
  await open("Activity", "/activity");
  await page.waitForTimeout(6_000);
  const orders = page.locator('[data-testid="activity-order"]');
  console.log("activity rows:", await orders.count());
  if ((await orders.count()) > 0) {
    console.log("first order:", await orders.first().getAttribute("data-stamp"), (await text(orders.first())).slice(0, 200));
    // The first row's steps: opened unless the row already shows them.
    const toggle = page.locator('[data-testid="activity-details"]').first();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    const steps = page.locator('[data-testid="activity-steps"]').first();
    await steps.waitFor({ timeout: 10_000 });
    console.log("its steps:", (await text(steps)).slice(0, 900));
  } else {
    console.log("activity:", (await text(page.locator("main").first())).slice(0, 400));
  }
  await shoot(`${tag}-activity`);

  // System.
  await open("How it works", "/system");
  await page.locator('[data-testid="system-mechanism"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await shoot(`${tag}-system`);
  console.log("system:", (await text(page.locator("main").first())).slice(0, 300));
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot(`${tag}-failure`).catch(() => {});
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
