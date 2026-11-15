// Takes one on-chain order from "seen" to a final state: guard, one venue order, then the matching
// on-chain fill or cancel. Every step is journaled first, so a restarted process resumes an order
// exactly where it stopped and never sends a second venue order for the same address.

import type { Chain, ChainOrder } from "./chain/chain.ts";
import { clientOrderIdFor } from "./ids.ts";
import type { Journal, JournalOrder } from "./journal.ts";
import { cost, feeCap, takerFee } from "./money.ts";
import { buyCost, sellProceeds, toVenueOrder } from "./venue/mapping.ts";
import { bookSideAvailable, tradableNow } from "./venue/tradable.ts";
import type { VenueFill, VenueOrderResult } from "./venue/types.ts";
import type { OrderLookup, Venue } from "./venue/venue.ts";

export interface PipelineConfig {
  /** Do not send to the venue with less than this left before `expiresAt`. */
  minWindowSecs: number;
  /** Stop retrying an on-chain call this close to `expiresAt`. */
  chainSafetySecs: number;
  /** Lookups by client order id for an unknown venue outcome. */
  lookupAttempts: number;
  /** Delay between those lookups. */
  lookupDelayMs: number;
  /** Delay between on-chain retries. */
  chainRetryDelayMs: number;
  /** Passed to `feeCap`. */
  feeSlackMicros: bigint;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  minWindowSecs: 25,
  chainSafetySecs: 3,
  lookupAttempts: 4,
  lookupDelayMs: 1_500,
  chainRetryDelayMs: 1_000,
  feeSlackMicros: 30_000n,
};

/** The part of the venue an order needs. */
export type OrderVenue = Pick<Venue, "placeOrder" | "findOrder" | "contract" | "topOfBook">;

export interface PipelineDeps {
  venue: OrderVenue;
  chain: Chain;
  journal: Journal;
  config: PipelineConfig;
  sleep(ms: number): Promise<void>;
  alert(event: { kind: string; orderAddress: string; detail: string }): void;
}

/** `left_unknown`: the venue outcome is still open, nothing was done on-chain, `recover` retries. */
export type Outcome_ = "chain_filled" | "chain_cancelled" | "orphaned" | "failed" | "left_unknown";

/**
 * Runs one open order to its outcome. Callers never run it concurrently. A known address resumes
 * from its journaled state. A rejection (a dependency threw where no retry rule applies) leaves
 * the row unresolved for a later call or for `recover`.
 */
export async function processOrder(order: ChainOrder, deps: PipelineDeps): Promise<Outcome_> {
  const { row } = deps.journal.recordSeen({
    orderAddress: order.address,
    clientOrderId: clientOrderIdFor(order.addressBytes),
    user: order.user,
    kind: order.kind,
    side: order.side,
    symbol: order.symbol,
    units: order.units,
    limitPx: order.limitPx,
    maxFeeMicros: order.maxFeeMicros,
    expiresAt: order.expiresAt,
  });
  return resume(row, order, deps);
}

/**
 * Resolves every unresolved journal row, oldest first. A row whose handling throws is reported
 * through `alert` (`recover_error`) and stays unresolved; the others are still handled.
 */
export async function recover(deps: PipelineDeps): Promise<void> {
  const rows = deps.journal.unresolved();
  if (rows.length === 0) return;
  const open = new Map((await deps.chain.openOrders()).map((order) => [order.address, order]));
  for (const row of rows) {
    try {
      await resume(row, open.get(row.orderAddress) ?? null, deps);
    } catch (error) {
      deps.alert({ kind: "recover_error", orderAddress: row.orderAddress, detail: message(error) });
    }
  }
}

/** Continues a row from its journaled state. `order` is null when its account no longer exists. */
async function resume(row: JournalOrder, order: ChainOrder | null, deps: PipelineDeps): Promise<Outcome_> {
  switch (row.state) {
    case "seen":
      if (order === null) {
        deps.journal.markChain(row.orderAddress, "failed", { detail: "order account gone before submission" });
        return "failed";
      }
      return submit(row, order, deps);
    case "submitting":
    case "venue_unknown":
      return resolveUnknown(row, order, deps);
    case "venue_filled":
      return settleFilled(row, order, deps.journal.fills(row.orderAddress), row.feeMicros, deps);
    case "venue_not_filled":
      return cancelOrder(row, order, deps);
    default:
      return row.state;
  }
}

