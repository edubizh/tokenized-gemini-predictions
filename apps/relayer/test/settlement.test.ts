import { afterEach, describe, expect, it, vi } from "vitest";
import { openJournal } from "../src/journal.ts";
import type { Journal, NewOrder } from "../src/journal.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { createSettlementWatcher } from "../src/settlement.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// Synthetic contracts. The clock starts 30 s after expiry.
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const START = EXPIRY + 30_000;
const CONFIRM = 20_000;
const REVIEW_AFTER = 600_000;
const SYMBOL = "TEST-BTC15M2611140300-UP";
const OTHER = "TEST-ETH15M2611140300-UP";

function info(symbol: string): ContractInfo {
  return {
    symbol,
    eventTicker: symbol.split("-")[1]!,
    status: "active",
    marketState: "open",
    effectiveAt: new Date(EXPIRY - 900_000),
    expiresAt: new Date(EXPIRY),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
    title: "Synthetic price at 3am",
    label: "Up",
  };
}

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

let nextId = 0;

function world() {
  const venue = new MockVenue();
  venue.setCash(1_000_000_000_000n);
  const chain = new FakeMarketChain();
  const registry: Registry = openRegistry(":memory:");
  const journal: Journal = openJournal(":memory:");
  closers.push(registry, journal);
  const clock = { ms: START };
  const alerts: Array<{ kind: string; orderAddress: string | null; detail: string }> = [];
  const watcher = createSettlementWatcher({
    venue,
    chain,
    registry,
    journal,
    confirmMs: CONFIRM,
    reviewAfterMs: REVIEW_AFTER,
    now: () => clock.ms,
    alert: (event) => alerts.push(event),
  });

  /** Lists a contract everywhere: venue, registry and chain, with the given supplies. */
  function market(symbol: string, yesSupply: bigint, noSupply: bigint): void {
    venue.addContract(info(symbol));
    registry.upsertContract(info(symbol), EXPIRY - 600_000);
    chain.addMarket(symbol, { closeTs: EXPIRY / 1000, yesSupply, noSupply });
    registry.setOnchain(symbol, { marketAddress: `market:${symbol}`, yesMint: `yes:${symbol}`, noMint: `no:${symbol}` });
  }

  /** Gives the venue account a signed position: YES positive, NO negative. */
  async function hold(symbol: string, signedUnits: bigint): Promise<void> {
    const units = signedUnits < 0n ? -signedUnits : signedUnits;
    venue.setBook(symbol, { bids: [[5_000n, units]], asks: [[5_000n, units]] });
    const result = await venue.placeOrder({
      clientOrderId: `hold-${++nextId}`,
      symbol,
      outcome: signedUnits < 0n ? "NO" : "YES",
      units,
      limitPx: 5_000n,
      timeInForce: "FOK",
    });
    if (result.kind !== "filled") throw new Error(`could not build the position: ${result.kind}`);
  }

  function seenOrder(symbol: string, overrides: Partial<NewOrder> = {}): string {
    const id = ++nextId;
    const order: NewOrder = {
      orderAddress: `Order${id}`,
      clientOrderId: `client-${id}`,
      user: "UserA",
      kind: "buy",
      side: "YES",
      symbol,
      units: 100n,
      limitPx: 5_000n,
      maxFeeMicros: 50_000n,
      expiresAt: EXPIRY / 1000 - 200,
      ...overrides,
    };
    journal.recordSeen(order);
    return order.orderAddress;
  }

  /** A journal row whose venue fill never reached the chain: the operator holds those units. */
  function orphan(symbol: string, units: bigint): void {
    const address = seenOrder(symbol, { units });
    journal.markSubmitting(address);
    journal.recordVenueResult(address, {
      kind: "filled",
      venueOrderId: `70000000000000000${nextId}`,
      fills: [{ tradeId: `trade-${nextId}`, units, px: 5_000n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: units,
      costMicros: units * 5_000n,
      feeMicros: 0n,
    });
    journal.markChain(address, "orphaned");
  }

  /** Ticks now, then at `confirmMs` after it: the resolution is first seen, then confirmed. */
  async function confirm(): Promise<void> {
    await watcher.tick();
    clock.ms += CONFIRM;
    await watcher.tick();
  }

  return { venue, chain, registry, journal, clock, alerts, watcher, market, hold, seenOrder, orphan, confirm };
}

describe("settlement watcher", () => {
  it("leaves a market alone until it has expired", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.venue.resolve(SYMBOL, "yes");
    w.clock.ms = EXPIRY - 1;
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("open");
    expect(w.chain.reads).toEqual([]);
  });

  it("marks an expired market as awaiting its result and waits for the venue", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.watcher.tick();
    w.clock.ms += REVIEW_AFTER - 30_000 - 1; // one millisecond short of the review deadline
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");
    expect(w.chain.settlements).toEqual([]);
    expect(w.alerts).toEqual([]);
  });

  it("records a market the chain already settled without asking the venue", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.chain.settleMarket(SYMBOL, 10_000n, 0n);
    const contract = vi.spyOn(w.venue, "contract");
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("settled");
    expect(contract).not.toHaveBeenCalled();
    expect(w.chain.settlements).toHaveLength(1);
  });

  it("settles YES once the resolution was seen unchanged for the confirmation time and the venue paid the net position", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");

    await w.watcher.tick();
    w.clock.ms += CONFIRM - 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "awaiting_result", resolution: "yes", venueStatus: "settled" });

    w.clock.ms += 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n, signature: "market-sig-1" }]);
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "settled", settleSignature: "market-sig-1" });
    expect(w.alerts).toEqual([]);

    await w.watcher.tick();
    expect(w.chain.settlements).toHaveLength(1);
  });

  it("settles NO when the venue paid the net NO position", async () => {
    const w = world();
    w.market(SYMBOL, 100n, 400n);
    await w.hold(SYMBOL, -300n);
    w.venue.resolve(SYMBOL, "no");
    expect(await w.venue.settledPayoutMicros(SYMBOL)).toBe(3_000_000n);
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 0n, noPayout: 10_000n }]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("settled");
  });

  it("expects no payout when the net position lost or was flat", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "no"); // a settled row that paid nothing
    w.market(OTHER, 200n, 200n);
    w.venue.resolve(OTHER, "yes"); // flat: no settled row at all
    expect(await w.venue.settledPayoutMicros(OTHER)).toBeNull();
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([
      { symbol: SYMBOL, yesPayout: 0n, noPayout: 10_000n },
      { symbol: OTHER, yesPayout: 10_000n, noPayout: 0n },
    ]);
    expect(w.alerts).toEqual([]);
  });

  it("counts units the operator holds for orphaned orders in the expected payout", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.orphan(SYMBOL, 100n);
    await w.hold(SYMBOL, 400n);
    w.venue.resolve(SYMBOL, "yes"); // paid 400 units
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
  });

  it("restarts the clock and alerts when the resolution changes", async () => {
    const w = world();
    w.market(SYMBOL, 200n, 200n);
    w.venue.resolve(SYMBOL, "yes");
    await w.watcher.tick();

    w.clock.ms += 15_000;
    w.venue.addContract({ ...info(SYMBOL), status: "settled", marketState: "closed", resolutionSide: "no" });
    await w.watcher.tick();
    expect(w.alerts).toEqual([{ kind: "resolution_changed", orderAddress: null, detail: `${SYMBOL}: yes -> no` }]);

    w.clock.ms += CONFIRM - 1; // well past the first sighting, short of the second
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);

    w.clock.ms += 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 0n, noPayout: 10_000n }]);
    expect(w.alerts).toHaveLength(1);
  });

  it("does not settle on a payout mismatch: needs review, with both numbers", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 200n);
    w.venue.resolve(SYMBOL, "yes"); // paid 200 units, 300 are outstanding
    await w.confirm();

    expect(w.chain.settlements).toEqual([]);
    const detail = "venue paid 2000000 micro-dollars, expected 3000000";
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail });
    expect(w.alerts).toEqual([{ kind: "payout_mismatch", orderAddress: null, detail: `${SYMBOL}: ${detail}` }]);

    await w.watcher.tick();
    expect(w.alerts).toHaveLength(1);
    expect(w.chain.settlements).toEqual([]);
  });

  it("treats a missing settled row as nothing paid", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.venue.resolve(SYMBOL, "yes"); // the venue account was flat
    await w.confirm();
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail: "venue paid 0 micro-dollars, expected 3000000" });
    expect(w.chain.settlements).toEqual([]);
  });

  it("marks a market nobody traded as unused and settles nothing", async () => {
    const w = world();
    w.market(SYMBOL, 0n, 0n);
    w.venue.resolve(SYMBOL, "yes");
    const payout = vi.spyOn(w.venue, "settledPayoutMicros");
    await w.confirm();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("unused");
    expect(w.chain.settlements).toEqual([]);
    expect(payout).not.toHaveBeenCalled();
    expect(w.alerts).toEqual([]);
  });

  it("waits while the journal has unresolved rows for the symbol", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");
    const blocking = w.seenOrder(SYMBOL);
    w.seenOrder(OTHER); // another symbol's rows do not matter
    const contract = vi.spyOn(w.venue, "contract");

    await w.confirm();
    w.clock.ms += CONFIRM;
    await w.watcher.tick();
    expect(contract).not.toHaveBeenCalled();
    expect(w.chain.settlements).toEqual([]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");

    w.journal.markChain(blocking, "chain_cancelled");
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
  });

  it("does not settle on supplies read while an order was still in flight", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");
    await w.watcher.tick();
    w.clock.ms += CONFIRM;
    // A row appears while the venue is being asked: the supplies read earlier may be stale.
    let blocking = "";
    vi.spyOn(w.venue, "contract").mockImplementationOnce(async (symbol) => {
      blocking = w.seenOrder(SYMBOL);
      return MockVenue.prototype.contract.call(w.venue, symbol);
    });
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);

    w.journal.markChain(blocking, "chain_cancelled");
    await w.watcher.tick();
    expect(w.chain.settlements).toHaveLength(1);
  });

  it("alerts when the on-chain settlement fails and tries again on the next tick", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");
    w.chain.fail("settleMarket", 1);
    await w.confirm();
    expect(w.alerts).toEqual([{ kind: "settle_failed", orderAddress: null, detail: `${SYMBOL}: injected failure: settleMarket` }]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");

    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "settled", settleSignature: "market-sig-1" });
    expect(w.alerts).toHaveLength(1);
  });

  it("asks for review, once, when there is no resolution long after expiry", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.clock.ms = EXPIRY + REVIEW_AFTER;
    await w.watcher.tick();
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("needs_review");
    expect(w.alerts).toEqual([{ kind: "needs_review", orderAddress: null, detail: `${SYMBOL}: no resolution 600 s after expiry` }]);
    expect(w.chain.settlements).toEqual([]);
  });

  it("asks for review when the venue settled the contract without a yes or no", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.venue.addContract({ ...info(SYMBOL), status: "settled", marketState: "closed", resolutionSide: null });
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("needs_review");
    expect(w.alerts).toEqual([{ kind: "needs_review", orderAddress: null, detail: `${SYMBOL}: settled at the venue without a yes or no resolution` }]);
  });

  it("asks for review when the registry's market is not on the chain", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.chain.markets.delete(SYMBOL);
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("needs_review");
    expect(w.alerts).toEqual([{ kind: "needs_review", orderAddress: null, detail: `${SYMBOL}: on-chain market account not found` }]);
  });

  it("reports a failure for one market as an alert and still handles the others", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.market(OTHER, 0n, 0n);
    w.venue.resolve(OTHER, "no");
    const real = MockVenue.prototype.contract;
    vi.spyOn(w.venue, "contract").mockImplementation(async (symbol) => {
      if (symbol === SYMBOL) throw new Error("venue down");
      return real.call(w.venue, symbol);
    });
    await w.confirm();
    expect(w.alerts).toEqual([
      { kind: "settlement_error", orderAddress: null, detail: `${SYMBOL}: venue down` },
      { kind: "settlement_error", orderAddress: null, detail: `${SYMBOL}: venue down` },
    ]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");
    expect(w.registry.get(OTHER)?.settleState).toBe("unused");
  });
});
