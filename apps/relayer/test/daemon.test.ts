import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainOrder } from "../src/chain/chain.ts";
import { createAlertLog, createDaemon } from "../src/daemon.ts";
import { openJournal } from "../src/journal.ts";
import type { NewOrder } from "../src/journal.ts";
import { createMarketManager } from "../src/markets.ts";
import { feeCap } from "../src/money.ts";
import { DEFAULT_PIPELINE_CONFIG } from "../src/pipeline.ts";
import { createReconciler } from "../src/reconcile.ts";
import { openRegistry } from "../src/registry.ts";
import { createSettlementWatcher } from "../src/settlement.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { FakeFullChain } from "./helpers/fake-full-chain.ts";

// A synthetic 15-minute contract: window 02:45 to 03:00, the clock starts at 02:50.
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");
const NOW = Date.parse("2026-11-14T02:50:00Z");
const SYMBOL = "TEST-BTC15M2611140300-UP";
const IDENTITY = { cluster: "localnet", venue: "mock", programId: "Program", relayer: "Relayer", stableMint: "StableMint" } as const;

function info(overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    symbol: SYMBOL,
    eventTicker: "BTC15M2611140300",
    status: "active",
    marketState: "open",
    effectiveAt: new Date(EFFECTIVE),
    expiresAt: new Date(EXPIRY),
    tickPx: 100n,
    unitIncrement: 1n,
    minUnits: 1n,
    resolutionSide: null,
    label: "Up",
    ...overrides,
  };
}

let orderSeq = 0;
/** BUY YES 300 units at no more than 4_500, expiring 90 s from the start. */
function buyOrder(overrides: Partial<ChainOrder> = {}): ChainOrder {
  orderSeq += 1;
  const addressBytes = new Uint8Array(32);
  new DataView(addressBytes.buffer).setUint32(0, orderSeq);
  return {
    address: `Order${orderSeq}`,
    addressBytes,
    user: "UserA",
    symbol: SYMBOL,
    side: "YES",
    kind: "buy",
    units: 300n,
    limitPx: 4_500n,
    maxFeeMicros: feeCap(300n, 4_500n),
    expiresAt: NOW / 1000 + 90,
    ...overrides,
  };
}

/** Timers the test fires by hand. */
function manualTimers() {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let nextHandle = 1;
  return {
    timers,
    setInterval: (run: () => void, ms: number): unknown => {
      timers.set(nextHandle, { run, ms });
      return nextHandle++;
    },
    clearInterval: (handle: unknown): void => {
      timers.delete(handle as number);
    },
    /** Runs every timer with this period once. */
    fire: (ms: number): void => {
      for (const timer of [...timers.values()]) if (timer.ms === ms) timer.run();
    },
  };
}

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

function world() {
  const clock = { ms: NOW };
  const now = () => clock.ms;
  const venue = new MockVenue({ now });
  venue.addContract(info());
  venue.setBook(SYMBOL, { bids: [[4_000n, 5_000n]], asks: [[4_500n, 5_000n]] });
  venue.setCash(1_000_000_000n);
  const chain = new FakeFullChain(NOW / 1000);
  chain.marketSide.treasury = 50_000_000n;
  const journal = openJournal(":memory:");
  const registry = openRegistry(":memory:");
  closers.push(journal, registry);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  const alerts = createAlertLog({ log, now });
  const manager = createMarketManager({ venue, chain, registry, now });
  const settlement = createSettlementWatcher({ venue, chain, registry, journal, now, alert: alerts.alert });
  const reconciler = createReconciler({ venue, chain, registry, journal, alert: alerts.alert });
  const timers = manualTimers();
  const daemon = createDaemon({
    identity: IDENTITY,
    venue,
    chain,
    journal,
    manager,
    settlement,
    reconciler,
    alerts,
    now,
    log,
    sleep: async (ms) => {
      chain.nowSecs += ms / 1000;
    },
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });

  /** A journal row for an order the chain does not have. */
  function strayRow(overrides: Partial<NewOrder> = {}): string {
    const order = buyOrder();
    journal.recordSeen({
      orderAddress: order.address,
      clientOrderId: `client-${order.address}`,
      user: order.user,
      kind: "buy",
      side: "YES",
      symbol: SYMBOL,
      units: order.units,
      limitPx: order.limitPx,
      maxFeeMicros: order.maxFeeMicros,
      expiresAt: order.expiresAt,
      ...overrides,
    });
    return order.address;
  }

  const kinds = () => alerts.recent().map((alert) => alert.kind);
  return { venue, chain, journal, registry, clock, logs, alerts, manager, settlement, reconciler, timers, daemon, strayRow, kinds };
}