/** Steps 2 to 4 for a row in `seen`: guards, then the single venue order. */
async function submit(row: JournalOrder, order: ChainOrder, deps: PipelineDeps): Promise<Outcome_> {
  const guard = await failedGuard(row, deps);
  if (guard !== null) return cancelOrder(row, order, deps, guard);

  deps.journal.markSubmitting(row.orderAddress);
  let result: VenueOrderResult;
  try {
    result = await deps.venue.placeOrder({
      ...toVenueOrder(row),
      timeInForce: "FOK",
      clientOrderId: row.clientOrderId,
      symbol: row.symbol,
    });
  } catch (error) {
    result = { kind: "unknown", venueOrderId: null, reason: `placeOrder threw: ${message(error)}` };
  }
  deps.journal.recordVenueResult(row.orderAddress, result);
  switch (result.kind) {
    case "filled":
      return settleFilled(row, order, result.fills, result.feeMicros, deps);
    case "not_filled":
    case "rejected":
      return cancelOrder(row, order, deps);
    case "unknown":
      return resolveUnknown(row, order, deps);
  }
}

/** Name of the first pre-trade guard the order fails, or null when it may go to the venue. */
async function failedGuard(row: JournalOrder, deps: PipelineDeps): Promise<string | null> {
  const { venue, chain, config } = deps;
  // Values read from the chain are untrusted: out-of-range ones never reach the venue.
  let venueOrder: ReturnType<typeof toVenueOrder>;
  let cap: bigint;
  let minProceeds: bigint;
  try {
    venueOrder = toVenueOrder(row);
    cap = feeCap(row.units, venueOrder.limitPx, config.feeSlackMicros);
    minProceeds = cost(row.units, row.limitPx);
  } catch (error) {
    if (error instanceof RangeError) return "bad_order_values";
    throw error;
  }
  if (row.units <= 0n) return "bad_order_values";

  const now = await chain.now();
  if (!(row.expiresAt - now >= config.minWindowSecs)) return "expiry_window";

  const contract = await venue.contract(row.symbol);
  if (contract === null) return "contract_missing";
  const tradable = tradableNow(contract, new Date(now * 1000));
  if (!tradable.ok) return `not_tradable:${tradable.reason}`;

  const top = await venue.topOfBook(row.symbol);
  const book = { bids: top.bidPx === null ? [] : [top.bidPx], asks: top.askPx === null ? [] : [top.askPx] };
  if (!bookSideAvailable(book, venueOrder.outcome)) return "book_side_empty";

  if (row.maxFeeMicros < cap) return "fee_cap";
  // A sell pays its fee out of the proceeds, so the least it can return must exceed the allowance.
  if (row.kind === "sell" && !(minProceeds > row.maxFeeMicros)) return "min_proceeds";
  return null;
}

/**
 * Settles an order whose venue outcome is not known by looking it up by client order id. Only an
 * order that every lookup reports as absent counts as never sent; a lookup that fails, or an order
 * still open at the venue, leaves the row `venue_unknown` with nothing done on-chain.
 */
async function resolveUnknown(row: JournalOrder, order: ChainOrder | null, deps: PipelineDeps): Promise<Outcome_> {
  const { venue, journal, config } = deps;
  let absentEveryTime = config.lookupAttempts > 0;
  let lastSeen = "no lookup was made";
  for (let attempt = 0; attempt < config.lookupAttempts; attempt++) {
    if (attempt > 0) await deps.sleep(config.lookupDelayMs);
    let lookup: OrderLookup;
    try {
      lookup = await venue.findOrder(row.clientOrderId, row.symbol, row.createdAt);
    } catch (error) {
      absentEveryTime = false;
      lastSeen = `lookup failed: ${message(error)}`;
      continue;
    }
    if (!lookup.found) continue;
    absentEveryTime = false;
    if (!lookup.closed) {
      lastSeen = `venue order ${lookup.venueOrderId} is still open`;
      continue;
    }
    if (lookup.filledUnits === 0n) {
      const reason = "closed without a fill (found by lookup)";
      journal.recordVenueResult(row.orderAddress, { kind: "not_filled", venueOrderId: lookup.venueOrderId, reason });
      return cancelOrder(row, order, deps);
    }
    // One synthetic fill. Without an exact average the venue order's limit is used, which charges
    // a buy at its maximum and pays a sell at its minimum.
    const px = lookup.avgPx ?? toVenueOrder(row).limitPx;
    const fill: VenueFill = {
      tradeId: `lookup:${lookup.venueOrderId}`,
      units: lookup.filledUnits,
      px,
      feeMicros: takerFee(lookup.filledUnits, px),
      feeSource: "computed",
    };
    journal.recordVenueResult(row.orderAddress, {
      kind: "filled",
      venueOrderId: lookup.venueOrderId,
      fills: [fill],
      filledUnits: fill.units,
      costMicros: cost(fill.units, px),
      feeMicros: fill.feeMicros,
    });
    deps.alert({
      kind: "recovered_by_lookup",
      orderAddress: row.orderAddress,
      detail: `venue order ${lookup.venueOrderId} filled ${fill.units} units, settled at px ${px}`,
    });
    return settleFilled(row, order, [fill], fill.feeMicros, deps);
  }

  if (absentEveryTime) {
    const reason = `not found at the venue in ${config.lookupAttempts} lookups`;
    journal.recordVenueResult(row.orderAddress, { kind: "not_filled", venueOrderId: null, reason });
    return cancelOrder(row, order, deps);
  }
  journal.recordVenueResult(row.orderAddress, { kind: "unknown", venueOrderId: null, reason: lastSeen });
  deps.alert({ kind: "venue_unknown", orderAddress: row.orderAddress, detail: lastSeen });
  return "left_unknown";
}

