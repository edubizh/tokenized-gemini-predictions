// Counts the requests each page makes in one minute, to keep polling within what the public RPC
// endpoint allows.
//
//   pnpm exec next dev -p 3100            (with RELAYER_URL=fixtures in the environment)
//   node --env-file=../../.env e2e/rpc-count.mjs
//
// In fixtures mode every chain read is one request to /api/fixtures/chain, named by its `read`
// parameter, so the count per page is the number of chain reads it would send to Solana. Requests
// to the relayer proxy are counted beside them. All pages are open at once, each in its own tab.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENS_BASE_URL ?? "http://localhost:3100";
const WINDOW_MS = Number(process.env.COUNT_WINDOW_MS ?? 60_000);

const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const first = await context.newPage();

await first.goto(`${BASE}/`, { waitUntil: "networkidle" });
await first.click('[data-testid="login"]:not([disabled])');
await first.click('[data-testid="login-email"]');
const emailInput = first.locator('input[type="email"]').first();
await emailInput.waitFor({ timeout: 30_000 });
await emailInput.fill(email);
await emailInput.press("Enter");
await first.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
for (let i = 0; i < 6; i++) await first.locator(`input[name="code-${i}"]`).fill(otp[i]);
await first.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });

await first.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
const marketLink = first.getByRole("row").filter({ hasText: "BTC Up" }).filter({ hasText: "YES" }).first().getByRole("link", { name: "BTC Up", exact: true });
await marketLink.waitFor({ timeout: 30_000 });
const marketPath = await marketLink.getAttribute("href");
await first.close();

const routes = ["/markets", marketPath, "/portfolio", "/activity", "/system", "/welcome"];
const results = await Promise.all(
  routes.map(async (route) => {
    const page = await context.newPage();
    const counts = { chain: 0, relayer: 0, reads: {} };
    let counting = false;
    page.on("request", (request) => {
      if (!counting) return;
      const url = new URL(request.url());
      if (url.pathname === "/api/fixtures/chain") {
        counts.chain += 1;
        const read = url.searchParams.get("read") ?? "unnamed";
        counts.reads[read] = (counts.reads[read] ?? 0) + 1;
      } else if (url.pathname.startsWith("/api/relayer/")) {
        counts.relayer += 1;
      }
    });
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    // The first reads of a page load are left out: the count is of steady polling.
    await page.waitForTimeout(3_000);
    counting = true;
    await page.waitForTimeout(WINDOW_MS);
    counting = false;
    return { route: route.startsWith("/markets/") ? "/markets/[symbol]" : route, ...counts };
  }),
);

await browser.close();
console.log(`requests in ${WINDOW_MS / 1000} s of steady polling, per page`);
for (const result of results) {
  const reads = Object.entries(result.reads).map(([name, count]) => `${name} ${count}`).join(", ");
  console.log(`${result.route.padEnd(20)} chain ${String(result.chain).padStart(3)}   relayer ${String(result.relayer).padStart(3)}${reads ? `   (${reads})` : ""}`);
}
