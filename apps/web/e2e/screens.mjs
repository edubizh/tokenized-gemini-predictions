// Captures the screens of the web app for visual review.
//
//   pnpm exec next dev -p 3100            (with RELAYER_URL=fixtures in the environment)
//   node --env-file=../../.env e2e/screens.mjs
//
// Writes PNG files to e2e/out/ at 1280x800 and 390x844: the landing page, the component gallery
// (full page) and, after logging in with the test account, the welcome screen. The test login is
// read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
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
await page.waitForSelector('[data-testid="welcome"]:not([data-state="loading"])', { timeout: 90_000 });
console.log("welcome state:", await page.getAttribute('[data-testid="welcome"]', "data-state"));

for (const viewport of VIEWPORTS) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  await shoot(`welcome-${viewport.name}`, { fullPage: true });
}

// 4. The account menu, opened from the keyboard.
await page.setViewportSize(VIEWPORTS[0]);
await page.locator('header button[aria-haspopup="menu"]').focus();
await page.keyboard.press("ArrowDown");
await shoot("welcome-menu-1280");

// 5. A returning, logged-in browser must not paint the logged-out landing page.
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
