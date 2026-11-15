import { afterEach, describe, expect, it, vi } from "vitest";
import { openJournal } from "../src/journal.ts";
import type { Journal, NewOrder } from "../src/journal.ts";
import { createReconciler, reconcile } from "../src/reconcile.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { eventOf } from "./helpers/events.ts";
import { FakeMarketChain } from "./helpers/fake-market-chain.ts";

// Synthetic contracts.
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const BTC = "TEST-BTC15M2611140300-UP";
const ETH = "TEST-ETH15M2611140300-UP";

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
  };
}

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

let nextId = 0;

function world() {
  const venue = new MockVenue();
  venue.setCash(1_000_000_000n);
  const chain = new FakeMarketChain();
  chain.treasury = 100_000_000n;
  const registry: Registry = openRegistry(":memory:");
  const journal: Journal = openJournal(":memory:");
  closers.push(registry, journal);
  const alerts: Array<{ kind: string; orderAddress: string | null; detail: string }> = [];

  /** Lists a contract in the registry; with supplies it is also on the chain. */
  function market(symbol: string, supplies?: { yes: bigint; no: bigint }): void {
    venue.addContract(info(symbol));
    registry.storeEvents([eventOf([info(symbol)])], EXPIRY - 600_000);
    if (supplies === undefined) return;
    chain.addMarket(symbol, { yesSupply: supplies.yes, noSupply: supplies.no });
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

  /** A journal row filled at the venue for `units`; `end` moves it on from `venue_filled`. */
  function venueFilled(symbol: string, kind: "buy" | "sell", side: "YES" | "NO", units: bigint, end?: "orphaned" | "chain_filled"): void {
    const id = ++nextId;
    const order: NewOrder = {
      orderAddress: `Order${id}`,
      clientOrderId: `client-${id}`,
      user: "UserA",
      kind,
      side,
      symbol,
      units,
      limitPx: 5_000n,
      maxFeeMicros: 50_000n,
      expiresAt: EXPIRY / 1000 - 200,
    };
    journal.recordSeen(order);
    journal.markSubmitting(order.orderAddress);
    journal.recordVenueResult(order.orderAddress, {
      kind: "filled",
      venueOrderId: `7000000000000000${id}`,
      fills: [{ tradeId: `trade-${id}`, units, px: 5_000n, feeMicros: 0n, feeSource: "reported" }],
      filledUnits: units,
      costMicros: units * 5_000n,
      feeMicros: 0n,
    });
    if (end !== undefined) journal.markChain(order.orderAddress, end);
  }

  const deps = { venue, chain, registry, journal };
  return { ...deps, deps, alerts, market, hold, venueFilled };
}

describe("reconcile", () => {
  it("balances the venue position against the supplies, in-flight fills and orphaned fills", async () => {
    const w = world();
    w.market(BTC, { yes: 500n, no: 200n });
    // In flight: a buy YES of 40 (+40) and a sell YES of 10 (the venue bought NO: -10).
    w.venueFilled(BTC, "buy", "YES", 40n);
    w.venueFilled(BTC, "sell", "YES", 10n);
    // Orphaned: a buy NO of 25 (-25). Recorded fills are already in the supplies.
    w.venueFilled(BTC, "buy", "NO", 25n, "orphaned");
    w.venueFilled(BTC, "buy", "YES", 60n, "chain_filled");
    await w.hold(BTC, 300n + 40n - 10n - 25n);

    const result = await reconcile(w.deps);
    expect(result.markets).toEqual([
      { symbol: BTC, yesSupply: "500", noSupply: "200", venueNet: "305", inFlight: "30", houseInventory: "-25", balanced: true },
    ]);
  });

  it("reports a market whose venue position does not match as unbalanced", async () => {
    const w = world();
    w.market(BTC, { yes: 500n, no: 200n });
    w.market(ETH, { yes: 0n, no: 150n });
    await w.hold(BTC, 299n);
    await w.hold(ETH, -150n);
    w.venueFilled(ETH, "sell", "NO", 30n); // another symbol's in-flight row is not BTC's

    const result = await reconcile(w.deps);
    expect(result.markets).toEqual([
      { symbol: BTC, yesSupply: "500", noSupply: "200", venueNet: "299", inFlight: "0", houseInventory: "0", balanced: false },
      { symbol: ETH, yesSupply: "0", noSupply: "150", venueNet: "-150", inFlight: "30", houseInventory: "0", balanced: false },
    ]);
  });

  it("reads the venue's positions once per run, whatever the number of markets", async () => {
    const w = world();
    const positions = vi.spyOn(w.venue, "positions");
    expect((await reconcile(w.deps)).markets).toEqual([]);
    expect(positions).toHaveBeenCalledTimes(1);

    w.market(BTC, { yes: 500n, no: 200n });
    w.market(ETH, { yes: 0n, no: 150n });
    w.market("TEST-SOL15M2611140300-UP", { yes: 40n, no: 40n }); // flat: the venue reports no row for it
    await w.hold(BTC, 300n);
    await w.hold(ETH, -150n);
    positions.mockClear();

    const result = await reconcile(w.deps);
    expect(positions).toHaveBeenCalledTimes(1);
    expect(result.markets.map((market) => [market.symbol, market.venueNet, market.balanced])).toEqual([
      [BTC, "300", true],
      [ETH, "-150", true],
      ["TEST-SOL15M2611140300-UP", "0", true],
    ]);
  });

  it("treats the strikes of one ladder as separate markets: nothing nets across them", async () => {
    const w = world();
    const low = "TEST-BTC2611140400-HI64000";
    const high = "TEST-BTC2611140400-HI65000";
    w.venue.addContract(info(low));
    w.venue.addContract(info(high));
    w.registry.storeEvents([eventOf([info(low), info(high)])], EXPIRY - 600_000);
    for (const [symbol, yes, no] of [[low, 100n, 0n], [high, 0n, 80n]] as const) {
      w.chain.addMarket(symbol, { yesSupply: yes, noSupply: no });
      w.registry.setOnchain(symbol, { marketAddress: `market:${symbol}`, yesMint: `yes:${symbol}`, noMint: `no:${symbol}` });
    }
    await w.hold(low, 100n);
    await w.hold(high, -80n);

    const result = await reconcile(w.deps);
    expect(result.markets).toEqual([
      { symbol: low, yesSupply: "100", noSupply: "0", venueNet: "100", inFlight: "0", houseInventory: "0", balanced: true },
      { symbol: high, yesSupply: "0", noSupply: "80", venueNet: "-80", inFlight: "0", houseInventory: "0", balanced: true },
    ]);
    // YES on the low strike and NO on the high one can both win: both are covered in full.
    expect(result.solvency.requiredMicros).toBe("1800000");
  });

  it("covers on-chain markets that are not settled, including those under review", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    w.market(ETH, { yes: 70n, no: 90n });
    w.market("TEST-SOL15M2611140300-UP"); // never created on-chain
    w.market("TEST-XRP15M2611140300-UP", { yes: 10n, no: 0n });
    w.market("TEST-ADA15M2611140300-UP", { yes: 20n, no: 0n });
    w.market("TEST-DOT15M2611140300-UP", { yes: 0n, no: 0n });
    w.registry.setSettle(ETH, "needs_review");
    w.registry.setSettle("TEST-XRP15M2611140300-UP", "settled");
    // Settled on-chain, the registry has not caught up yet.
    await w.chain.settleMarket("TEST-ADA15M2611140300-UP", 10_000n, 0n);
    w.registry.setSettle("TEST-DOT15M2611140300-UP", "unused");

    const result = await reconcile(w.deps);
    expect(result.markets.map((market) => market.symbol).sort()).toEqual([BTC, ETH]);
    // The most either side could claim: 100 for BTC, 90 for ETH.
    expect(result.solvency.requiredMicros).toBe("1900000");
  });

  it("solvency: the treasury must cover the larger side of every unsettled market", async () => {
    const w = world();
    w.market(BTC, { yes: 500n, no: 200n });
    w.market(ETH, { yes: 100n, no: 300n });
    w.chain.treasury = 8_000_000n;
    w.venue.setCash(123_456_789n);
    expect((await reconcile(w.deps)).solvency).toEqual({ venueCashMicros: "123456789", treasuryMicros: "8000000", requiredMicros: "8000000", ok: true });

    w.chain.treasury = 7_999_999n;
    expect((await reconcile(w.deps)).solvency).toMatchObject({ treasuryMicros: "7999999", requiredMicros: "8000000", ok: false });
  });
});

