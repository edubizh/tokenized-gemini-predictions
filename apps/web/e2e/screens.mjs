// Captures every route and state of the web app at 1280 wide, for visual review.
//
//   RELAYER_URL=fixtures pnpm exec next dev -p 3100
//   node --env-file=../../.env e2e/screens.mjs
//
// Runs in fixtures mode only, where the relayer and the chain are simulated and nothing reaches a
// network. Writes PNG files to e2e/out/: the markets index (default, filtered, no match), event
// pages (a ladder, a binary event, a ladder with no offers, an event not trading yet, an address
// with no event), the trade panel (logged out, ready to buy, no offer on the chosen side), the
// portfolio logged out, the system and vaults pages, the login dialog; then, logged in with the
// test account, an order placed and followed to FILLED, the portfolio (with positions, first run,
// Solana failing), the activity list with an order opened, and the index, an event, the portfolio
// and the system page with the relayer offline. Exits non-zero on any page error, unexpected
// console error or landmark that does not appear.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { BASE, flip, freshTicketPath, go, landmark, loggedInStates, loggedOutStates, logIn, pickEvents } from "./lib/fixtures-states.mjs";

const OUT = path.join(import.meta.dirname, "out");
const VIEWPORT = { width: 1280, height: 800 };

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, timezoneId: "UTC", reducedMotion: "reduce" });
const page = await context.newPage();
const problems = [];
let current = "start";
page.on("pageerror", (error) => problems.push(`${current}: pageerror: ${String(error).slice(0, 300)}`));
// The browser logs every failed request. Those the script causes on purpose are not problems:
// the event that does not exist (404), the relayer switched off (502), the chain switched off (429).
const EXPECTED = /Failed to load resource: the server responded with a status of (404|502|429)/;
page.on("console", (message) => {
  if (message.type() === "error" && !EXPECTED.test(message.text())) problems.push(`${current}: console.error: ${message.text().slice(0, 300)}`);
});

let written = 0;
async function shoot(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const file = path.join(OUT, `${name}-1280.png`);
  await page.screenshot({ path: file, fullPage: true });
  written++;
  console.log("wrote", path.relative(process.cwd(), file));
}

/** Runs one state and captures it; a state that fails is recorded with what was on screen. */
async function capture(state) {
  current = state.name;
  try {
    await state.run(page, context);
    await shoot(state.name);
  } catch (error) {
    problems.push(`${state.name}: ${String(error).split("\n")[0].slice(0, 300)}`);
    await page.screenshot({ path: path.join(OUT, `failure-${state.name}.png`), fullPage: true }).catch(() => {});
  } finally {
    if (state.undo) await flip(context, state.undo).catch(() => {});
  }
}

const picks = await pickEvents(context.request);
console.log("events:", ["ladder", "binary", "noOffers", "notTrading"].map((key) => `${key}=${picks[key].ticker}`).join(" "), `oneSided=${picks.oneSided.symbol}/${picks.oneSided.side}`);

// 1. Logged out.
for (const state of loggedOutStates(picks)) await capture(state);
// The index with the relayer offline, before the login (the other offline screens follow it).
await capture({
  name: "offline-index-logged-out",
  run: async () => {
    await flip(context, "relayer=offline");
    await go(page, "/");
    await landmark(page, page.getByText("The relayer is not answering"));
  },
  undo: "relayer=online",
});

// 2. Logged in.
current = "login";
await page.keyboard.press("Escape");
await logIn(page);
for (const state of loggedInStates(picks)) await capture(state);

// 3. An order placed from the trade panel and followed to FILLED.
const slip = page.locator('[data-testid="order-slip"]');
await capture({
  name: "order-placed",
  run: async () => {
    // Chosen now, not at the start: a contract picked earlier may have closed in the meantime.
    await go(page, await freshTicketPath(context.request));
    await landmark(page, page.locator('[data-testid="place"]:not([disabled])'), 60_000);
    await page.locator('[data-testid="ticket-quantity"] input, input[data-testid="ticket-quantity"]').first().fill("2");
    await page.locator('[data-testid="place"]').click();
    await slip.waitFor({ timeout: 60_000 });
  },
});
await capture({
  name: "order-filled",
  run: async () => {
    await page.locator('[data-testid="order-slip"][data-stamp="FILLED"]').waitFor({ timeout: 120_000 });
  },
});

await browser.close();
console.log(`${written} screenshots in ${path.relative(process.cwd(), OUT)} from ${BASE}`);
if (problems.length > 0) {
  console.log(`${problems.length} problem(s):`);
  for (const problem of [...new Set(problems)].slice(0, 20)) console.log(" ", problem);
  process.exitCode = 1;
} else {
  console.log("no page errors, every landmark found");
}