/** The on-chain fill for a venue fill; `orphaned` when it can no longer land. */
async function settleFilled(
  row: JournalOrder,
  order: ChainOrder | null,
  fills: VenueFill[],
  venueFeeMicros: bigint,
  deps: PipelineDeps,
): Promise<Outcome_> {
  const { chain, journal } = deps;
  if (order === null) return orphan(row, "the order account is gone", deps);

  const fillUnits = fills.reduce((sum, fill) => sum + fill.units, 0n);
  let feeMicros: bigint;
  let send: () => Promise<string>;
  if (row.kind === "buy") {
    const costMicros = buyCost(fills);
    feeMicros = min(venueFeeMicros, row.maxFeeMicros);
    send = () => chain.fillBuy(order, { fillUnits, costMicros, feeMicros });
  } else {
    // Never less than the minimum the user asked for.
    const proceedsMicros = max(sellProceeds(fills), fillUnits * row.limitPx);
    feeMicros = min(venueFeeMicros, row.maxFeeMicros, proceedsMicros);
    send = () => chain.fillSell(order, { fillUnits, proceedsMicros, feeMicros });
  }

  const sent = await sendWithRetry(row, deps, send);
  if (!sent.ok) return orphan(row, `${sent.reason}; last error: ${sent.error}`, deps);
  journal.markChain(row.orderAddress, "chain_filled", { signature: sent.signature });
  if (venueFeeMicros > feeMicros) {
    deps.alert({
      kind: "fee_absorbed",
      orderAddress: row.orderAddress,
      detail: `venue fee ${venueFeeMicros} above the ${feeMicros} charged`,
    });
  }
  return "chain_filled";
}

/** The venue filled but the tokens were never minted or burned: the position is house inventory. */
function orphan(row: JournalOrder, reason: string, deps: PipelineDeps): Outcome_ {
  const detail = `on-chain fill cannot land: ${reason}`;
  deps.journal.markChain(row.orderAddress, "orphaned", { detail });
  deps.alert({ kind: "orphaned_fill", orderAddress: row.orderAddress, detail });
  return "orphaned";
}

/**
 * Cancels the on-chain order. An account that is already gone was refunded by somebody else; a
 * cancel that cannot land before the deadline is `failed`, since anyone can cancel after expiry.
 * `detail` replaces the journaled detail when given.
 */
async function cancelOrder(row: JournalOrder, order: ChainOrder | null, deps: PipelineDeps, detail?: string): Promise<Outcome_> {
  const { chain, journal } = deps;
  if (order === null) {
    journal.markChain(row.orderAddress, "chain_cancelled", { detail });
    return "chain_cancelled";
  }
  const sent = await sendWithRetry(row, deps, () => chain.cancel(order));
  if (sent.ok) {
    journal.markChain(row.orderAddress, "chain_cancelled", { signature: sent.signature, detail });
    return "chain_cancelled";
  }
  const outcome = sent.reason === "order account gone" ? "chain_cancelled" : "failed";
  journal.markChain(row.orderAddress, outcome, { detail });
  return outcome;
}

type Sent =
  | { ok: true; signature: string }
  | { ok: false; reason: "order account gone" | "window closed"; error: string };

/**
 * Sends one on-chain call, retrying it every `chainRetryDelayMs` while the order account exists
 * and at least `chainSafetySecs` remain before its deadline.
 */
async function sendWithRetry(row: JournalOrder, deps: PipelineDeps, send: () => Promise<string>): Promise<Sent> {
  const { chain, config } = deps;
  for (;;) {
    let error: string;
    try {
      return { ok: true, signature: await send() };
    } catch (thrown) {
      error = message(thrown);
    }
    if (!(await chain.orderExists(row.orderAddress))) return { ok: false, reason: "order account gone", error };
    if (!((await chain.now()) <= row.expiresAt - config.chainSafetySecs)) return { ok: false, reason: "window closed", error };
    await deps.sleep(config.chainRetryDelayMs);
  }
}

function min(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((least, value) => (value < least ? value : least), first);
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