describe("order tick", () => {
  it("fills an order placed on the chain on the next tick", async () => {
    const w = world();
    const order = buyOrder();
    w.chain.addOrder(order);
    await w.daemon.tickOrders();

    expect(w.chain.fills).toMatchObject([{ address: order.address, kind: "buy", fillUnits: 300n, amountMicros: 1_350_000n }]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_filled", filledUnits: 300n });
    expect(w.logs).toContainEqual(`order ${order.address} buy YES 300 ${SYMBOL}: chain_filled`);
    expect(w.alerts.recent()).toEqual([]);

    await w.daemon.tickOrders();
    expect(w.venue.requests).toHaveLength(1);
  });

  it("takes the orders one at a time, the soonest expiry first", async () => {
    const w = world();
    const later = buyOrder({ expiresAt: NOW / 1000 + 80 });
    const sooner = buyOrder({ expiresAt: NOW / 1000 + 40 });
    w.chain.addOrder(later);
    w.chain.addOrder(sooner);
    let active = 0;
    let most = 0;
    const real = w.venue.placeOrder.bind(w.venue);
    vi.spyOn(w.venue, "placeOrder").mockImplementation(async (request) => {
      most = Math.max(most, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return real(request);
    });
    await w.daemon.tickOrders();
    expect(w.chain.fills.map((fill) => fill.address)).toEqual([sooner.address, later.address]);
    expect(most).toBe(1);
  });

  it("reports a tick error as an alert, once while it repeats, and the next tick still runs", async () => {
    const w = world();
    const order = buyOrder();
    w.chain.addOrder(order);
    const open = vi.spyOn(w.chain, "openOrders").mockRejectedValueOnce(new Error("rpc down")).mockRejectedValueOnce(new Error("rpc down"));

    await expect(w.daemon.tickOrders()).resolves.toBeUndefined();
    expect(w.alerts.recent()).toEqual([{ at: NOW, kind: "tick_error", orderAddress: null, detail: "orders: rpc down" }]);
    expect(w.logs).toContainEqual("alert tick_error - orders: rpc down");
    expect(w.daemon.health().ok).toBe(false);
    await w.daemon.tickOrders();
    expect(w.alerts.recent()).toHaveLength(1);

    await w.daemon.tickOrders();
    expect(open).toHaveBeenCalledTimes(3);
    expect(w.chain.fills).toHaveLength(1);
    expect(w.logs).toContainEqual("orders tick recovered");
  });

  it("keeps going with the other orders when one cannot be processed, and tries that one again", async () => {
    const w = world();
    const first = buyOrder({ expiresAt: NOW / 1000 + 40 });
    const second = buyOrder({ expiresAt: NOW / 1000 + 80 });
    w.chain.addOrder(first);
    w.chain.addOrder(second);
    vi.spyOn(w.chain, "now").mockRejectedValueOnce(new Error("clock unreadable"));

    await w.daemon.tickOrders();
    expect(w.chain.fills.map((fill) => fill.address)).toEqual([second.address]);
    expect(w.alerts.recent()).toEqual([{ at: NOW, kind: "order_error", orderAddress: first.address, detail: "clock unreadable" }]);
    expect(w.journal.get(first.address)?.state).toBe("seen");

    await w.daemon.tickOrders();
    expect(w.chain.fills.map((fill) => fill.address)).toEqual([second.address, first.address]);
  });

  it("never overlaps itself", async () => {
    const w = world();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = vi.spyOn(w.chain, "openOrders").mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const first = w.daemon.tickOrders();
    await w.daemon.tickOrders(); // returns at once: the first is still running
    w.timers.fire(2_000); // not started: no timers
    expect(open).toHaveBeenCalledTimes(1);
    release();
    await first;
    await w.daemon.tickOrders();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("runs recover for journal rows whose order vanished, at most every 30 s", async () => {
    const w = world();
    const recovered = vi.spyOn(w.chain, "openOrders");
    const gone = w.strayRow();
    await w.daemon.tickOrders();
    expect(w.journal.get(gone)).toMatchObject({ state: "failed", detail: "order account gone before submission" });
    expect(recovered).toHaveBeenCalledTimes(2); // the tick's own read, then recover's

    const next = w.strayRow();
    w.clock.ms += 29_999;
    await w.daemon.tickOrders();
    expect(w.journal.get(next)?.state).toBe("seen");
    w.clock.ms += 1;
    await w.daemon.tickOrders();
    expect(w.journal.get(next)?.state).toBe("failed");

    // Nothing vanished: recover is not run at all.
    recovered.mockClear();
    w.clock.ms += 60_000;
    await w.daemon.tickOrders();
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("sends nothing to the venue while fills are paused on-chain: the order is cancelled", async () => {
    const w = world();
    w.chain.marketSide.configValue.pauseFill = true;
    await w.daemon.tickMarkets(); // reads the pause flags
    const order = buyOrder();
    w.chain.addOrder(order);
    await w.daemon.tickOrders();

    expect(w.venue.requests).toEqual([]);
    expect(w.chain.fills).toEqual([]);
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_cancelled", detail: "rejected: fills are paused on-chain" });
  });
});

describe("market tick", () => {
  it("refreshes the markets and marks the venue offline only while its list fails", async () => {
    const w = world();
    await w.daemon.tickMarkets();
    expect(w.manager.view(SYMBOL)).toMatchObject({ tradable: true, book: { bidPx: "4000", askPx: "4500" } });
    expect(w.daemon.health()).toMatchObject({ venueConnected: true });

    const list = vi.spyOn(w.venue, "listEvents").mockRejectedValueOnce(new Error("venue down"));
    await w.daemon.tickMarkets(); // four seconds later the list is not asked for again
    expect(list).not.toHaveBeenCalled();
    expect(w.daemon.health()).toMatchObject({ ok: true, venueConnected: true });

    w.clock.ms += 15_000;
    await w.daemon.tickMarkets();
    expect(w.manager.view(SYMBOL)).toMatchObject({ tradable: false, notTradableReason: "venue_offline" });
    expect(w.daemon.health()).toMatchObject({ ok: false, venueConnected: false });
    expect(w.alerts.recent()).toMatchObject([{ kind: "tick_error", detail: "markets: market refresh failed: venue_list: venue down" }]);

    await w.daemon.tickMarkets(); // asked again on the very next tick
    expect(w.manager.view(SYMBOL)?.notTradableReason).toBeNull();
    expect(w.daemon.health()).toMatchObject({ ok: true, venueConnected: true });
    expect(w.logs).toContainEqual("markets tick recovered");

    // The list works; a chain read does not. That is not the venue being away.
    await w.manager.ensureOnchain(SYMBOL);
    w.chain.marketSide.fail("market", 1);
    w.clock.ms += 15_000;
    await w.daemon.tickMarkets();
    expect(w.manager.view(SYMBOL)?.notTradableReason).toBeNull();
    expect(w.daemon.health()).toMatchObject({ ok: true, venueConnected: true });
    expect(w.alerts.recent()[0]).toMatchObject({ kind: "tick_error", detail: "markets: market refresh failed: chain: injected failure: market" });
    expect(w.kinds()).toEqual(["tick_error", "tick_error"]);
  });

  it("re-reads the chain config every 10 s and passes the pause flags on", async () => {
    const w = world();
    const config = vi.spyOn(w.chain, "config");
    await w.daemon.tickMarkets();
    expect(config).toHaveBeenCalledTimes(1);
    expect(w.daemon.health().paused).toEqual({ place: false, fill: false });

    await w.chain.pause({ place: true });
    w.clock.ms += 9_999;
    await w.daemon.tickMarkets();
    expect(config).toHaveBeenCalledTimes(1);
    expect(w.manager.view(SYMBOL)?.notTradableReason).toBeNull();

    w.clock.ms += 1;
    await w.daemon.tickMarkets();
    expect(config).toHaveBeenCalledTimes(2);
    expect(w.manager.view(SYMBOL)?.notTradableReason).toBe("paused");
    expect(w.daemon.health().paused).toEqual({ place: true, fill: false });
  });

  it("still refreshes the markets when the chain config cannot be read, and reads it again on the next tick", async () => {
    const w = world();
    const config = vi.spyOn(w.chain, "config").mockRejectedValueOnce(new Error("rpc down"));
    await w.daemon.tickMarkets();
    expect(w.manager.view(SYMBOL)?.tradable).toBe(true);
    expect(w.alerts.recent()).toMatchObject([{ kind: "tick_error", detail: "markets: rpc down" }]);
    expect(w.daemon.health()).toMatchObject({ ok: false, chainTime: 0 });
    await w.daemon.tickMarkets();
    expect(config).toHaveBeenCalledTimes(2);
    expect(w.daemon.health().ok).toBe(true);
  });
});

describe("health and status", () => {
  it("health reports identity, limits, pause flags and the cluster clock from cached values", async () => {
    const w = world();
    expect(w.daemon.health()).toMatchObject({ ok: false, chainTime: 0, orderTtlSecs: 0 });
    await w.daemon.tickMarkets();
    const config = vi.spyOn(w.chain, "config");
    w.clock.ms += 3_500;
    expect(w.daemon.health()).toEqual({
      ok: true,
      cluster: "localnet",
      venue: "mock",
      programId: "Program",
      relayer: "Relayer",
      stableMint: "StableMint",
      paused: { place: false, fill: false },
      venueConnected: true,
      chainTime: NOW / 1000 + 3,
      serverTime: NOW + 3_500,
      orderTtlSecs: 90,
      minOrderUnits: "1",
      maxOrderUnits: "10000",
      feeSlackMicros: DEFAULT_PIPELINE_CONFIG.feeSlackMicros.toString(),
    });
    expect(config).not.toHaveBeenCalled();
  });

  it("status reports the last reconciliation, journal counts, the relayer balance and alerts newest first", async () => {
    const w = world();
    expect(w.daemon.status()).toMatchObject({ markets: [], solvency: { ok: false, requiredMicros: "0" }, relayerLamports: "0", alerts: [] });

    await w.daemon.tickMarkets();
    await w.manager.ensureOnchain(SYMBOL);
    const order = buyOrder();
    w.chain.addOrder(order);
    await w.daemon.tickOrders();
    w.strayRow();
    w.alerts.alert({ kind: "first", orderAddress: null, detail: "older" });
    w.clock.ms += 1_000;
    w.alerts.alert({ kind: "second", orderAddress: order.address, detail: "newer" });
    await w.daemon.tickReconcile();

    const status = w.daemon.status();
    expect(status.markets).toEqual([
      { symbol: SYMBOL, yesSupply: "300", noSupply: "0", venueNet: "300", inFlight: "0", houseInventory: "0", balanced: true },
    ]);
    expect(status.solvency).toEqual({ venueCashMicros: (1_000_000_000n - 1_350_000n).toString(), treasuryMicros: "50000000", requiredMicros: "3000000", ok: true });
    expect(status.journal).toEqual({
      seen: 1,
      submitting: 0,
      venue_filled: 0,
      venue_not_filled: 0,
      venue_unknown: 0,
      chain_filled: 1,
      chain_cancelled: 0,
      orphaned: 0,
      failed: 0,
    });
    expect(status.relayerLamports).toBe("2000000000");
    expect(status.alerts).toEqual([
      { at: NOW + 1_000, kind: "second", orderAddress: order.address, detail: "newer" },
      { at: NOW, kind: "first", orderAddress: null, detail: "older" },
    ]);
  });

  it("alerts once when the relayer runs low on SOL, and reports a failed reconciliation", async () => {
    const w = world();
    w.chain.marketSide.lamports = 100_000_000n;
    await w.daemon.tickReconcile();
    await w.daemon.tickReconcile();
    expect(w.alerts.recent()).toMatchObject([{ kind: "relayer_low_sol", detail: "0.1 SOL left" }]);

    w.chain.marketSide.fail("treasuryMicros", 1);
    await w.daemon.tickReconcile();
    expect(w.alerts.recent()[0]).toMatchObject({ kind: "tick_error", detail: "reconcile: injected failure: treasuryMicros" });
  });

  it("keeps the newest 100 alerts and writes each to the log", () => {
    const w = world();
    for (let i = 1; i <= 105; i++) w.alerts.alert({ kind: "test", orderAddress: i === 105 ? "OrderX" : null, detail: `alert ${i}` });
    const recent = w.alerts.recent();
    expect(recent).toHaveLength(100);
    expect(recent[0]?.detail).toBe("alert 105");
    expect(recent[99]?.detail).toBe("alert 6");
    expect(w.logs).toHaveLength(105);
    expect(w.logs[104]).toBe("alert test OrderX alert 105");
  });
});

describe("start and stop", () => {
  it("recovers the journal, then runs the four loops on their intervals until stopped", async () => {
    const w = world();
    const gone = w.strayRow();
    const settle = vi.spyOn(w.settlement, "tick");
    const reconcile = vi.spyOn(w.reconciler, "run");
    await w.daemon.start();

    expect(w.journal.get(gone)?.state).toBe("failed"); // recover ran
    expect(w.manager.view(SYMBOL)?.tradable).toBe(true); // the markets were read before start returned
    expect(w.daemon.health().ok).toBe(true);
    expect([...w.timers.timers.values()].map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([2_000, 4_000, 5_000, 30_000]);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    const order = buyOrder();
    w.chain.addOrder(order);
    w.timers.fire(2_000);
    await vi.waitFor(() => expect(w.chain.fills).toHaveLength(1));

    const refresh = vi.spyOn(w.manager, "refresh");
    w.timers.fire(4_000);
    w.timers.fire(5_000);
    w.timers.fire(30_000);
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(2);
    });

    await w.daemon.stop();
    expect(w.timers.timers.size).toBe(0);
    w.chain.addOrder(buyOrder());
    await w.daemon.tickOrders();
    expect(w.chain.fills).toHaveLength(1); // stopped: ticks do nothing
  });

  it("starts even when recovery fails, with an alert", async () => {
    const w = world();
    w.strayRow();
    vi.spyOn(w.chain, "openOrders").mockRejectedValueOnce(new Error("rpc down"));
    await w.daemon.start();
    expect(w.alerts.recent()).toMatchObject([{ kind: "recover_error", orderAddress: null, detail: "rpc down" }]);
    expect(w.timers.timers.size).toBe(4);
    await w.daemon.stop();
  });

  it("stop waits for a tick that is running", async () => {
    const w = world();
    await w.daemon.start();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(w.chain, "openOrders").mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const tick = w.daemon.tickOrders();
    let stopped = false;
    const stopping = w.daemon.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stopping]);
    expect(stopped).toBe(true);
  });
});
