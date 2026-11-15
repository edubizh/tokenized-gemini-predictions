// Screenshots of every page against a real cluster and a running relayer, at 1280 and 390 wide,
// first logged out and then logged in with the test e-mail account. Nothing is traded.
//
//   pnpm dev                                   (relayer and web app; or the two started separately)
//   node --env-file=../../.env e2e/live-screens.mjs
//
// The events are picked from the relayer's listing at run time: an hourly ladder, a 15-minute event
// (a 5-minute one when none is listed) and a ladder with no offers. Writes e2e/out/live/
// {out,in}-<page>-<width>.png. Exits non-zero on a page error, an unexpected console error, a
// missing landmark or horizontal overflow at 390. The test login is read from PRIVY_TEST_EMAIL and
// PRIVY_TEST_OTP and is never printed. LIVE_BASE_URL overrides http://localhost:3200.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { eventPath, landmark, logIn } from "./lib/fixtures-states.mjs";

const BASE = process.env.LIVE_BASE_URL || "http://localhost:3200";
const OUT = path.join(import.meta.dirname, "out", "live");
const WIDTHS = [1280, 390];
const EXPECTED = /Failed to load resource: the server responded with a status of (404|502|429)/;

/** The events to show, chosen from what the relayer lists now. */
async function pickEvents(request) {
  const response = await request.get(`${BASE}/api/relayer/events`);
  if (!response.ok()) throw new Error(`the relayer events did not load (HTTP ${response.status()})`);
  const { events } = await response.json();
  const active = events.filter((e) => e.venueStatus === "active");
  // Tradable for a few minutes more, so the page is still taking orders when it is captured.
  const quoted = (e) => e.markets.some((m) => m.tradable && m.lastOrderAt - Date.now() > 180_000);
  const find = (label, ...tests) => {
    for (const test of tests) {
      const event = active.find(test);
      if (event) return event;
    }
    throw new Error(`no event listed for: ${label}`);
  };
  return {
    ladder: find("an hourly ladder", (e) => e.shape === "ladder" && e.cadence === "hourly" && quoted(e), (e) => e.shape === "ladder" && e.cadence === "hourly"),
    short: find("a 15- or 5-minute event", (e) => e.cadence === "15m" && quoted(e), (e) => e.cadence === "15m", (e) => e.cadence === "5m"),
    noOffers: find(
      "a ladder with no offers",
      (e) => e.shape === "ladder" && e.category === "Commodities" && e.markets.every((m) => m.notTradableReason === "no_offers"),
      (e) => e.shape === "ladder" && e.cadence === "monthly" && e.markets.every((m) => m.notTradableReason === "no_offers"),
    ),
  };
}

const testId = (page, id) => page.locator(`[data-testid="${id}"]`);

function screens(picks, loggedIn) {
  const main = (page) => page.locator("main#content h1, main#content h2");
  return [
    { name: "index", route: "/", ready: (page) => testId(page, "event-card") },
    { name: "ladder", route: eventPath(picks.ladder), ready: (page) => testId(page, "contract-row") },
    { name: "short", route: eventPath(picks.short), ready: (page) => testId(page, "ticket") },
    { name: "no-offers", route: eventPath(picks.noOffers), ready: (page) => testId(page, "contract-row") },
    { name: "portfolio", route: "/portfolio", ready: (page) => (loggedIn ? testId(page, "portfolio-balance") : main(page)) },
    { name: "activity", route: "/activity", ready: (page) => (loggedIn ? testId(page, "activity-order").or(page.getByText("No orders yet")) : main(page)) },
    { name: "system", route: "/system", ready: (page) => testId(page, "system-status") },
    { name: "vaults", route: "/vaults", ready: main },
  ];
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 900 }, reducedMotion: "reduce" });
const page = await context.newPage();
const findings = [];
let current = "start";
const report = (what) => {
  findings.push(`${current}: ${what}`);
  console.log(`  FINDING ${current}: ${what}`);
};
page.on("pageerror", (error) => report(`pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error" && !EXPECTED.test(message.text())) report(`console.error: ${message.text().slice(0, 300)}`);
});

async function capture(prefix, screen) {
  for (const width of WIDTHS) {
    current = `${prefix}-${screen.name}-${width}`;
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${BASE}${screen.route}`, { waitUntil: "networkidle" });
      await landmark(page, screen.ready(page), 60_000);
      // Live prices, balances and the chain arrive after the first paint.
      await page.waitForTimeout(3_000);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (width < 1280 && overflow > 1) report(`page is ${overflow}px wider than the viewport`);
      await page.screenshot({ path: path.join(OUT, `${current}.png`), fullPage: true });
      console.log("wrote", `e2e/out/live/${current}.png`);
    } catch (error) {
      report(String(error).split("\n")[0].slice(0, 300));
      await page.screenshot({ path: path.join(OUT, `failure-${current}.png`), fullPage: true }).catch(() => {});
    }
  }
}

try {
  const picks = await pickEvents(context.request);
  console.log("events:", picks.ladder.ticker, picks.short.ticker, picks.noOffers.ticker);
  for (const screen of screens(picks, false)) await capture("out", screen);
  current = "login";
  await page.setViewportSize({ width: WIDTHS[0], height: 900 });
  await logIn(page, BASE);
  for (const screen of screens(picks, true)) await capture("in", screen);
} catch (error) {
  report(String(error).split("\n")[0].slice(0, 300));
} finally {
  await browser.close();
}
if (findings.length > 0) {
  console.log(`${findings.length} finding(s)`);
  process.exitCode = 1;
} else {
  console.log(`no findings; screenshots in ${path.relative(process.cwd(), OUT)}`);
}
