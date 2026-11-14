// Captures the screens of the web app for visual review.
//
//   pnpm exec next dev -p 3100            (with RELAYER_URL=fixtures in the environment)
//   node --env-file=../../.env e2e/screens.mjs
//
// Writes PNG files to e2e/out/ at 1280x800 and 390x844: the landing page, the system page, the
// component gallery (full page) and, after logging in with the test account, the welcome screen,
// the markets list, a market with its ticket, an order followed from the ticket to its receipt
// (filled, not filled, reclaimed), the portfolio with a redemption, and the activity list with an
// order opened. The order and redemption screens run only in fixtures mode, where nothing reaches
// a chain.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SCREENS_BASE_URL ?? "http://localhost:3100";
const OUT = path.join(import.meta.dirname, "out");
const VIEWPORTS = [
  { name: "1280", width: 1280, height: 800 },
  { name: "390", width: 390, height: 844 },
];

const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2, timezoneId: "UTC", reducedMotion: "reduce" });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error") problems.push(`console.error: ${message.text().slice(0, 300)}`);
});

async function settle() {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function shoot(name, options = {}) {
  // The network strip is fixed; a full-page capture of a scrolled page would draw it mid-page.
  if (options.fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: options.fullPage ?? false });
  console.log("wrote", path.relative(process.cwd(), file));
}

// 1. Logged out: the landing page and the gallery.
for (const viewport of VIEWPORTS) {
  await page.setViewportSize(viewport);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="login"]:not([disabled])', { timeout: 60_000 });
  await shoot(`landing-${viewport.name}`, { fullPage: true });

  await page.goto(`${BASE}/dev/gallery`, { waitUntil: "networkidle" });
  await page.waitForSelector("#welcome");
  await shoot(`gallery-${viewport.name}`, { fullPage: true });
  // The trading sections one by one, as the whole page is too long to read at a glance.
  for (const id of ["network-strip", "welcome", "relayer-notice", "markets-list", "market-header", "ticket", "ticket-panels", "order-paths", "position", "portfolio", "activity", "system"]) {
    await page.locator(`#${id}`).screenshot({ path: path.join(OUT, `gallery-${id}-${viewport.name}.png`) });
  }

  // The system page is readable without a login.
  await page.goto(`${BASE}/system`, { waitUntil: "networkidle" });
  await page.getByRole("table", { name: "Reconciliation by market" }).waitFor({ timeout: 30_000 });
  await shoot(`system-${viewport.name}`, { fullPage: true });
}

// 2. Keyboard focus, to check the ring.
await page.setViewportSize(VIEWPORTS[0]);
await page.goto(`${BASE}/dev/gallery#button`, { waitUntil: "networkidle" });
await page.locator("#button button").first().focus();
await page.keyboard.press("Tab");
await page.keyboard.press("Shift+Tab");
await shoot("focus-1280");

// 3. Log in with the test account. The gate sends a new account to /welcome.
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.click('[data-testid="login"]:not([disabled])');
const emailInput = page.locator('input[type="email"]').first();
await emailInput.waitFor({ timeout: 30_000 });
await emailInput.fill(email);
await emailInput.press("Enter");
await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
await page.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });
// The login dialog stays on screen for a moment after the redirect; nothing is captured under it.
await page.waitForFunction(() => document.querySelector('[role="dialog"], #privy-dialog, #privy-modal-content') === null, null, { timeout: 60_000 });

/** Captures the current page at both widths, returning to the wide one. */
async function shootBoth(name, options = {}) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(300);
    await shoot(`${name}-${viewport.name}`, { fullPage: true, ...options });
  }
  await page.setViewportSize(VIEWPORTS[0]);
}

// 4. The welcome screen. In fixtures mode the account is already a registered trader.
await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="welcome"]:not([data-state="loading"])', { timeout: 90_000 });
console.log("welcome state:", await page.getAttribute('[data-testid="welcome"]', "data-state"));
await shootBoth("welcome");

// 5. The account menu, opened from the keyboard.
await page.locator('header button[aria-haspopup="menu"]').focus();
await page.keyboard.press("ArrowDown");
await shoot("welcome-menu-1280");
await page.keyboard.press("Escape");

