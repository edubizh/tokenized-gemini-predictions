// Checks every route and state of the web app at phone widths, 390 and 360.
//
//   RELAYER_URL=fixtures pnpm exec next dev -p 3100
//   node --env-file=../../.env e2e/responsive.mjs
//
// Runs in fixtures mode only. Visits the same states as screens.mjs (without placing an order) and,
// at each width, reports horizontal overflow and what causes it, and any interactive target smaller
// than 44 by 44 CSS pixels (links inside a sentence are exempt). Captures each state at 390 to
// e2e/out/widths/. Exits non-zero when there is any finding, page error or missing landmark.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { flip, loggedInStates, loggedOutStates, logIn, pickEvents } from "./lib/fixtures-states.mjs";

const OUT = path.join(import.meta.dirname, "out", "widths");
const WIDTHS = [390, 360];
const TARGET = 44;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: WIDTHS[0], height: 844 }, timezoneId: "UTC", reducedMotion: "reduce" });
const page = await context.newPage();
const findings = [];
let current = "start";
const report = (where, what) => {
  findings.push(`${where}: ${what}`);
  console.log(`  FINDING ${where}: ${what}`);
};
const EXPECTED = /Failed to load resource: the server responded with a status of (404|502|429)/;
page.on("pageerror", (error) => report(current, `pageerror: ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
  if (message.type() === "error" && !EXPECTED.test(message.text())) report(current, `console.error: ${message.text().slice(0, 300)}`);
});

/** What is wrong with the layout of the page as it stands, measured in the page. */
function measure(target) {
  const width = document.documentElement.clientWidth;
  const out = { overflow: document.documentElement.scrollWidth - width, offenders: [], small: [] };
  const scrolls = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowX)) return true;
    }
    return false;
  };
  const name = (element) => `${element.tagName.toLowerCase()}${element.dataset.testid ? `[${element.dataset.testid}]` : ""} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
  // A link whose ::after is stretched over a positioned ancestor (a card) is as large as that ancestor.
  const stretched = (element) => element.matches("a") && element.offsetParent !== null && getComputedStyle(element, "::after").position === "absolute";
  // With a modal dialog open, only the dialog can be reached.
  const scope = document.querySelector("dialog[open]") ?? document.body;
  for (const element of scope.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (element.closest(".sr-only") || style.clip === "rect(0px, 0px, 0px, 0px)") continue;
    if ((rect.right > width + 1 || rect.left < -1) && !scrolls(element) && out.offenders.length < 6) out.offenders.push(`${name(element)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} of ${width}`);
    if (element.matches("a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=radio], [role=tab], [role=menuitem]")) {
      // Links inside a sentence are exempt from the target size rule.
      const inline = element.matches("a") && style.display.startsWith("inline") && element.parentElement && element.parentElement.textContent.trim().length > (element.textContent ?? "").trim().length + 8;
      // A native radio or checkbox is measured by its label; a text input by the bordered box drawn
      // around it, which is what the eye and the finger aim at.
      const box = element.matches("input[type=radio], input[type=checkbox]") && element.closest("label") ? element.closest("label").getBoundingClientRect() : element.matches("input, textarea, select") ? element.parentElement.getBoundingClientRect() : stretched(element) ? element.offsetParent.getBoundingClientRect() : rect;
      if (!inline && (box.width < target - 0.5 || box.height < target - 0.5) && out.small.length < 8) out.small.push(`${name(element)} is ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  return out;
}

let captured = 0;
async function check(state) {
  current = state.name;
  try {
    await page.setViewportSize({ width: WIDTHS[0], height: 844 });
    await state.run(page, context);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(300);
      const result = await page.evaluate(measure, TARGET);
      const where = `${state.name} @${width}`;
      if (result.overflow > 1) report(where, `page is ${result.overflow}px wider than the viewport: ${result.offenders.join("; ") || "no single element found"}`);
      else if (result.offenders.length > 0) report(where, `clipped content: ${result.offenders.join("; ")}`);
      if (result.small.length > 0) report(where, `targets under ${TARGET}px: ${result.small.join("; ")}`);
      if (width === 390) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: path.join(OUT, `${state.name}-390.png`), fullPage: true });
        captured++;
      }
    }
    console.log(`checked ${state.name}`);
  } catch (error) {
    report(state.name, String(error).split("\n")[0].slice(0, 300));
    await page.screenshot({ path: path.join(OUT, `failure-${state.name}.png`), fullPage: true }).catch(() => {});
  } finally {
    if (state.undo) await flip(context, state.undo).catch(() => {});
  }
}

const picks = await pickEvents(context.request);
for (const state of loggedOutStates(picks)) await check(state);
current = "login";
await page.keyboard.press("Escape");
await logIn(page);
for (const state of loggedInStates(picks)) await check(state);

await browser.close();
console.log(`${captured} screenshots at 390 in ${path.relative(process.cwd(), OUT)}`);
if (findings.length > 0) {
  console.log(`${findings.length} finding(s)`);
  process.exitCode = 1;
} else {
  console.log("no findings at 390 and 360");
}