describe("createReconciler", () => {
  function reconciler(w: ReturnType<typeof world>) {
    return createReconciler({ ...w.deps, alert: (event) => w.alerts.push(event) });
  }

  it("stores the last result", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    await w.hold(BTC, 100n);
    const r = reconciler(w);
    expect(r.last()).toBeNull();
    const result = await r.run();
    expect(result.markets).toMatchObject([{ symbol: BTC, balanced: true }]);
    expect(r.last()).toEqual(result);
    expect(w.chain.pauses).toEqual([]);
  });

  it("pauses order placement, once, when a market is unbalanced three runs in a row", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    await w.hold(BTC, 90n);
    const r = reconciler(w);

    await r.run();
    await r.run();
    expect(w.chain.pauses).toEqual([]);
    await r.run();
    expect(w.chain.pauses).toEqual([{ place: true }]);
    expect(w.alerts).toEqual([{ kind: "auto_paused", orderAddress: null, detail: `unbalanced for 3 runs: ${BTC}` }]);

    await r.run();
    expect(w.chain.pauses).toHaveLength(1);
    expect(w.alerts).toHaveLength(1);
  });

  it("starts counting again when a market balances in between", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    await w.hold(BTC, 90n);
    const r = reconciler(w);
    await r.run();
    await r.run();
    await w.hold(BTC, 10n); // balanced
    await r.run();
    w.chain.setSupply(BTC, 120n, 0n); // unbalanced again
    await r.run();
    await r.run();
    expect(w.chain.pauses).toEqual([]);
    await r.run();
    expect(w.chain.pauses).toEqual([{ place: true }]);
  });

  it("pauses at once when the treasury cannot cover the open markets", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    await w.hold(BTC, 100n);
    w.chain.treasury = 999_999n;
    const r = reconciler(w);
    await r.run();
    expect(w.chain.pauses).toEqual([{ place: true }]);
    expect(w.alerts).toEqual([{ kind: "auto_paused", orderAddress: null, detail: "treasury 999999 micro-dollars is below the 1000000 the open markets could require" }]);
    await r.run();
    expect(w.chain.pauses).toHaveLength(1);
  });

  it("tries the pause again on the next run when it could not be sent", async () => {
    const w = world();
    w.market(BTC, { yes: 100n, no: 0n });
    await w.hold(BTC, 100n);
    w.chain.treasury = 0n;
    w.chain.fail("pause", 1);
    const r = reconciler(w);
    await expect(r.run()).rejects.toThrow("injected failure: pause");
    expect(w.alerts).toEqual([]);
    await r.run();
    expect(w.chain.pauses).toEqual([{ place: true }]);
    expect(w.alerts).toHaveLength(1);
  });
});
