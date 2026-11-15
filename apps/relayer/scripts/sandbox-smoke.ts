// Live smoke test of the sandbox venue adapter. Run by hand from apps/relayer:
//
//   node --env-file=../../.env scripts/sandbox-smoke.ts [--settled <symbol>]
//   node --env-file=../../.env scripts/sandbox-smoke.ts --place-order
//
// By default it only reads: every listed event with counts by shape and cadence, twice (the
// first page after a pause can be an old copy); the account's cash, its open positions and the
// payout of one settled position; for three quoted contracts the quote that came with the list,
// the live top of the public socket and the book read over REST, side by side; depth, trades and
// price history of one of them.
//
// With --place-order it then also places ONE 1-contract fill-or-kill BUY YES at the best ask of a
// live 15-minute contract (test money) and prints the result and the lookup of that order.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { clientOrderIdFor } from "../src/ids.ts";
import { UNITS_PER_CONTRACT, formatPx, formatUnits } from "../src/money.ts";
import type { FetchLike } from "../src/venue/gemini/rest.ts";
import { GeminiSandboxVenue } from "../src/venue/gemini/venue.ts";
import { tradableNow } from "../src/venue/tradable.ts";
import type { ContractInfo, EventInfo, TopOfBook } from "../src/venue/venue.ts";

const BOOKS_TO_TRY = 6;
const QUOTES_TO_SHOW = 3;
/** The adapter reads the list again once its last read is this old. */
const LIST_AGAIN_MS = 10_000;
/** How long to wait for the public socket to deliver the books it was asked for. */
const LIVE_WAIT_MS = 10_000;

const { values: flags } = parseArgs({
  options: {
    "place-order": { type: "boolean", default: false },
    // A contract the test account held through its resolution.
    settled: { type: "string", default: "GEMI-BTC15M2611140300-UP" },
  },
});

if (process.env.GEMINI_ENV !== "sandbox") {
  console.error("refusing to run: GEMINI_ENV must be 'sandbox'");
  process.exit(1);
}
const apiKey = process.env.GEMINI_API_KEY;
const apiSecret = process.env.GEMINI_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("refusing to run: GEMINI_API_KEY and GEMINI_API_SECRET must be set");
  process.exit(1);
}

/** JSON with bigint values written as decimal strings. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
}

/** A price in dollars, "-" for an empty side, "?" when the source gave none. */
function price(px: bigint | null | undefined): string {
  return px === undefined ? "?" : px === null ? "-" : formatPx(px);
}

function quote(bidPx: bigint | null | undefined, askPx: bigint | null | undefined): string {
  return `${price(bidPx)} / ${price(askPx)}`;
}

function sized(top: TopOfBook): string {
  return `${price(top.bidPx)} x ${formatUnits(top.bidUnits)} / ${price(top.askPx)} x ${formatUnits(top.askUnits)}`;
}

function tally<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
}

async function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
}

/** Quoted contracts first, two-sided ones ahead, one per event while there are enough events. */
function pickQuoted(events: EventInfo[]): ContractInfo[] {
  const sides = (contract: ContractInfo): number => Number(contract.bestBidPx != null) + Number(contract.bestAskPx != null);
  const best = events
    .map((event) => event.contracts.filter((contract) => contract.status === "active").sort((a, b) => sides(b) - sides(a))[0])
    .filter((contract) => contract !== undefined)
    .sort((a, b) => sides(b) - sides(a));
  return best.slice(0, QUOTES_TO_SHOW);
}

/** The soonest-expiring tradable 15-minute contract that has an ask for one whole contract. */
async function pickTradable(venue: GeminiSandboxVenue, events: EventInfo[]): Promise<{ contract: ContractInfo; book: TopOfBook } | null> {
  const now = new Date();
  const candidates = events
    .filter((event) => event.cadence === "15m")
    .flatMap((event) => event.contracts)
    .filter((contract) => tradableNow(contract, now).ok)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  console.log(`tradable 15-minute contracts: ${candidates.length}`);
  for (const contract of candidates.slice(0, BOOKS_TO_TRY)) {
    const book = await venue.topOfBook(contract.symbol);
    if (book.askPx !== null && book.askUnits >= UNITS_PER_CONTRACT) return { contract, book };
  }
  return null;
}

/** Lists the events and prints what the list holds. */
async function list(venue: GeminiSandboxVenue, label: string): Promise<EventInfo[]> {
  const events = await venue.listEvents();
  const contracts = events.flatMap((event) => event.contracts);
  const quoted = (contract: ContractInfo): string =>
    contract.bestBidPx != null && contract.bestAskPx != null ? "both sides" : contract.bestBidPx != null || contract.bestAskPx != null ? "one side" : "no quote";
  const newest = Math.max(...events.map((event) => event.listedAt.getTime()));
  console.log(`\n${label}: ${events.length} events (${tally(events, (event) => event.status)}), ${contracts.length} contracts (${tally(contracts, (contract) => contract.status)})`);
  console.log(`  by shape and cadence: ${tally(events, (event) => `${event.shape}/${event.cadence}`)}`);
  console.log(`  by category: ${tally(events, (event) => event.category)}; newest event listed ${events.length === 0 ? "never" : new Date(newest).toISOString()}`);
  console.log(`  active contracts by list quote: ${tally(contracts.filter((contract) => contract.status === "active"), quoted)}`);
  return events;
}

