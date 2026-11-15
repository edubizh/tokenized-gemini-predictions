// Captures the screens of the web app for visual review.
//
//   pnpm exec next dev -p 3100            (with RELAYER_URL=fixtures in the environment)
//   node --env-file=../../.env e2e/screens.mjs
//
// Writes PNG files to e2e/out/ at 1280x800 and 390x844: the landing page, the system page, the
// component gallery (full page) and, after logging in with the test account, the welcome screen,
// the markets list, a market with its ticket, an order followed from the ticket to its receipt
// (filled, not filled, reclaimed), a sale from the portfolio through the ticket's sell tab (filled,
// and not filled with the tokens returned), the portfolio with a redemption, the activity list
// with an order opened, every page with the relayer offline and the portfolio with Solana not
// answering (both through the fixtures switch), the not-found and error pages, and a wallet login
// after a page reload, where Reconnect wallet takes the place of the action. The order, sale,
// redemption and offline screens run only in fixtures mode, where nothing reaches a chain.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { installTestWallet, loadTestWalletKey, TEST_WALLET_NAME } from "./lib/test-wallet.mjs";

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
// The browser itself logs every failed request. Those the script causes on purpose are not problems:
// the page that does not exist (404), the relayer switched off (502), the chain switched off (429).
const EXPECTED = /Failed to load resource: the server responded with a status of (404|502|429)/;
page.on("console", (message) => {
  if (message.type() === "error" && !EXPECTED.test(message.text())) problems.push(`console.error: ${message.text().slice(0, 300)}`);
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
  for (const id of ["network-strip", "welcome", "relayer-notice", "markets-list", "market-header", "ticket", "ticket-panels", "order-paths", "reconnect", "position", "portfolio", "activity", "system", "offline", "chain-failing", "problem-pages"]) {
    await page.locator(`#${id}`).screenshot({ path: path.join(OUT, `gallery-${id}-${viewport.name}.png`) });
  }

  // The system page is readable without a login.
  await page.goto(`${BASE}/system`, { waitUntil: "networkidle" });
  await page.getByRole("table", { name: "Reconciliation by market" }).waitFor({ timeout: 30_000 });
  await shoot(`system-${viewport.name}`, { fullPage: true });

  // An address with nothing behind it, and a page that throws while drawing (development only).
  await page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "There is nothing at this address" }).waitFor({ timeout: 30_000 });
  await shoot(`not-found-${viewport.name}`);
}

