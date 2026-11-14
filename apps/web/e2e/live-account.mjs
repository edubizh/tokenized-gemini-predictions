// Live check of the account pages in a browser against a real cluster and a running relayer:
// log in, read the portfolio, redeem the first winning position (or clear a lost one) when there
// is one, open the newest order on the activity page, and read the system page.
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
  // Log in.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.click('[data-testid="login"]:not([disabled])');
  if (withWallet) {
    await page.getByText("Continue with a wallet").click();
    await page.waitForTimeout(1_500);
    await page.getByText(TEST_WALLET_NAME, { exact: false }).first().click();
  } else {
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ timeout: 30_000 });
    await emailInput.fill(email);
    await emailInput.press("Enter");
    await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
    for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
  }
  await page.waitForURL(/\/markets/, { timeout: 90_000 });
  await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});

  // Portfolio.
  await open("Portfolio", "/portfolio");
  const balance = page.locator('[data-testid="portfolio-balance"]');
  await balance.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000);
  await shoot(`${tag}-portfolio`);
  console.log("portfolio:", (await text(page.locator("main").first())).slice(0, 1800));
  const before = await text(balance);

  const winning = page.getByRole("button", { name: /^Redeem\b/ }).first();
  const lost = page.getByRole("button", { name: /^Clear\b/ }).first();
  const action = (await winning.count()) > 0 ? winning : lost;
  if (redeem && (await action.count()) > 0) {
    const label = await text(action);
    const started = Date.now();
    await action.click();
    const receipt = page.locator('[data-testid="redemption-receipt"]').first();
    await receipt.waitFor({ timeout: 120_000 });
    console.log(`${label}: receipt after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log("receipt:", (await text(receipt)).slice(0, 500));
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
    const toggle = orders.first().getByRole("button", { expanded: false }).first();
    if ((await toggle.count()) > 0) await toggle.click();
    await page.waitForTimeout(1_500);
    console.log("first order:", (await text(orders.first())).slice(0, 900));
  } else {
    console.log("activity:", (await text(page.locator("main").first())).slice(0, 400));
  }
  await shoot(`${tag}-activity`);

  // System.
  await open("How it works", "/system");
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
