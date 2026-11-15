import { afterEach, describe, expect, it, vi } from "vitest";
import { openJournal } from "../src/journal.ts";
import type { Journal, NewOrder } from "../src/journal.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { createSettlementWatcher } from "../src/settlement.ts";
import type { SettlementInput } from "../src/settlement.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { eventOf } from "./helpers/events.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// Synthetic contracts. The clock starts 30 s after expiry.
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const START = EXPIRY + 30_000;
const CONFIRM = 20_000;
const REVIEW_AFTER = 600_000;
const PAYOUT_GRACE = 180_000;
const SWEEP = 60_000;
const SYMBOL = "TEST-BTC15M2611140300-UP";
const OTHER = "TEST-ETH15M2611140300-UP";
/** The strike contracts of one ladder event, lowest strike first. */
const LADDER = ["HI64000", "HI64500", "HI65000", "HI65500"].map((contract) => `TEST-BTC2611140300-${contract}`);
const [LOW, MID, HIGH, TOP] = LADDER as [string, string, string, string];

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
    label: "Up",
  };
}

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

let nextId = 0;

/** The bounds are roomy unless a test is about them. */
function world(bounds: Pick<SettlementInput, "marketsPerTick" | "venueReadsPerTick"> = {}) {
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
    payoutGraceMs: PAYOUT_GRACE,
    sweepMs: SWEEP,
    marketsPerTick: 50,
    venueReadsPerTick: 50,
    ...bounds,
    now: () => clock.ms,
    alert: (event) => alerts.push(event),
  });

  /** Lists a contract everywhere: venue, registry and chain, with the given supplies. */
  function market(symbol: string, yesSupply: bigint, noSupply: bigint): void {
    venue.addContract(info(symbol));
    registry.storeEvents([eventOf([info(symbol)])], EXPIRY - 600_000);
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
  it("looks at a market that has not expired once per sweep and leaves it open", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    const contract = vi.spyOn(w.venue, "contract");
    w.clock.ms = EXPIRY - 300_000;
    await w.watcher.tick();
    w.clock.ms += SWEEP - 1;
    await w.watcher.tick();
    expect(w.chain.reads).toEqual([SYMBOL]);
    expect(contract).toHaveBeenCalledTimes(1);

    w.clock.ms += 1;
    await w.watcher.tick();
    expect(w.chain.reads).toEqual([SYMBOL, SYMBOL]);
    expect(contract).toHaveBeenCalledTimes(2);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("open");
    expect(w.alerts).toEqual([]);
  });

  it("settles a contract the venue resolves before its expiry", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.clock.ms = EXPIRY - 300_000;
    await w.watcher.tick();

    w.venue.resolve(SYMBOL, "yes");
    w.clock.ms += SWEEP - 1;
    await w.watcher.tick(); // not its turn yet
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "open", resolution: null });

    w.clock.ms += 1;
    await w.watcher.tick(); // the sweep sees the resolution
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "awaiting_result", resolution: "yes" });

    // From here on the market is looked at on every tick, like an expired one.
    w.clock.ms += CONFIRM - 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);
    w.clock.ms += 1;
    await w.watcher.tick();
    expect(w.clock.ms).toBeLessThan(EXPIRY);
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("settled");
    expect(w.alerts).toEqual([]);
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

  it("does not read a missing settled row as nothing paid while a position is held, even on the losing side", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "no"); // the confirmed side expects no payout
    const payout = vi.spyOn(w.venue, "settledPayoutMicros").mockResolvedValue(null); // row not published yet
    await w.confirm();
    w.clock.ms = START + PAYOUT_GRACE - 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);
    expect(w.alerts).toEqual([]);

    payout.mockRestore(); // the row shows up: payout 0
    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 0n, noPayout: 10_000n }]);
    expect(w.alerts).toEqual([]);
  });

  it("asks for review when the settled row of a held position never shows up", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "no");
    vi.spyOn(w.venue, "settledPayoutMicros").mockResolvedValue(null);
    await w.confirm();
    w.clock.ms = START + PAYOUT_GRACE;
    await w.watcher.tick();
    const detail = "no settled position for a net position of 300 units";
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail });
    expect(w.alerts).toEqual([{ kind: "payout_mismatch", orderAddress: null, detail: `${SYMBOL}: ${detail}` }]);
    expect(w.chain.settlements).toEqual([]);
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

  it("restarts the clock, without an alert, when a resolution falls back to under review", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");
    await w.watcher.tick();

    // A stale read: the contract is under review again. The registry keeps what it knew.
    w.clock.ms += 15_000;
    w.venue.addContract({ ...info(SYMBOL), status: "under_review", marketState: "closed" });
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "awaiting_result", venueStatus: "settled", resolution: "yes" });

    w.clock.ms += 5_000; // the first sighting would be confirmed by now
    w.venue.addContract({ ...info(SYMBOL), status: "settled", marketState: "closed", resolutionSide: "yes" });
    await w.watcher.tick();
    w.clock.ms += CONFIRM - 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);

    w.clock.ms += 1;
    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
    expect(w.alerts).toEqual([]);
  });

  it("waits out the payout grace when the venue paid less than expected, then asks for review with both numbers", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 200n);
    w.venue.resolve(SYMBOL, "yes"); // paid 200 units, 300 are outstanding
    await w.confirm();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");

    w.clock.ms = START + PAYOUT_GRACE - 1; // the resolution was first seen at START
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");
    expect(w.alerts).toEqual([]);
    expect(w.chain.settlements).toEqual([]);

    w.clock.ms += 1;
    await w.watcher.tick();
    const detail = "venue paid 2000000 micro-dollars, expected 3000000";
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail });
    expect(w.alerts).toEqual([{ kind: "payout_mismatch", orderAddress: null, detail: `${SYMBOL}: ${detail}` }]);

    await w.watcher.tick();
    expect(w.alerts).toHaveLength(1);
    expect(w.chain.settlements).toEqual([]);
  });

  it("asks for review when no settled row shows up within the grace for a position the chain implies", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.venue.resolve(SYMBOL, "yes"); // the venue account was flat
    await w.confirm();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");
    w.clock.ms = START + PAYOUT_GRACE;
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail: "no settled position for a net position of 300 units" });
    expect(w.chain.settlements).toEqual([]);
  });

  it("settles when the settled row is published late, within the grace", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.venue.resolve(SYMBOL, "yes");
    const payout = vi.spyOn(w.venue, "settledPayoutMicros").mockResolvedValue(null); // resolved, row not there yet
    await w.confirm();
    w.clock.ms += 30_000;
    await w.watcher.tick();
    expect(payout).toHaveBeenCalledTimes(2);
    expect(w.chain.settlements).toEqual([]);
    expect(w.alerts).toEqual([]);

    payout.mockRestore();
    w.clock.ms += 5_000;
    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
    expect(w.registry.get(SYMBOL)?.settleState).toBe("settled");
    expect(w.alerts).toEqual([]);
  });

  it("asks for review at once when the venue paid more than expected", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 500n);
    w.venue.resolve(SYMBOL, "yes"); // paid 500 units, 300 are outstanding
    w.market(OTHER, 200n, 0n);
    await w.hold(OTHER, 200n);
    w.venue.resolve(OTHER, "yes");
    vi.spyOn(w.venue, "settledPayoutMicros").mockImplementation(async (symbol) => (symbol === OTHER ? 2_000_000n : 5_000_000n));
    w.chain.setSupply(OTHER, 0n, 200n); // nothing is due for OTHER, yet the venue paid
    await w.confirm();

    expect(w.chain.settlements).toEqual([]);
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", detail: "venue paid 5000000 micro-dollars, expected 3000000" });
    expect(w.registry.get(OTHER)).toMatchObject({ settleState: "needs_review", detail: "venue paid 2000000 micro-dollars, expected 0" });
    expect(w.alerts.map((alert) => alert.kind)).toEqual(["payout_mismatch", "payout_mismatch"]);
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

  it("restarts the wait, without review, when a resolution seen long after expiry falls back", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    await w.hold(SYMBOL, 300n);
    w.clock.ms = EXPIRY + REVIEW_AFTER + 60_000;
    w.venue.resolve(SYMBOL, "yes");
    await w.watcher.tick();

    w.clock.ms += 5_000; // a stale read: under review again
    w.venue.addContract({ ...info(SYMBOL), status: "under_review", marketState: "closed" });
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("awaiting_result");

    w.clock.ms += 5_000;
    w.venue.addContract({ ...info(SYMBOL), status: "settled", marketState: "closed", resolutionSide: "yes" });
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([{ symbol: SYMBOL, yesPayout: 10_000n, noPayout: 0n }]);
    expect(w.alerts).toEqual([]);
  });

  it("asks for review when the venue settled the contract without a yes or no", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.venue.addContract({ ...info(SYMBOL), status: "settled", marketState: "closed", resolutionSide: null });
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)?.settleState).toBe("needs_review");
    expect(w.alerts).toEqual([{ kind: "needs_review", orderAddress: null, detail: `${SYMBOL}: settled at the venue without a yes or no resolution` }]);
  });

  it("asks for review at once when the venue reports a status it does not know, whatever else the contract says", async () => {
    const w = world();
    w.market(SYMBOL, 300n, 0n);
    w.market(OTHER, 300n, 0n);
    w.venue.addContract({ ...info(SYMBOL), status: "invalid", marketState: "closed" });
    w.venue.addContract({ ...info(OTHER), status: "voided", marketState: "closed", resolutionSide: "yes" });
    w.clock.ms = EXPIRY - 300_000; // before the expiry, and long before the review deadline
    await w.watcher.tick();
    expect(w.registry.get(SYMBOL)).toMatchObject({ settleState: "needs_review", venueStatus: "invalid", detail: "unknown venue status: invalid" });
    expect(w.registry.get(OTHER)).toMatchObject({ settleState: "needs_review", venueStatus: "voided", detail: "unknown venue status: voided" });

    await w.confirm();
    expect(w.alerts).toEqual([
      { kind: "needs_review", orderAddress: null, detail: `${SYMBOL}: unknown venue status: invalid` },
      { kind: "needs_review", orderAddress: null, detail: `${OTHER}: unknown venue status: voided` },
    ]);
    expect(w.chain.settlements).toEqual([]);
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

describe("settlement watcher, a ladder", () => {
  it("settles each contract on its own resolution, one by one, and more than one of them YES", async () => {
    const w = world();
    for (const symbol of LADDER) {
      w.market(symbol, 100n, 0n);
      await w.hold(symbol, 100n);
    }
    const states = (): Array<string | undefined> => LADDER.map((symbol) => w.registry.get(symbol)?.settleState);

    w.venue.resolve(LOW, "yes");
    await w.watcher.tick();
    w.clock.ms += 10_000;
    w.venue.resolve(MID, "yes");
    w.venue.resolve(HIGH, "no");
    await w.watcher.tick();
    expect(w.chain.settlements).toEqual([]);

    w.clock.ms += 10_000; // the lowest strike has been resolved for the confirmation time
    await w.watcher.tick();
    expect(w.chain.settlements).toMatchObject([{ symbol: LOW, yesPayout: 10_000n, noPayout: 0n }]);
    expect(states()).toEqual(["settled", "awaiting_result", "awaiting_result", "awaiting_result"]);

    w.clock.ms += 10_000;
    await w.watcher.tick();
    expect(w.chain.settlements.slice(1)).toMatchObject([
      { symbol: MID, yesPayout: 10_000n, noPayout: 0n },
      { symbol: HIGH, yesPayout: 0n, noPayout: 10_000n },
    ]);
    expect(states()).toEqual(["settled", "settled", "settled", "awaiting_result"]);

    w.venue.resolve(TOP, "no");
    await w.confirm();
    expect(w.chain.settlements.slice(3)).toMatchObject([{ symbol: TOP, yesPayout: 0n, noPayout: 10_000n }]);
    expect(states()).toEqual(["settled", "settled", "settled", "settled"]);
    expect(w.alerts).toEqual([]);
  });

  it("hands a contract that stays under review to a person while its siblings settle", async () => {
    const w = world();
    for (const symbol of [LOW, MID, HIGH]) {
      w.market(symbol, 100n, 0n);
      await w.hold(symbol, 100n);
    }
    w.venue.resolve(LOW, "yes");
    w.venue.resolve(HIGH, "no");
    w.venue.addContract({ ...info(MID), status: "under_review", marketState: "closed" });
    await w.confirm();
    expect(w.chain.settlements).toMatchObject([
      { symbol: LOW, yesPayout: 10_000n, noPayout: 0n },
      { symbol: HIGH, yesPayout: 0n, noPayout: 10_000n },
    ]);
    expect(w.registry.get(MID)).toMatchObject({ settleState: "awaiting_result", venueStatus: "under_review" });

    w.clock.ms = EXPIRY + REVIEW_AFTER - 1;
    await w.watcher.tick();
    expect(w.registry.get(MID)?.settleState).toBe("awaiting_result");
    expect(w.alerts).toEqual([]);

    w.clock.ms += 1;
    await w.watcher.tick();
    await w.watcher.tick();
    expect(w.registry.get(MID)).toMatchObject({ settleState: "needs_review", detail: "no resolution 600 s after expiry" });
    expect(w.alerts).toEqual([{ kind: "needs_review", orderAddress: null, detail: `${MID}: no resolution 600 s after expiry` }]);
    expect(w.chain.settlements).toHaveLength(2);
  });

  it("asks the venue about the due contracts of one event together, after their chain reads", async () => {
    const w = world();
    for (const symbol of [...LADDER, OTHER]) w.market(symbol, 100n, 0n);
    const log: string[] = [];
    const market = w.chain.market.bind(w.chain);
    vi.spyOn(w.chain, "market").mockImplementation((symbol) => {
      log.push(`chain ${symbol}`);
      return market(symbol);
    });
    const contract = w.venue.contract.bind(w.venue);
    vi.spyOn(w.venue, "contract").mockImplementation((symbol) => {
      log.push(`venue ${symbol}`);
      return contract(symbol);
    });
    await w.watcher.tick();
    expect(log).toEqual([
      ...LADDER.map((symbol) => `chain ${symbol}`),
      ...LADDER.map((symbol) => `venue ${symbol}`),
      `chain ${OTHER}`,
      `venue ${OTHER}`,
    ]);
  });
});

describe("settlement watcher, the bounds of one tick", () => {
  const SINGLES = ["ETH", "SOL", "XRP"].map((asset) => `TEST-${asset}15M2611140300-UP`);
  const [ETH, SOL, XRP] = SINGLES as [string, string, string];

  it("takes up no more markets and events than it may read, and what is left over first in the next ticks", async () => {
    const w = world({ marketsPerTick: 4, venueReadsPerTick: 2 });
    for (const symbol of [...LADDER, ...SINGLES]) w.market(symbol, 100n, 0n);
    const asked = vi.spyOn(w.venue, "contract");
    /** One tick, five seconds after the last: the markets read from the chain and asked of the venue. */
    const tick = async (): Promise<{ chain: string[]; venue: string[] }> => {
      w.clock.ms += 5_000;
      w.chain.reads.length = 0;
      asked.mockClear();
      await w.watcher.tick();
      return { chain: [...w.chain.reads], venue: asked.mock.calls.map(([symbol]) => symbol) };
    };

    // Four markets: the ladder, which is one read of the venue.
    expect(await tick()).toEqual({ chain: LADDER, venue: LADDER });
    // The four that waited longest are ETH, SOL, XRP and the lowest strike; two reads of the venue reach two events.
    expect(await tick()).toEqual({ chain: [ETH, SOL], venue: [ETH, SOL] });
    expect(await tick()).toEqual({ chain: [XRP, LOW, MID, HIGH], venue: [XRP, LOW, MID, HIGH] });
    // The highest strike has waited since the first tick, ETH and SOL since the second; the lowest strike fills
    // the fourth place and shares its sibling's read of the venue, which leaves one read, for ETH.
    expect(await tick()).toEqual({ chain: [TOP, LOW, ETH], venue: [TOP, LOW, ETH] });
    expect(w.alerts).toEqual([]);
  });

  it("counts the read of a payout: a resolution it cannot check in this tick is settled in the next", async () => {
    const w = world({ venueReadsPerTick: 2 });
    for (const symbol of [LOW, MID, HIGH]) {
      w.market(symbol, 100n, 0n);
      await w.hold(symbol, 100n);
      w.venue.resolve(symbol, "yes");
    }
    const payout = vi.spyOn(w.venue, "settledPayoutMicros");
    await w.confirm(); // one read for the three contracts, one for a payout
    expect(w.chain.settlements.map((settlement) => settlement.symbol)).toEqual([LOW]);
    expect(payout).toHaveBeenCalledTimes(1);

    await w.watcher.tick();
    expect(w.chain.settlements.map((settlement) => settlement.symbol)).toEqual([LOW, MID]);
    await w.watcher.tick();
    expect(w.chain.settlements.map((settlement) => settlement.symbol)).toEqual([LOW, MID, HIGH]);
    expect(payout).toHaveBeenCalledTimes(3);
    expect(w.alerts).toEqual([]);
  });
});