// 6. Markets, and one market with its ticket. These need fixtures mode: nothing here reaches a chain.
const fixtures = (await page.request.get(`${BASE}/api/fixtures/chain?wallet=11111111111111111111111111111111`)).status() === 200;
if (!fixtures) {
  console.log("not in fixtures mode: skipping the market and order screens");
} else {
  const openMarket = async (underlying, side) => {
    await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
    const row = page.getByRole("row").filter({ hasText: `${underlying} Up` }).filter({ hasText: "YES" }).first();
    await row.waitFor({ timeout: 30_000 });
    if (side) await row.getByRole("link", { name: new RegExp(`^Buy ${side}`) }).click();
    else await row.getByRole("link", { name: `${underlying} Up`, exact: true }).click();
    await page.waitForURL(/\/markets\/.+/);
  };
  const ticket = page.locator('[data-testid="ticket"]');
  const slip = page.locator('[data-testid="order-slip"]');
  const place = async (quantity, price) => {
    await ticket.waitFor({ timeout: 30_000 });
    await ticket.getByLabel("Quantity", { exact: true }).fill(quantity);
    if (price) await ticket.getByLabel("Limit price", { exact: true }).fill(price);
    await ticket.getByRole("button", { name: /Place order/ }).click();
  };

  try {
    await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
    await page.getByRole("table", { name: "Markets", exact: true }).waitFor({ timeout: 30_000 });
    await shootBoth("markets");

    await openMarket("BTC");
    await ticket.waitFor({ timeout: 30_000 });
    await shootBoth("market-ticket");

    await openMarket("BTC", "NO");
    await ticket.waitFor({ timeout: 30_000 });
    await ticket.getByLabel("Quantity", { exact: true }).fill("300");
    await shoot("market-ticket-no-warning-1280");

    // An order that fills: the ticket turns into the timeline and is stamped step by step.
    await openMarket("BTC", "YES");
    await place("2.00");
    await ticket.locator("button[data-busy]").waitFor({ timeout: 10_000 });
    await shoot("order-sending-1280");
    await slip.waitFor({ timeout: 30_000 });
    await shoot("order-placed-1280", { fullPage: true });
    await page.locator('[data-testid="order-slip"][data-stamp="FILLED"]').waitFor({ timeout: 30_000 });
    await shootBoth("order-filled");

    // An order below the lowest offer: not filled, refunded in full.
    await slip.getByRole("button", { name: "Place another order" }).click();
    await place("3.00", "0.50");
    await page.locator('[data-testid="order-slip"][data-stamp="REFUNDED"]').waitFor({ timeout: 30_000 });
    await shootBoth("order-refunded");

    // The fixture order the relayer never sends: once expired it is reclaimed by the user.
    const reclaim = page.getByRole("button", { name: "Reclaim hold" }).first();
    if (await reclaim.isVisible().catch(() => false)) {
      await shoot("order-expired-1280", { fullPage: true });
      await reclaim.click();
      await page.locator('[data-testid="order-entry"][data-stamp="REFUNDED"]').first().waitFor({ timeout: 30_000 });
      await shoot("order-reclaimed-1280", { fullPage: true });
    } else {
      console.log("no order to reclaim on screen (not expired yet, or reclaimed earlier in this fixture cycle)");
    }

    // A live market that is not on-chain yet is prepared when its page opens.
    await openMarket("SOL");
    const preparing = page.getByText("Preparing this market on Solana");
    await Promise.race([preparing.waitFor({ timeout: 30_000 }), ticket.waitFor({ timeout: 30_000 })]);
  if (await preparing.isVisible().catch(() => false)) await shoot("market-preparing-1280");
    await ticket.waitFor({ timeout: 30_000 });
    await shoot("market-prepared-1280");

    // Activity: every order with its stamp; one opened in place into its steps and receipt.
    await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
    const orders = page.getByRole("table", { name: "Your orders", exact: true });
    await orders.waitFor({ timeout: 30_000 });
    await shootBoth("activity");
    const filledRow = orders.getByRole("row").filter({ has: page.locator('[data-testid="activity-order"][data-stamp="FILLED"]') }).first();
    await filledRow.getByRole("button", { name: /Details/ }).click();
    await page.getByText("Order receipt").first().waitFor({ timeout: 10_000 });
    await shootBoth("activity-open");

    // Portfolio: the groups, then a redemption. The simulated balance must go up by the payout.
    await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
    const redeemable = page.getByRole("table", { name: "Redeemable positions" });
    await redeemable.waitFor({ timeout: 30_000 });
    const balance = page.locator('[data-testid="portfolio-balance"]');
    const before = await balance.innerText();
    await shootBoth("portfolio");
    const receipts = page.locator('[data-testid="redemption-receipt"]');
    await redeemable.getByRole("button", { name: /^Redeem / }).first().click();
    await redeemable.locator("button[data-busy]").first().waitFor({ timeout: 10_000 });
    await shoot("portfolio-redeeming-1280", { fullPage: true });
    await receipts.first().waitFor({ timeout: 30_000 });
    await page.waitForFunction((was) => document.querySelector('[data-testid="portfolio-balance"]')?.textContent !== was, before, { timeout: 30_000 });
    console.log("test dollars before and after the redemption:", before, "->", await balance.innerText());
    const clear = page.getByRole("button", { name: /^Clear / }).first();
    if (await clear.isVisible().catch(() => false)) {
      const had = await receipts.count();
      await clear.click();
      await page.waitForFunction((count) => document.querySelectorAll('[data-testid="redemption-receipt"]').length > count, had, { timeout: 30_000 });
    }
    await shootBoth("portfolio-redeemed");
  } catch (error) {
    // What was on screen when a step failed says more than the stack does.
    await page.screenshot({ path: path.join(OUT, "failure.png"), fullPage: true }).catch(() => {});
    throw error;
  }
}

// 7. A returning, logged-in browser must not paint the logged-out landing page.
await page.goto(`${BASE}/`, { waitUntil: "commit" });
const flashed = await page.evaluate(() => {
  const login = document.querySelector('[data-testid="login"]');
  return login !== null && login.getClientRects().length > 0;
});
console.log("landing painted for a logged-in user:", flashed);
await page.waitForURL(/\/(welcome|markets)/, { timeout: 60_000 });

await browser.close();
if (problems.length > 0) {
  console.log(`${problems.length} browser problem(s):`);
  for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
}
if (flashed) process.exitCode = 1;
