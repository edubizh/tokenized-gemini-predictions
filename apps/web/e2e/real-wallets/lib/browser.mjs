// A test browser with real wallet extensions: Chromium on a profile directory of its own under
// <repo>/.data/wallet-profiles/ (git-ignored), with the unpacked extensions loaded. Everything a
// run does is written to a log, and every extension window that opens is recorded with a
// screenshot, so a run that hangs still shows what was (and was not) on screen.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ensureExtension } from "./extensions.mjs";

const REPO = path.resolve(import.meta.dirname, "../../../../..");
export const PROFILES_DIR = path.join(REPO, ".data/wallet-profiles");
export const OUT_DIR = path.join(REPO, "apps/web/e2e/out/real-wallets");

const browserVersion = () => /(\d+\.\d+\.\d+\.\d+)/.exec(execFileSync(chromium.executablePath(), ["--version"], { encoding: "utf8" }))?.[1];

/** Calls to the login provider's API. Only the method, the path and the status are logged. */
const LOGIN_API = /^https:\/\/[a-z.]*privy\.io\/api\/v1\/(?!analytics_events|apps\/)/;

/**
 * Starts the browser. `wallets` are names from `WALLETS`; `profile` names the profile directory
 * (pass `fresh` to start it empty); `run` names the evidence directory under e2e/out/real-wallets/.
 * `headless: false` opens real windows, for the cases that depend on window focus.
 */
export async function launch({ wallets, profile, run, fresh = false, headless = true }) {
  const extensions = [];
  for (const name of wallets) extensions.push(await ensureExtension(name, { browserVersion: browserVersion() }));
  const profileDir = path.join(PROFILES_DIR, profile);
  if (fresh) rmSync(profileDir, { recursive: true, force: true });
  const out = path.join(OUT_DIR, run);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const started = Date.now();
  const logFile = path.join(out, "events.log");
  const log = (kind, text) => {
    const line = `${((Date.now() - started) / 1000).toFixed(2).padStart(7)}s ${kind.padEnd(9)} ${text}`;
    appendFileSync(logFile, `${line}\n`);
    console.log(line);
  };

  const dirs = extensions.map((extension) => extension.dir).join(",");
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${dirs}`, `--load-extension=${dirs}`],
  });
  for (const extension of extensions) log("extension", `${extension.label} ${extension.version} (${extension.id})`);

  let shots = 0;
  const shoot = async (page, name) => {
    if (page.isClosed()) return;
    const file = `${String(++shots).padStart(2, "0")}-${name}.png`;
    await page.screenshot({ path: path.join(out, file) }).then(
      () => log("shot", file),
      (error) => log("shot", `${file} failed: ${String(error).split("\n")[0]}`),
    );
  };

  const extensionOf = (url) => extensions.find((extension) => url.startsWith(`chrome-extension://${extension.id}/`));
  /** Every extension window opened so far, newest last: `{ page, extension, url, openedAt }`. */
  const windows = [];
  const watch = (page) => {
    page.on("console", (message) => {
      const url = page.url();
      if (extensionOf(url) || !["error", "warning"].includes(message.type())) return;
      log(`console.${message.type().slice(0, 4)}`, message.text().slice(0, 400));
    });
    page.on("pageerror", (error) => log("pageerror", String(error).slice(0, 400)));
    page.on("close", () => log("closed", page.url().slice(0, 120)));
    page.on("response", (response) => {
      const url = response.url();
      if (LOGIN_API.test(url)) log("login-api", `${response.request().method()} ${new URL(url).pathname} -> ${response.status()}`);
    });
  };
  context.on("page", async (page) => {
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    const url = page.url();
    const extension = extensionOf(url);
    log("opened", `${extension ? `${extension.label} window` : "page"} ${url.slice(0, 120)}`);
    if (extension) windows.push({ page, extension, url, openedAt: Date.now() });
    watch(page);
  });
  for (const page of context.pages()) watch(page);

  /** Waits for the next window of the named wallet that is opened after `since`; null on timeout. */
  const waitForWindow = async (name, { since = Date.now(), timeout = 20_000 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = windows.find((entry) => entry.extension.name === name && entry.openedAt >= since && !entry.page.isClosed());
      if (found) return found.page;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  };

  /** Closes the browser and deletes its profile: every run starts from an empty one. */
  const close = async () => {
    await context.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
  };

  return { context, extensions, out, log, shoot, windows, waitForWindow, close, extension: (name) => extensions.find((entry) => entry.name === name) };
}