// 1b. A page that throws while drawing shows the error page, not the framework's.
await page.setViewportSize(VIEWPORTS[0]);
const beforeThrow = problems.length;
await page.goto(`${BASE}/dev/throw`, { waitUntil: "networkidle" });
const errorPage = page.getByRole("heading", { name: "This page could not be shown" });
if (await errorPage.isVisible().catch(() => false)) {
  await shoot("error-1280");
} else {
  // The development overlay can sit on top of it; the error page is still in the document.
  console.log("error page in the document:", (await errorPage.count()) > 0);
}
// The page that throws on purpose logs its error; that one is expected.
problems.splice(beforeThrow);

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
await page.click('[data-testid="login-email"]');
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

    // Selling: from a Live row of the portfolio to the ticket's sell tab, with that side chosen.
    await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
    const live = page.getByRole("table", { name: "Live positions" });
    await live.waitFor({ timeout: 30_000 });
    await shoot("portfolio-live-sell-1280");
    await live.getByRole("link", { name: /^Sell / }).first().click();
    await page.waitForURL(/action=sell/);
    const sellTicket = page.locator('[data-testid="ticket"][data-action="sell"]');
    const sell = async (quantity, price) => {
      await sellTicket.waitFor({ timeout: 30_000 });
      await sellTicket.getByLabel("Quantity", { exact: true }).fill(quantity);
      await sellTicket.getByLabel("Minimum price", { exact: true }).fill(price);
    };
    await sellTicket.waitFor({ timeout: 30_000 });
    await shootBoth("market-sell");
    // A sale that could not cover the fee cap is explained, not placed.
    await sell("3.00", "0.03");
    await shootBoth("sell-fee-cap");
    // A sale at the bid: the tokens are burned and test dollars are paid.
    await sell("2.00", "0.55");
    await sellTicket.getByRole("button", { name: /Place order/ }).click();
    await page.locator('[data-testid="order-slip"][data-stamp="FILLED"]').waitFor({ timeout: 30_000 });
    await shootBoth("sell-filled");
    // A sale above the highest bid: not filled, the tokens come back.
    await slip.getByRole("button", { name: "Place another order" }).click();
    await sell("1.00", "0.60");
    await sellTicket.getByRole("button", { name: /Place order/ }).click();
    await page.locator('[data-testid="order-slip"][data-stamp="REFUNDED"]').waitFor({ timeout: 30_000 });
    await shootBoth("sell-returned");

    // Activity: every order with its stamp; one opened in place into its steps and receipt.
    await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
    const orders = page.getByRole("table", { name: "Your orders", exact: true });
    await orders.waitFor({ timeout: 30_000 });
    await shootBoth("activity");
    const filledRows = orders.getByRole("row").filter({ has: page.locator('[data-testid="activity-order"][data-stamp="FILLED"]') });
    const filledRow = filledRows.filter({ has: page.getByText("buy", { exact: true }) }).first();
    await filledRow.getByRole("button", { name: /Details/ }).click();
    await page.getByText("Order receipt").first().waitFor({ timeout: 10_000 });
    await shootBoth("activity-open");
    // The sale that filled, opened: tokens held, proceeds, fee, test dollars paid.
    await filledRow.getByRole("button", { name: /Details/ }).click();
    const soldRow = filledRows.filter({ has: page.getByText("sell", { exact: true }) }).first();
    await soldRow.getByRole("button", { name: /Details/ }).click();
    await page.getByText("Test dollars paid").first().waitFor({ timeout: 10_000 });
    await shootBoth("activity-sale-open");

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

    // Scrolled, in a real viewport: the fixed notice stays above the page and covers no control.
    await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
    await orders.waitFor({ timeout: 30_000 });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => window.scrollTo(0, 420));
      await shoot(`scrolled-${viewport.name}`);
    }
    await page.setViewportSize(VIEWPORTS[0]);

    // Without the relayer. The switch makes the proxy answer as it does for an unreachable relayer;
    // balances, tokens and open orders still come from the (simulated) chain.
    await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
    const liveMarket = await page.getByRole("row").filter({ hasText: "BTC Up" }).filter({ hasText: "YES" }).first().getByRole("link", { name: "BTC Up", exact: true }).getAttribute("href");
    await page.request.get(`${BASE}/api/fixtures/switch?relayer=offline`);
    try {
      const offlineTitle = page.getByText("The relayer is not answering").first();
      await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
      await offlineTitle.waitFor({ timeout: 30_000 });
      await shootBoth("offline-markets");

      await page.goto(`${BASE}${liveMarket}`, { waitUntil: "networkidle" });
      await page.getByText("Orders cannot be placed right now").waitFor({ timeout: 30_000 });
      await shootBoth("offline-market");

      await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
      await offlineTitle.waitFor({ timeout: 30_000 });
      const offlineRedeemable = page.getByRole("table", { name: "Redeemable positions" });
      await page.getByRole("table", { name: "Live positions" }).waitFor({ timeout: 30_000 });
      await shootBoth("offline-portfolio");
      // Redeem needs only Solana. The fixture cycle may have left nothing to redeem by now.
      const offlineAction = offlineRedeemable.getByRole("button", { name: /^(Redeem|Clear) / }).first();
      if (await offlineAction.isVisible().catch(() => false)) {
        const had = await page.locator('[data-testid="redemption-receipt"]').count();
        await offlineAction.click();
        await page.waitForFunction((count) => document.querySelectorAll('[data-testid="redemption-receipt"]').length > count, had, { timeout: 30_000 });
        await shoot("offline-portfolio-redeemed-1280", { fullPage: true });
        console.log("a position was redeemed or cleared with the relayer offline: true");
      } else {
        console.log("nothing redeemable on screen while offline (redeemed earlier in this fixture cycle)");
      }

      await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
      await page.getByText("Listed while the relayer is away").waitFor({ timeout: 30_000 });
      await shootBoth("offline-activity");

      await page.goto(`${BASE}/system`, { waitUntil: "networkidle" });
      await page.getByText("Not known while the relayer is not answering.").first().waitFor({ timeout: 30_000 });
      await shootBoth("offline-system");
    } finally {
      await page.request.get(`${BASE}/api/fixtures/switch?relayer=online`);
    }

    // Solana not answering: every chain read fails as a rate-limited endpoint does. What was read
    // before stays on screen, with a notice.
    await page.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
    await page.getByRole("table", { name: "Live positions" }).waitFor({ timeout: 30_000 });
    const balanceBefore = await balance.innerText();
    await page.request.get(`${BASE}/api/fixtures/switch?chain=failing`);
    try {
      await page.getByText("Solana devnet is not answering").first().waitFor({ timeout: 40_000 });
      console.log("balance kept while chain reads fail:", (await balance.innerText()) === balanceBefore, "| live positions still listed:", await page.getByRole("table", { name: "Live positions" }).isVisible());
      await shootBoth("chain-failing-portfolio");
    } finally {
      await page.request.get(`${BASE}/api/fixtures/switch?chain=ok`);
    }
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