async function readOnly(venue: GeminiSandboxVenue): Promise<EventInfo[]> {
  await list(venue, "list read");
  const listedAtMs = Date.now();

  await venue.connect();
  console.log("\nauthenticated socket: open, three subscriptions acked");
  console.log("cash (micro-dollars):", (await venue.cashMicros()).toString());
  console.log("open positions (units):", show(Object.fromEntries(await venue.positions())));
  const payout = await venue.settledPayoutMicros(flags.settled);
  console.log(`settled payout of ${flags.settled} (micro-dollars): ${payout === null ? "no settled position" : payout.toString()}`);

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, listedAtMs + LIST_AGAIN_MS - Date.now())));
  const events = await list(venue, `list read ${Math.round((Date.now() - listedAtMs) / 1_000)} s later`);
  const active = events.flatMap((event) => event.contracts).filter((contract) => contract.status === "active");
  const arrived = await until(() => active.every((contract) => venue.liveTop(contract.symbol) !== undefined), LIVE_WAIT_MS);
  const live = active.filter((contract) => venue.liveTop(contract.symbol) !== undefined).length;
  console.log(`\nlive tops held: ${live} of ${active.length} active contracts${arrived ? "" : ` after ${LIVE_WAIT_MS} ms`}`);

  const picked = pickQuoted(events);
  console.log("symbol | list quote | live top | REST book");
  for (const contract of picked) {
    const top = venue.liveTop(contract.symbol);
    const book = await venue.topOfBook(contract.symbol);
    console.log(`${contract.symbol} | ${quote(contract.bestBidPx, contract.bestAskPx)} | ${top === undefined ? "none" : sized(top.top)} | ${sized(book)}`);
  }

  const first = picked[0];
  if (first !== undefined) {
    const { symbol } = first;
    const depth = await venue.depth(symbol, 10);
    const trades = await venue.trades(symbol, 50);
    const history = await venue.history(symbol, 60);
    const level = (side: Array<{ px: bigint; units: bigint }>): string => side.map(({ px, units }) => `${formatPx(px)} x ${formatUnits(units)}`).join(", ") || "none";
    console.log(`\n${symbol}`);
    console.log(`depth: bids ${level(depth.bids)}; asks ${level(depth.asks)}`);
    console.log(`trades: ${trades.length}${trades[0] === undefined ? "" : `, newest ${trades[0].taker} ${formatUnits(trades[0].units)} at ${formatPx(trades[0].px)} (id ${trades[0].id}, ${new Date(trades[0].atMs).toISOString()})`}`);
    console.log(`history: ${history.length} one-minute points${history.length === 0 ? "" : `, ${new Date(history[0]!.atMs).toISOString()} ${formatPx(history[0]!.px)} to ${new Date(history.at(-1)!.atMs).toISOString()} ${formatPx(history.at(-1)!.px)}`}`);
    const read = await venue.contract(symbol);
    console.log(`single-event read: ${read === null ? "unknown" : `${read.status}/${read.marketState}, strike ${read.strike ?? "none"}, last ${price(read.lastPx)}`}`);
  }
  return events;
}

async function placeOne(venue: GeminiSandboxVenue, events: EventInfo[]): Promise<void> {
  const picked = await pickTradable(venue, events);
  if (picked === null) {
    console.error("no tradable 15-minute contract with an ask right now; nothing was sent");
    process.exitCode = 1;
    return;
  }
  const { contract, book } = picked;
  const askPx = book.askPx!;
  const position = async (): Promise<string> => ((await venue.positions()).get(contract.symbol) ?? 0n).toString();
  console.log("contract:", show(contract));
  console.log("top of book:", show(book));
  console.log("position before (units):", await position());

  const clientOrderId = clientOrderIdFor(randomBytes(32));
  const sentAtMs = Date.now();
  console.log(`placing FOK BUY YES ${UNITS_PER_CONTRACT} units at ${askPx} px, client order id ${clientOrderId}`);
  const result = await venue.placeOrder({
    clientOrderId,
    symbol: contract.symbol,
    outcome: "YES",
    units: UNITS_PER_CONTRACT,
    limitPx: askPx,
    timeInForce: "FOK",
  });
  console.log("result:", show(result));
  console.log("lookup:", show(await venue.findOrder(clientOrderId, contract.symbol, sentAtMs)));
  console.log("position after (units):", await position());
  console.log("cash after (micro-dollars):", (await venue.cashMicros()).toString());
}

const startedAtMs = Date.now();
const requests = { public: 0, signed: 0 };
const counting: FetchLike = (url, init) => {
  if (init.headers === undefined) requests.public++;
  else requests.signed++;
  return fetch(url, init);
};
let frames = 0;
const venue = new GeminiSandboxVenue({
  apiKey,
  apiSecret,
  fetch: counting,
  onFrame: () => frames++,
  onDisconnect: (info) => console.log("socket closed:", show(info)),
  log: (line) => console.log(`adapter: ${line}`),
});

try {
  const events = await readOnly(venue);
  if (flags["place-order"]) await placeOne(venue, events);
  else console.log("\nread-only run: no order was placed (pass --place-order to place one)");
  const seconds = Math.round((Date.now() - startedAtMs) / 1_000);
  console.log(`requests in ${seconds} s: ${requests.public} public, ${requests.signed} signed; frames on the authenticated socket: ${frames}`);
} catch (error) {
  // Only the message: errors raised by the adapter never contain credentials.
  console.error("smoke test failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  venue.close();
  setTimeout(() => process.exit(), 2_000).unref();
}
