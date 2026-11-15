// Live check of selling back in a browser against a real cluster and a running relayer: log in
// with the test account, buy on one market, then sell part of the position from the Sell tab of
// the same ticket and follow the sale's timeline to its stamp.
//
//   pnpm dev                                   (relayer and web app; or the two started separately)
//   node --env-file=../../.env e2e/live-sell.mjs [underlying] [YES|NO] [contracts to buy] [contracts to sell] [minimum price]
//
// With 0 contracts to buy the purchase is skipped and tokens already in the wallet are sold. Without
// a minimum price the ticket's default is used: the best bid at that moment.
// LIVE_BASE_URL overrides http://localhost:3200. The test login is read from PRIVY_TEST_EMAIL and
// PRIVY_TEST_OTP and is never printed. The account must already have test funds.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.LIVE_BASE_URL ?? "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out");
const [underlyingArg, sideArg = "YES", buyQuantity = "2.00", sellQuantity = "1.00", minimumPrice] = process.argv.slice(2);
const side = sideArg.toUpperCase();
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
const DONE = '[data-testid="order-slip"][data-stamp="FILLED"], [data-testid="order-slip"][data-stamp="REFUNDED"]';

let exitCode = 1;
try {
  // Log in.
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
  await page.locator('input[name="code-0"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});

  // The market.
  await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
  await page.getByRole("table", { name: "Markets", exact: true }).waitFor({ timeout: 60_000 });
  const rows = page.getByRole("row").filter({ has: page.getByRole("link", { name: new RegExp(`^Buy ${side}`) }) });
  const row = underlyingArg ? rows.filter({ hasText: `${underlyingArg} Up` }).first() : rows.first();
  if ((await row.count()) === 0) throw new Error("no market takes orders on that side right now");
  console.log("market row:", (await text(row)).slice(0, 200));
  await row.getByRole("link", { name: new RegExp(`^Buy ${side}`) }).click();
  await page.waitForURL(/\/markets\/.+/);
  console.log("market page:", new URL(page.url()).pathname);

  // Buy.
  const ticket = page.locator('[data-testid="ticket"]');
  const slip = page.locator('[data-testid="order-slip"]');
  await ticket.waitFor({ timeout: 120_000 });
  let started = Date.now();
  if (Number(buyQuantity) > 0) {
    await ticket.getByLabel("Quantity", { exact: true }).fill(buyQuantity);
    const buyButton = ticket.getByRole("button", { name: /Place order/ });
    if (await buyButton.isDisabled()) throw new Error("the ticket does not allow a buy right now");
    await buyButton.click();
    await slip.waitFor({ timeout: 90_000 });
    await page.locator(DONE).waitFor({ timeout: 150_000 });
    const bought = await slip.getAttribute("data-stamp");
    console.log(`buy ${bought} after ${((Date.now() - started) / 1000).toFixed(1)} s:`, (await text(slip)).slice(0, 260));
    if (bought !== "FILLED") throw new Error("the buy did not fill, so there is nothing to sell");
    await page.getByRole("button", { name: "Place another order" }).click();
    await ticket.waitFor({ timeout: 30_000 });
  }

  // Sell from the same ticket.
  const sellTab = ticket.getByRole("tab", { name: /sell/i });
  await sellTab.waitFor({ timeout: 60_000 });
  await sellTab.click();
  await ticket.getByLabel("Quantity", { exact: true }).fill(sellQuantity);
  if (minimumPrice) await ticket.getByLabel("Minimum price", { exact: true }).fill(minimumPrice);
  await page.waitForTimeout(800);
  await shoot("live-sell-ticket");
  console.log("sell ticket:", (await text(ticket)).slice(0, 500));
  const sellButton = ticket.getByRole("button", { name: /Place order/ });
  if (await sellButton.isDisabled()) throw new Error("the ticket does not allow this sale right now");
  started = Date.now();
  await sellButton.click();
  await slip.waitFor({ timeout: 90_000 });
  console.log(`sale placed after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.locator(DONE).waitFor({ timeout: 150_000 });
  console.log(`sale ${await slip.getAttribute("data-stamp")} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.waitForTimeout(6_000);
  await shoot("live-sell-done");
  console.log("timeline:", (await text(slip)).slice(0, 700));
  console.log("top bar:", (await text(page.locator("header").first())).slice(0, 160));
  exitCode = 0;
} catch (error) {
  console.log("FAILED:", error instanceof Error ? error.message.split("\n")[0] : String(error));
  await shoot("live-sell-failure").catch(() => {});
} finally {
  await browser.close();
  if (problems.length > 0) {
    console.log(`${problems.length} browser problem(s):`);
    for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
  }
}
process.exitCode = exitCode;
