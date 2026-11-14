// Live smoke test of the sandbox venue adapter. Run by hand from apps/relayer:
//
//   node --env-file=../../.env scripts/sandbox-smoke.ts
//
// It connects, prints cash and the position, places ONE 1-contract fill-or-kill BUY YES at the
// best ask of a live 15-minute contract (test money), then prints the result and the lookup of
// that order by client order id.
import { randomBytes } from "node:crypto";
import { clientOrderIdFor } from "../src/ids.ts";
import { UNITS_PER_CONTRACT } from "../src/money.ts";
import { GeminiSandboxVenue } from "../src/venue/gemini/venue.ts";
import { tradableNow } from "../src/venue/tradable.ts";
import type { ContractInfo, TopOfBook } from "../src/venue/venue.ts";

const BOOKS_TO_TRY = 6;

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

/** The soonest-expiring tradable 15-minute contract that has an ask for one whole contract. */
async function pickContract(venue: GeminiSandboxVenue): Promise<{ contract: ContractInfo; book: TopOfBook } | null> {
  const now = new Date();
  const candidates = (await venue.listContracts())
    .filter((contract) => contract.eventTicker.includes("15M") && tradableNow(contract, now).ok)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  console.log(`tradable 15-minute contracts: ${candidates.length}`);
  for (const contract of candidates.slice(0, BOOKS_TO_TRY)) {
    const book = await venue.topOfBook(contract.symbol);
    if (book.askPx !== null && book.askUnits >= UNITS_PER_CONTRACT) return { contract, book };
  }
  return null;
}

let frames = 0;
const venue = new GeminiSandboxVenue({
  apiKey,
  apiSecret,
  onFrame: () => frames++,
  onDisconnect: (info) => console.log("socket closed:", show(info)),
});

try {
  await venue.connect();
  console.log("connected: socket open, three subscriptions acked");
  console.log("cash (micro-dollars):", (await venue.cashMicros()).toString());

  const picked = await pickContract(venue);
  if (picked === null) {
    console.error("no tradable 15-minute contract with an ask right now; nothing was sent");
    process.exitCode = 1;
  } else {
    const { contract, book } = picked;
    const askPx = book.askPx!;
    console.log("contract:", show(contract));
    console.log("top of book:", show(book));
    console.log("position before (units):", (await venue.netPosition(contract.symbol)).toString());

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
    console.log("position after (units):", (await venue.netPosition(contract.symbol)).toString());
    console.log("cash after (micro-dollars):", (await venue.cashMicros()).toString());
  }
  console.log(`socket frames received: ${frames}`);
} catch (error) {
  // Only the message: errors raised by the adapter never contain credentials.
  console.error("smoke test failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  venue.close();
  setTimeout(() => process.exit(), 2_000).unref();
}
