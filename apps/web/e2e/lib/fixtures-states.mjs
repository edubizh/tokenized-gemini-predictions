// The routes and states of the web app in fixtures mode, shared by screens.mjs and responsive.mjs.
// Each state brings the page to one screen and waits for the landmark that proves it is drawn.
// The test login is read from PRIVY_TEST_EMAIL and PRIVY_TEST_OTP and is never printed.

export const BASE = process.env.SCREENS_BASE_URL ?? "http://localhost:3100";

/** Picks the fixture events each state needs, by shape, cadence and book. */
export async function pickEvents(request) {
  const response = await request.get(`${BASE}/api/relayer/events`);
  if (!response.ok()) throw new Error(`the relayer events did not load (HTTP ${response.status()}); is the server in fixtures mode?`);
  const { events } = await response.json();
  const quoted = (market) => market.tradable && market.book && market.book.askPx !== null && market.book.bidPx !== null;
  const find = (label, test) => {
    const event = events.find(test);
    if (!event) throw new Error(`no fixture event for: ${label}`);
    return event;
  };
  const ladder = find("a quoted ladder", (e) => e.shape === "ladder" && e.venueStatus === "active" && e.markets.some(quoted));
  const binary = find("a quoted binary", (e) => e.shape === "binary" && e.cadence !== "5m" && e.markets.some(quoted));
  const noOffers = find("a ladder with no offers", (e) => e.shape === "ladder" && e.venueStatus === "active" && e.markets.every((m) => m.notTradableReason === "no_offers"));
  const notTrading = find("an event not trading yet", (e) => e.venueStatus !== "active");
  // One side has an offer and the other has none: the ask is the Yes offer, the bid makes the No offer.
  let oneSided = null;
  for (const event of events) {
    for (const market of event.markets) {
      const book = market.book;
      if (!market.tradable || !book) continue;
      if (book.askPx === null && book.bidPx !== null) oneSided ??= { event, symbol: market.symbol, side: "yes" };
      if (book.bidPx === null && book.askPx !== null) oneSided ??= { event, symbol: market.symbol, side: "no" };
    }
  }
  if (!oneSided) throw new Error("no fixture contract with an offer on one side only");
  return {
    ladder,
    binary,
    binarySymbol: binary.markets.find(quoted).symbol,
    noOffers,
    notTrading,
    oneSided,
  };
}

export const eventPath = (event, query = "") => `/markets/${encodeURIComponent(event.ticker)}${query}`;

const testId = (page, id) => page.locator(`[data-testid="${id}"]`);

/** Waits until the page is drawn: its main landmark and the given locator visible. */
export async function landmark(page, locator, timeout = 30_000) {
  await page.locator("main#content").waitFor({ timeout });
  await locator.first().waitFor({ timeout });
}

export async function go(page, route) {
  await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
}

/** Turns a fixtures switch for this browser (the switches are cookies). */
export async function flip(context, query) {
  const response = await context.request.get(`${BASE}/api/fixtures/switch?${query}`);
  if (!response.ok()) throw new Error(`fixtures switch ${query} answered HTTP ${response.status()}`);
}

/** Logs in with the test e-mail account, retrying once when the login service refuses or is slow. */
export async function logIn(page) {
  const email = process.env.PRIVY_TEST_EMAIL;
  const otp = process.env.PRIVY_TEST_OTP;
  if (!email || !otp) throw new Error("PRIVY_TEST_EMAIL and PRIVY_TEST_OTP must be set (node --env-file=../../.env).");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await go(page, "/");
      await testId(page, "login-top").click({ timeout: 60_000 });
      await testId(page, "login-email").click();
      const input = page.locator('input[type="email"]').first();
      await input.waitFor({ timeout: 30_000 });
      await input.fill(email);
      await input.press("Enter");
      await page.locator('input[name="code-0"]').waitFor({ timeout: 30_000 });
      for (let i = 0; i < 6; i++) await page.locator(`input[name="code-${i}"]`).fill(otp[i]);
      await testId(page, "account").waitFor({ timeout: 90_000 });
      // The login service's own dialog lingers for a moment after the login; nothing is captured under it.
      await page.waitForFunction(() => document.querySelector("#privy-dialog, #privy-modal-content") === null, null, { timeout: 60_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      console.log("login did not complete; trying once more");
    }
  }
}

/**
 * The states that need no login, in order. Each is { name, run(page, context) }; run leaves the
 * page on that screen. The login dialog state is last, as it leaves the dialog open.
 */