// 8. A wallet login after a page reload: the account is still logged in, but its wallet is no
// longer connected in the tab, so Reconnect wallet takes the place of whatever needs a signature.
// The wallet is the injected test wallet; its key file is only read, never created here.
const KEY_FILE = process.env.E2E_WALLET_KEYPAIR ?? path.resolve(import.meta.dirname, "../../../.keys/e2e-wallet-keypair.json");
if (!fixtures || !existsSync(KEY_FILE)) {
  console.log("skipping the reconnect screens: they need fixtures mode and the test wallet's key file");
} else {
  const walletContext = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2, timezoneId: "UTC", reducedMotion: "reduce" });
  await walletContext.addInitScript(installTestWallet, { keypair: loadTestWalletKey(KEY_FILE), name: TEST_WALLET_NAME });
  const walletPage = await walletContext.newPage();
  const capture = async (name) => {
    await walletPage.evaluate(() => document.fonts.ready);
    await walletPage.waitForTimeout(400);
    await walletPage.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("wrote", `e2e/out/${name}.png`);
  };
  try {
    await walletPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
    await walletPage.click('[data-testid="login"]:not([disabled])');
    await walletPage.click(`[data-testid="login-wallet"][data-wallet="${TEST_WALLET_NAME}"]`);
    await walletPage.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });
    await walletPage.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
    await walletPage.getByRole("row").filter({ hasText: "BTC Up" }).first().getByRole("link", { name: "BTC Up", exact: true }).click();
    await walletPage.waitForURL(/\/markets\/.+/);
    // The navigation above was a full page load, which is the reload this is about.
    const reconnect = walletPage.locator('[data-testid="reconnect"]');
    await reconnect.waitFor({ timeout: 60_000 });
    for (const viewport of VIEWPORTS) {
      await walletPage.setViewportSize(viewport);
      await reconnect.scrollIntoViewIfNeeded();
      await capture(`reconnect-${viewport.name}`);
    }
    await walletPage.setViewportSize(VIEWPORTS[0]);
    await walletPage.goto(`${BASE}/portfolio`, { waitUntil: "networkidle" });
    await walletPage.getByRole("table", { name: "Redeemable positions" }).getByRole("button", { name: /^Reconnect wallet to/ }).first().waitFor({ timeout: 30_000 });
    await walletPage.getByRole("table", { name: "Redeemable positions" }).scrollIntoViewIfNeeded();
    await capture("reconnect-portfolio-1280");
    // Reconnecting asks the wallet to connect again, which brings the action back.
    await walletPage.getByRole("button", { name: /^Reconnect wallet to/ }).first().click();
    await walletPage.getByRole("button", { name: /^Redeem / }).first().waitFor({ timeout: 30_000 });
    console.log("after reconnecting, Redeem is back in place of Reconnect:", (await walletPage.getByRole("button", { name: /^Reconnect wallet to/ }).count()) === 0);
  } catch (error) {
    await walletPage.screenshot({ path: path.join(OUT, "failure-reconnect.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await walletContext.close();
  }
}

await browser.close();
if (problems.length > 0) {
  console.log(`${problems.length} browser problem(s):`);
  for (const problem of [...new Set(problems)].slice(0, 12)) console.log(" ", problem);
}
if (flashed) process.exitCode = 1;
