// Where a wallet shows a request: its side panel, or a window of its own. Phantom and MetaMask both
// show a request inside their side panel instead of opening a window when the panel is open, and a
// side panel is not a page the test driver knows about, so it is reached through the browser's
// debugging protocol from any ordinary page. Both places are given the same small interface (a
// "surface"), so a request is read and answered the same way wherever it shows.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a page's markup says, on one line. Works on pages that are guarded against scripts. */
const plain = (markup) =>
  markup
    .replace(/<(script|style|svg|noscript)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** The protocol id of each page the test driver knows (tabs and windows), remembered per page. */
const targetIds = new WeakMap();
async function knownTargets(context) {
  const ids = new Set();
  for (const page of context.pages()) {
    if (!targetIds.has(page)) {
      // A page that closes meanwhile is simply left out.
      const session = await context.newCDPSession(page).catch(() => null);
      const info = await session?.send("Target.getTargetInfo").catch(() => null);
      await session?.detach().catch(() => {});
      if (!info) continue;
      targetIds.set(page, info.targetInfo.targetId);
    }
    ids.add(targetIds.get(page));
  }
  return ids;
}

/**
 * Finds the side panel whose address matches `urlPattern` and returns a small driver for it, or
 * null when no such panel is open. `anyPage` is any open page of the browser. A tab or a window at
 * the same address is not taken for the panel.
 */
export async function attachSidePanel(anyPage, urlPattern) {
  const context = anyPage.context();
  const cdp = await context.newCDPSession(anyPage);
  const tabs = await knownTargets(context);
  const target = (await cdp.send("Target.getTargets")).targetInfos.find((info) => info.type === "page" && urlPattern.test(info.url) && !tabs.has(info.targetId));
  if (!target) {
    await cdp.detach();
    return null;
  }
  // A panel that closes between being listed and being attached to counts as no panel.
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: false }).catch(() => null);
  if (!attached) {
    await cdp.detach().catch(() => {});
    return null;
  }
  const { sessionId } = attached;
  const waiting = new Map();
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const answer = JSON.parse(message);
    waiting.get(answer.id)?.(answer);
    waiting.delete(answer.id);
  });
  let calls = 0;
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++calls;
      waiting.set(id, resolve);
      const fail = () => waiting.delete(id) && resolve({ error: { message: "no answer" } });
      setTimeout(fail, 5_000);
      // Sending fails at once when the panel has been closed.
      cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(fail);
    });

  const markup = async () => {
    const { result } = await call("DOM.getDocument", { depth: 0 });
    return (await call("DOM.getOuterHTML", { nodeId: result?.root?.nodeId })).result?.outerHTML ?? "";
  };
  /** The node matching the CSS selector, or undefined. */
  const find = async (selector) => {
    const { result } = await call("DOM.getDocument", { depth: 0 });
    return (await call("DOM.querySelector", { nodeId: result?.root?.nodeId, selector })).result?.nodeId || undefined;
  };

  return {
    where: "panel",
    /** The panel's current address; empty once the panel is closed. */
    url: async () => (await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }))).targetInfos.find((info) => info.targetId === target.targetId)?.url ?? "",
    /** What the panel says, on one line. Read from the markup, which works on guarded pages too. */
    text: async () => plain(await markup()),
    /** The `data-testid` of every button in the panel: what `click` can aim at. */
    async buttons() {
      return [...(await markup()).matchAll(/<button\b[^>]*\bdata-testid="([^"]+)"/g)].map((match) => match[1]);
    },
    /** True when an element matches the CSS selector. */
    has: async (selector) => Boolean(await find(selector)),
    /**
     * Clicks the first element matching the CSS selector, waiting up to `timeout` for it to be
     * there (a request takes a moment to appear in the panel). Resolves with false when it never is.
     */
    async click(selector, { timeout = 15_000 } = {}) {
      for (const deadline = Date.now() + timeout; ; await sleep(250)) {
        const found = await find(selector);
        const box = found && (await call("DOM.getBoxModel", { nodeId: found })).result?.model?.content;
        if (box) {
          const point = { x: (box[0] + box[4]) / 2, y: (box[1] + box[5]) / 2, button: "left", clickCount: 1 };
          await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
          await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
          return true;
        }
        if (Date.now() > deadline) return false;
      }
    },
    /** Types into the field matching the selector: a click to focus it, then the text. */
    async fill(selector, text, options) {
      if (!(await this.click(selector, options))) return false;
      await call("Input.insertText", { text });
      return true;
    },
    /** Closes the panel's page, which closes the panel. */
    close: () => cdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {}),
    detach: () => cdp.detach().catch(() => {}),
  };
}

