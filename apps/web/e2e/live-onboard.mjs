// Live check of the first-run flow against a real cluster: log in with the test account, open the
// portfolio, press "Get test funds" when the page offers it, and wait for the server route to
// register the wallet and send starter funds. A wallet that is already set up is not offered the
// step; the page is then only read.
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

const funds = page.locator('[data-testid="get-test-funds"]');
const sent = page.getByText("Test funds sent", { exact: true });
const notSent = page.getByText("Test funds were not sent", { exact: true });

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  // The login service sometimes refuses or answers slowly, so it is tried once more.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.locator('[data-testid="login-top"]:not([disabled])').click({ timeout: 30_000 });
      await page.click('[data-testid="login-email"]');
      const emailInput = page.locator('input[type="email"]').first();
      await emailInput.waitFor({ timeout: 30_000 });
      await emailInput.fill(email);
      await emailInput.press("Enter");
      await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
      for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
      await page.locator('[data-testid="account"]').waitFor({ timeout: 90_000 });
      // The login dialog closes on its own a moment after the code is accepted.
      await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
      break;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log("the login did not finish; trying once more");
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    }
  }

  // The first-run step is drawn on the portfolio (and in an event page's trade panel). It is
  // reached through the app's own link, so the session is not reloaded.
  await page.getByRole("link", { name: "Portfolio", exact: true }).first().click();
  await page.waitForURL(/\/portfolio$/, { timeout: 60_000 });
  await page.locator('[data-testid="portfolio-balance"]').waitFor({ timeout: 90_000 });
  // Whether the wallet is a trader is read from Solana before the step is offered.
  await funds.waitFor({ timeout: 20_000 }).catch(() => {});
  if ((await funds.count()) > 0) {
    console.log("first run: Get test funds is offered");
    await funds.click();
    await Promise.race([sent.waitFor({ timeout: 120_000 }), notSent.waitFor({ timeout: 120_000 })]);
    console.log("after Get test funds:", (await sent.count()) > 0 ? "sent" : "not sent");
  } else {
    console.log("Get test funds is not offered: the wallet is already set up (or nothing is deployed)");
  }
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: path.join(OUT, "live-onboard.png"), fullPage: true });
  const notice = (await sent.count()) > 0 ? sent : notSent;
  if ((await notice.count()) > 0) console.log("notice:", (await notice.locator("xpath=../..").innerText()).replace(/\s+/g, " ").slice(0, 600));
  const link = await page.getByRole("link", { name: "View transaction" }).first().getAttribute("href").catch(() => null);
  console.log("transaction link:", link ?? "none");
  console.log("balance:", (await page.locator('[data-testid="portfolio-balance"]').innerText()).replace(/\s+/g, " "));
  console.log("top bar:", (await page.locator("header").first().innerText()).replace(/\s+/g, " ").slice(0, 200));
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
