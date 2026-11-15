// Checks every page at six widths, from the keyboard, and with reduced motion.
//
//   pnpm exec next dev -p 3100            (with RELAYER_URL=fixtures in the environment)
//   node --env-file=../../.env e2e/responsive.mjs
//
// Per page and width it reports: horizontal overflow and what causes it, whether the fixed notice
// overlaps the top bar, and controls smaller than 24 by 24 CSS pixels. Then, at two widths, it
// tabs through each page and reports the focus order and any control that takes focus without a
// visible ring, and it reports anything that still animates under reduced motion. It prints
// findings and exits non-zero when there are any. Viewport captures go to e2e/out/widths/.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.SCREENS_BASE_URL ?? "http://localhost:3100";
const OUT = path.join(import.meta.dirname, "out", "widths");
const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
const VERBOSE = process.env.VERBOSE === "1";

const email = process.env.PRIVY_TEST_EMAIL;
const otp = process.env.PRIVY_TEST_OTP;
if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "UTC", reducedMotion: "reduce" });
const page = await context.newPage();
const findings = [];
const report = (where, what) => {
  findings.push(`${where}: ${what}`);
  console.log(`  FINDING ${where}: ${what}`);
};

/** What is wrong with the layout of the page as it stands, measured in the page. */
function measure() {
  const width = document.documentElement.clientWidth;
  const out = { overflow: document.documentElement.scrollWidth - width, offenders: [], small: [], strip: null, moving: [] };
  const scrolls = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
    }
    return false;
  };
  const name = (element) => `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.split(" ")[0]}` : ""} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
  for (const element of document.body.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (element.closest(".sr-only") || style.clip === "rect(0px, 0px, 0px, 0px)") continue;
    if ((rect.right > width + 1 || rect.left < -1) && !scrolls(element) && out.offenders.length < 6) out.offenders.push(`${name(element)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${width}`);
    if (element.matches("a[href], button, input, select, textarea, [role=radio], [role=tab], [role=menuitem]")) {
      // Links inside a sentence are exempt from the target size rule.
      const inline = element.matches("a") && style.display.startsWith("inline") && element.parentElement && element.parentElement.textContent.trim().length > (element.textContent ?? "").trim().length + 8;
      if (!inline && (rect.width < 24 || rect.height < 24) && out.small.length < 8) out.small.push(`${name(element)} is ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    const moves = (style.animationName !== "none" && parseFloat(style.animationDuration) > 0.01 && style.animationIterationCount !== "1") || false;
    if (moves && out.moving.length < 5) out.moving.push(`${name(element)} animates ${style.animationName} for ${style.animationDuration}`);
  }
  const strip = document.querySelector('[aria-label="Test network notice"]');
  const bar = document.querySelector("body header");
  if (strip && bar && window.scrollY === 0) {
    const stripRect = strip.getBoundingClientRect();
    const text = strip.querySelector("p");
    out.strip = { bottom: Math.round(stripRect.bottom), barTop: Math.round(bar.getBoundingClientRect().top), textHeight: text ? Math.round(text.getBoundingClientRect().height) : 0, height: Math.round(stripRect.height) };
  }
  return out;
}

async function check(label, { capture = true } = {}) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 700 ? 800 : 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(250);
    const result = await page.evaluate(measure);
    const where = `${label} @${width}`;
    if (result.overflow > 1) report(where, `page is ${result.overflow}px wider than the viewport: ${result.offenders.join("; ") || "no single element found"}`);
    else if (result.offenders.length > 0) report(where, `clipped content: ${result.offenders.join("; ")}`);
    if (result.strip && result.strip.barTop < result.strip.bottom) report(where, `the fixed notice (bottom ${result.strip.bottom}) overlaps the top bar (top ${result.strip.barTop})`);
    if (result.strip && result.strip.textHeight > result.strip.height) report(where, `the notice text (${result.strip.textHeight}px) is taller than its strip (${result.strip.height}px)`);
    if (result.small.length > 0) report(where, `small targets: ${result.small.join("; ")}`);
    if (result.moving.length > 0) report(where, `moves under reduced motion: ${result.moving.join("; ")}`);
    if (capture) await page.screenshot({ path: path.join(OUT, `${label}-${width}.png`) });
  }
  console.log(`checked ${label}`);
}

/** Tabs through the page and returns what took focus, in order, with whether a ring was drawn. */
async function tabThrough(label, limit = 60) {
  // Focus starts from the top of the document, wherever the last pass left it.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  const order = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      // The ring is drawn on the control itself or, for a field, on the box around it.
      const ringed = (node) => {
        const style = getComputedStyle(node);
        return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== "none";
      };
      const ring = ringed(element) || (element.parentElement !== null && (ringed(element.parentElement) || (element.parentElement.parentElement !== null && ringed(element.parentElement.parentElement))));
      const rect = element.getBoundingClientRect();
      const text = (element.getAttribute("aria-label") ?? element.textContent ?? element.getAttribute("name") ?? "").trim().replace(/\s+/g, " ").slice(0, 48);
      const labelled = "labels" in element && element.labels && element.labels.length > 0 ? element.labels[0].textContent.trim() : null;
      return { key: `${element.tagName.toLowerCase()}[${element.getAttribute("role") ?? element.getAttribute("type") ?? ""}] ${labelled ?? text}`, ring, named: (labelled ?? text).length > 0, visible: rect.width > 0 && rect.height > 0, inFooter: element.closest("footer") !== null };
    });
    if (!info) break;
    order.push(info.key);
    if (!info.ring) report(label, `no visible focus ring on ${info.key}`);
    if (!info.named) report(label, `no accessible name on ${info.key}`);
    if (!info.visible) report(label, `focus went to something not visible: ${info.key}`);
    if (info.inFooter) break;
  }
  if (VERBOSE) console.log(`  focus order, ${label}:\n    ${order.join("\n    ")}`);
  console.log(`tabbed ${label}: ${order.length} stops`);
  return order;
}

// Logged out.
for (const [label, route, ready] of [
  ["landing", "/", '[data-testid="login"]:not([disabled])'],
  ["system", "/system", "[role=table]"],
  ["not-found", "/no-such-page", '[data-testid="problem"]'],
  ["gallery", "/dev/gallery", "#problem-pages"],
]) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await page.waitForSelector(ready, { timeout: 60_000 });
  await check(label, { capture: label !== "gallery" });
}
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await tabThrough("landing, keyboard");

// Log in.
await page.click('[data-testid="login"]:not([disabled])');
await page.click('[data-testid="login-email"]');
const emailInput = page.locator('input[type="email"]').first();
await emailInput.waitFor({ timeout: 30_000 });
await emailInput.fill(email);
await emailInput.press("Enter");
await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
await page.waitForURL(/\/(welcome|markets)/, { timeout: 90_000 });
await page.waitForFunction(() => document.querySelector('[role="dialog"], #privy-dialog, #privy-modal-content') === null, null, { timeout: 60_000 });

await page.goto(`${BASE}/markets`, { waitUntil: "networkidle" });
const marketLink = page.getByRole("row").filter({ hasText: "BTC Up" }).filter({ hasText: "YES" }).first().getByRole("link", { name: "BTC Up", exact: true });
await marketLink.waitFor({ timeout: 30_000 });
const marketPath = await marketLink.getAttribute("href");

const pages = [
  ["welcome", "/welcome", '[data-testid="welcome"]:not([data-state="loading"])'],
  ["markets", "/markets", "[role=table]"],
  ["market", marketPath, '[data-testid="ticket"]'],
  ["market-sell", `${marketPath}?side=YES&action=sell`, '[data-testid="ticket"][data-action="sell"]'],
  ["portfolio", "/portfolio", '[data-testid="group-redeemable"]'],
  ["activity", "/activity", '[data-testid="activity-order"]'],
];
for (const [label, route, ready] of pages) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  await page.waitForSelector(ready, { timeout: 60_000 });
  await check(label);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await tabThrough(`${label}, keyboard @${width}`);
  }
}

// The keyboard alone: the account menu, the side toggle, the sell tab, an activity row.
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`${BASE}${marketPath}`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="ticket"]', { timeout: 60_000 });
const menuButton = page.locator('header button[aria-haspopup="menu"]');
await menuButton.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const menuOpen = await page.locator('[role="menu"]').isVisible();
const firstItem = await page.evaluate(() => document.activeElement?.getAttribute("role"));
await page.keyboard.press("Escape");
const menuClosed = !(await page.locator('[role="menu"]').isVisible());
const backOnButton = await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup") === "menu");
if (!menuOpen || firstItem !== "menuitem" || !menuClosed || !backOnButton) report("account menu, keyboard", `open ${menuOpen}, focus on first item ${firstItem === "menuitem"}, Escape closes ${menuClosed}, focus returns ${backOnButton}`);
else console.log("account menu: opens with Enter, focus on the first item, Escape closes and returns focus");

const ticket = page.locator('[data-testid="ticket"]');
const yes = ticket.getByRole("radio", { name: "YES" });
await yes.focus();
await page.keyboard.press("ArrowRight");
const noChecked = await ticket.getByRole("radio", { name: "NO" }).isChecked();
if (!noChecked) report("side toggle, keyboard", "ArrowRight did not move from YES to NO");
else console.log("side toggle: arrow keys move between YES and NO");
const sellTab = ticket.getByRole("tab", { name: "Sell" });
if ((await sellTab.count()) > 0) {
  await ticket.getByRole("tab", { name: "Buy" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  const selling = (await ticket.getAttribute("data-action")) === "sell";
  if (!selling) report("sell tab, keyboard", "the Sell tab could not be chosen from the keyboard");
  else console.log("sell tab: reached and chosen from the keyboard");
} else {
  console.log("sell tab: not on screen (the wallet holds no tokens of this market)");
}

await page.goto(`${BASE}/activity`, { waitUntil: "networkidle" });
const details = page.getByRole("button", { name: /Details/ }).first();
await details.waitFor({ timeout: 30_000 });
const was = await details.getAttribute("aria-expanded");
await details.focus();
await page.keyboard.press("Enter");
const now = await details.getAttribute("aria-expanded");
if (was === now) report("activity row, keyboard", "Enter did not toggle the row");
else console.log(`activity row: Enter toggles aria-expanded ${was} -> ${now}`);
for (const name of [/^Reclaim/, /^Redeem /, /^Clear /]) {
  const route = String(name).includes("Reclaim") ? "/activity" : "/portfolio";
  // A fresh load: an expired order's row starts open, with Reclaim on screen.
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
  const button = page.getByRole("button", { name }).first();
  const found = await button.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!found) {
    console.log(`${name}: no such button on screen in this fixture cycle`);
    continue;
  }
  await button.focus();
  const ring = await button.evaluate((element) => getComputedStyle(element).outlineStyle !== "none" && parseFloat(getComputedStyle(element).outlineWidth) >= 2);
  if (!ring) report(`${name}, keyboard`, "no visible focus ring");
  else console.log(`${name}: takes focus with a visible ring`);
}

// Without the relayer, the same pages.
await page.request.get(`${BASE}/api/fixtures/switch?relayer=offline`);
try {
  for (const [label, route, ready] of [
    ["offline-markets", "/markets", "text=The relayer is not answering"],
    ["offline-market", marketPath, "text=Orders cannot be placed right now"],
    ["offline-portfolio", "/portfolio", '[data-testid="group-live"] [role=table]'],
    ["offline-activity", "/activity", "text=Listed while the relayer is away"],
  ]) {
    await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
    await page.waitForSelector(ready, { timeout: 60_000 });
    await check(label);
  }
} finally {
  await page.request.get(`${BASE}/api/fixtures/switch?relayer=online`);
}

await browser.close();
console.log(findings.length === 0 ? "no findings" : `${findings.length} finding(s)`);
if (findings.length > 0) process.exitCode = 1;
