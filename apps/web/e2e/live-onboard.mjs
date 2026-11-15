// Live check of the first-run flow against a real cluster: log in with the test account, press
// "Get test funds", and wait for the server route to register the wallet and send starter funds.
//
//   NEXT_DIST_DIR=.next-live pnpm exec next dev -p 3200      (no RELAYER_URL=fixtures)
//   node --env-file=../../.env e2e/live-onboard.mjs
//
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console.error: ${message.text().slice(0, 300)}`);
});

const welcome = '[data-testid="welcome"]';
const stateOf = () => page.getAttribute(welcome, "data-state");

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.click('[data-testid="login"]:not([disabled])');
  await page.click('[data-testid="login-email"]');
  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.waitFor({ timeout: 30_000 });
  await emailInput.fill(email);
  await emailInput.press("Enter");
  await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
  for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
  await page.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });
  // The login dialog closes on its own a moment after the code is accepted.
  await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  console.log("after login:", new URL(page.url()).pathname);

  if (new URL(page.url()).pathname !== "/welcome") await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
  await page.waitForSelector(`${welcome}:not([data-state="loading"])`, { timeout: 90_000 });
  console.log("welcome state:", await stateOf());

  if ((await stateOf()) === "ready") {
    await page.click('[data-testid="get-test-funds"]');
    await page.waitForSelector(`${welcome}[data-state="done"], ${welcome}[data-state="error"], ${welcome}[data-state="already"]`, { timeout: 120_000 });
    console.log("after Get test funds:", await stateOf());
  }
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: path.join(OUT, "live-welcome.png"), fullPage: true });
  const text = (await page.locator(welcome).innerText()).replace(/\s+/g, " ").slice(0, 600);
  console.log("welcome text:", text);
  const link = await page.locator(`${welcome} a[href*="explorer"]`).first().getAttribute("href").catch(() => null);
  console.log("transaction link:", link ?? "none");
  console.log("top bar:", (await page.locator("header").first().innerText()).replace(/\s+/g, " ").slice(0, 200));
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
