// Live check of the trading flow in a browser against a real cluster and a running relayer:
// log in with the test account, pick a contract on the markets index, place one buy from the
// event page's trade panel, and follow the order's timeline to its stamp (FILLED, or REFUNDED when
// the venue has no offer at the limit).
//
//   pnpm dev                                   (relayer and web app; or the two started separately)
//   node --env-file=../../.env e2e/live-flow.mjs [search] [YES|NO] [contracts] [limit in cents]
//
// The optional search is typed into the index's search field (an asset, title or strike). The
// limit is in cents ("61"); a dollar value below 1 ("0.61") is turned into cents.
// LIVE_BASE_URL overrides http://localhost:3200. The test login is read from PRIVY_TEST_EMAIL and
// PRIVY_TEST_OTP and is never printed. The account must already have test funds
// (see live-onboard.mjs).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const [searchArg, sideArg = "YES", quantity = "1.00", priceArg] = process.argv.slice(2);
const side = sideArg.toUpperCase();
const sideWord = side === "NO" ? "No" : "Yes";
const price = priceArg && Number(priceArg) < 1 ? String(Math.round(Number(priceArg) * 100)) : priceArg;
const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
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
// The login service sometimes refuses or answers slowly, so a failed login is tried once more.
const logIn = async () => {
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
      await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
      return;
    } catch (error) {
      if (attempt >= 2) throw error;
      console.log("the login did not finish; trying once more");
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    }
  }
};

let exitCode = 1;
try {
  // Log in.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await logIn();

  // Markets index: the first contract that offers the chosen side.
  const cards = page.locator('[data-testid="event-card"]');
  await cards.first().waitFor({ timeout: 60_000 });
  if (searchArg) {
    await page.locator('[data-testid="filter-search"]').fill(searchArg);
    await page.waitForTimeout(800);
  }
  await shoot("live-markets");
  const buyLink = cards.getByRole("link", { name: new RegExp(`^${sideWord}\\b`) }).first();
  if ((await buyLink.count()) === 0) {
    console.log("no market takes orders on that side right now:", (await text(page.locator("main").first())).slice(0, 600));
    throw new Error("nothing to trade");
  }
  const card = cards.filter({ has: page.getByRole("link", { name: new RegExp(`^${sideWord}\\b`) }) }).first();
  console.log("event card:", (await text(card)).slice(0, 200));
  console.log("buying:", await buyLink.getAttribute("aria-label"));
  await buyLink.click();
  await page.waitForURL(/\/markets\/.+/);
  console.log("event page:", new URL(page.url()).pathname + new URL(page.url()).search);

  // The ticket (the market may first be created on-chain).
  const ticket = page.locator('[data-testid="ticket"]');
  await ticket.waitFor({ timeout: 120_000 });
  await ticket.locator('[data-testid="ticket-quantity"]').fill(quantity);
  if (price) await ticket.locator('[data-testid="ticket-price"]').fill(price);
  await shoot("live-ticket");
  const placeButton = ticket.locator('[data-testid="place"]');
  await placeButton.waitFor({ timeout: 60_000 });
  console.log("ticket:", (await text(ticket)).slice(0, 400));
  if (await placeButton.isDisabled()) throw new Error("the ticket does not allow an order right now");
  const started = Date.now();
  await placeButton.click();

  // The timeline.
  const slip = page.locator('[data-testid="order-slip"]');
  await slip.waitFor({ timeout: 90_000 });
  console.log(`order placed after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await shoot("live-order-placed");
  await page.locator('[data-testid="order-slip"][data-stamp="FILLED"], [data-testid="order-slip"][data-stamp="REFUNDED"]').waitFor({ timeout: 150_000 });
  const stamp = await slip.getAttribute("data-stamp");
  console.log(`order ${stamp} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(4_000);
  await shoot("live-order-done");
  console.log("timeline:", (await text(slip)).slice(0, 700));
  console.log("top bar:", (await text(page.locator("header").first())).slice(0, 160));
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot("live-failure").catch(() => {});
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