export function loggedOutStates(picks) {
  const searchFor = picks.ladder.underlying;
  return [
    { name: "index", run: async (page) => { await go(page, "/"); await landmark(page, testId(page, "event-card")); } },
    {
      name: "index-filtered",
      run: async (page) => {
        await go(page, "/");
        await landmark(page, testId(page, "event-card"));
        await testId(page, "filter-search").fill(searchFor);
        await page.waitForFunction((word) => [...document.querySelectorAll('[data-testid="event-card"]')].every((card) => card.textContent.includes(word)), searchFor, { timeout: 10_000 });
      },
    },
    {
      name: "index-no-match",
      run: async (page) => {
        await go(page, "/");
        await landmark(page, testId(page, "event-card"));
        await testId(page, "filter-search").fill("zzqx no such market");
        await landmark(page, page.getByText("No market matches"));
      },
    },
    { name: "event-ladder", run: async (page) => { await go(page, eventPath(picks.ladder)); await landmark(page, testId(page, "contract-row")); await testId(page, "ticket").waitFor(); } },
    { name: "event-binary", run: async (page) => { await go(page, eventPath(picks.binary)); await landmark(page, testId(page, "ticket")); await testId(page, "quote-line").first().waitFor(); } },
    { name: "event-ladder-no-offers", run: async (page) => { await go(page, eventPath(picks.noOffers)); await landmark(page, testId(page, "contract-row")); } },
    { name: "event-not-trading", run: async (page) => { await go(page, eventPath(picks.notTrading)); await landmark(page, page.locator("h1")); } },
    { name: "event-not-found", run: async (page) => { await go(page, "/markets/NOSUCHEVENT0000"); await landmark(page, page.getByText("No such market")); } },
    { name: "ticket-logged-out", run: async (page) => { await go(page, eventPath(picks.binary, `?c=${picks.binarySymbol}&side=yes`)); await landmark(page, testId(page, "login-to-trade")); } },
    { name: "portfolio-logged-out", run: async (page) => { await go(page, "/portfolio"); await landmark(page, page.getByText("Log in to see your portfolio")); } },
    { name: "system", run: async (page) => { await go(page, "/system"); await landmark(page, testId(page, "system-reconciliation")); await testId(page, "system-status").waitFor(); } },
    { name: "vaults", run: async (page) => { await go(page, "/vaults"); await landmark(page, page.locator("h1")); } },
    {
      name: "login-dialog",
      run: async (page) => {
        await go(page, "/");
        await testId(page, "login-top").click({ timeout: 60_000 });
        await testId(page, "login-email").waitFor({ timeout: 10_000 });
      },
    },
  ];
}

/** The states that need the test login; the account is logged in before the first one runs. */
export function loggedInStates(picks) {
  const positions = (page) => page.locator('[data-testid="portfolio-positions"], [data-testid="portfolio-orders"], [data-testid="portfolio-settled"]').or(page.getByText("No positions yet"));
  return [
    {
      name: "ticket-ready",
      run: async (page) => {
        await go(page, eventPath(picks.binary, `?c=${picks.binarySymbol}&side=yes`));
        await landmark(page, page.locator('[data-testid="place"]:not([disabled])'), 60_000);
      },
    },
    {
      name: "ticket-no-offer",
      run: async (page) => {
        const { event, symbol, side } = picks.oneSided;
        await go(page, eventPath(event, `?c=${symbol}&side=${side}`));
        await landmark(page, page.getByText(new RegExp(`^No offer on (Yes|No)`)), 60_000);
      },
    },
    { name: "portfolio", run: async (page) => { await go(page, "/portfolio"); await landmark(page, testId(page, "portfolio-balance"), 60_000); await positions(page).first().waitFor({ timeout: 30_000 }); } },
    {
      name: "portfolio-first-run",
      run: async (page, context) => {
        await flip(context, "wallet=new");
        await go(page, "/portfolio");
        await landmark(page, testId(page, "get-test-funds"), 60_000);
      },
      undo: "wallet=registered",
    },
    {
      name: "portfolio-chain-failing",
      run: async (page, context) => {
        await go(page, "/portfolio");
        await landmark(page, testId(page, "portfolio-balance"), 60_000);
        await flip(context, "chain=failing");
        await landmark(page, page.getByText("Solana devnet is not answering"), 60_000);
      },
      undo: "chain=ok",
    },
    { name: "activity", run: async (page) => { await go(page, "/activity"); await landmark(page, testId(page, "activity-order").or(page.getByText("No orders yet")), 60_000); } },
    {
      name: "activity-open",
      run: async (page) => {
        await go(page, "/activity");
        await landmark(page, testId(page, "activity-details"), 60_000);
        const details = testId(page, "activity-details").first();
        // A click before the list has hydrated does nothing; it is repeated until the row opens.
        for (let attempt = 0; attempt < 3 && (await details.getAttribute("aria-expanded")) !== "true"; attempt++) {
          await details.click();
          await page.waitForTimeout(1_000);
        }
        console.log("  activity row opened (aria-expanded):", await details.getAttribute("aria-expanded"));
        await testId(page, "activity-steps").first().waitFor({ timeout: 10_000 });
      },
    },
    ...["index", "event", "portfolio", "system"].map((which) => ({
      name: `offline-${which}`,
      run: async (page, context) => {
        await flip(context, "relayer=offline");
        if (which === "index") {
          await go(page, "/");
          await landmark(page, page.getByText("The relayer is not answering"));
        } else if (which === "event") {
          await go(page, eventPath(picks.ladder));
          await landmark(page, page.getByText("The relayer is not answering"));
        } else if (which === "portfolio") {
          await go(page, "/portfolio");
          await landmark(page, page.getByText("The relayer is not answering"), 60_000);
          await testId(page, "portfolio-balance").waitFor({ timeout: 30_000 });
        } else {
          await go(page, "/system");
          await landmark(page, page.getByText("The relayer cannot be reached"));
        }
      },
      undo: "relayer=online",
    })),
  ];
}