/**
 * Waits until the panel found by `find()` shows an element matching the selector. A panel exists a
 * moment before it has drawn the wallet, and a request sent to it in that moment is lost.
 */
export async function panelShowing(find, selector, { timeout = 15_000 } = {}) {
  for (const deadline = Date.now() + timeout; ; await sleep(200)) {
    const panel = await find();
    const there = Boolean(panel) && (await panel.has(selector));
    await panel?.detach();
    if (there) return true;
    if (Date.now() > deadline) return false;
  }
}

/** Waits until `find()` finds no panel any more: a closed panel takes a moment to go. */
export async function panelGone(find, { timeout = 10_000 } = {}) {
  for (const deadline = Date.now() + timeout; ; await sleep(150)) {
    const panel = await find();
    await panel?.detach();
    if (!panel) return true;
    if (Date.now() > deadline) return false;
  }
}

/** The same interface over one of a wallet's own windows or tabs (an ordinary page). */
export function windowSurface(page) {
  return {
    where: "window",
    url: async () => (page.isClosed() ? "" : page.url()),
    text: async () => plain(await page.content().catch(() => "")),
    has: (selector) => page.locator(selector).count().then(Boolean, () => false),
    click: (selector, { timeout = 15_000 } = {}) => page.locator(selector).first().click({ timeout }).then(() => true, () => false),
    fill: (selector, text, { timeout = 15_000 } = {}) => page.locator(selector).first().fill(text, { timeout }).then(() => true, () => false),
    close: () => page.close().catch(() => {}),
    detach: async () => {},
  };
}

/**
 * Waits until the wallet shows a request and returns it, or null on timeout. `surfaces()` lists the
 * places to look right now (the side panel, the wallet's windows). `read(surface)` names what a
 * surface shows, `{ kind, approve, reject, why }` with the selectors of its two buttons (and, when
 * one of them is not on offer, why), or null when it shows no request. `closePanel()` closes the
 * wallet's side panel.
 *
 * The result is `{ where, kind, approvable, text(), approve(), reject(), dismiss() }`. `approve`
 * and `reject` return once the surface has moved on from the request (the window has closed, the
 * panel shows something else), so the next call finds the next request and never the answered one.
 */
export async function waitForRequest({ surfaces, read, closePanel, timeout }) {
  for (const deadline = Date.now() + timeout; ; await sleep(250)) {
    const places = await surfaces();
    for (const surface of places) {
      const shown = await read(surface).catch(() => null);
      if (!shown) {
        await surface.detach();
        continue;
      }
      for (const other of places) if (other !== surface) await other.detach();
      const showing = async () => `${await surface.url()} ${await surface.text()}`;
      const answer = async (selector, what) => {
        if (!selector) throw new Error(shown.why ?? `the wallet's ${shown.kind} screen cannot be ${what}`);
        const before = await showing();
        if (!(await surface.click(selector))) throw new Error(`the ${shown.kind} request has no button to be ${what} with`);
        for (const until = Date.now() + 10_000; Date.now() < until && (await showing()) === before; ) await sleep(150);
        await surface.detach();
      };
      return {
        where: surface.where,
        kind: shown.kind,
        approvable: Boolean(shown.approve),
        text: () => surface.text(),
        approve: () => answer(shown.approve, "approved"),
        reject: () => answer(shown.reject, "rejected"),
        /** Goes away without answering: closes the window, or closes the side panel. */
        async dismiss() {
          await (surface.where === "panel" ? closePanel() : surface.close());
          await surface.detach();
        },
      };
    }
    if (Date.now() > deadline) return null;
  }
}

/**
 * Types the wallet's password into its unlock form, wherever the form is: one of `surfaces()` when
 * a site's request made the wallet show it, otherwise the wallet's own page, opened by `open()`
 * for the purpose and closed again. Returns once the form is gone.
 */
export async function unlockWith({ surfaces, open, input, submit, password }) {
  let surface;
  for (const candidate of await surfaces()) {
    if (!surface && (await candidate.has(input))) surface = candidate;
    else await candidate.detach();
  }
  const page = surface ? null : await open();
  surface ??= windowSurface(page);
  try {
    if (!(await surface.fill(input, password)) || !(await surface.click(submit))) throw new Error("the wallet shows no unlock form");
    for (const deadline = Date.now() + 10_000; await surface.has(input); await sleep(150)) {
      if (Date.now() > deadline) throw new Error("the wallet did not accept the password");
    }
  } finally {
    await surface.detach();
    await page?.close().catch(() => {});
  }
}
