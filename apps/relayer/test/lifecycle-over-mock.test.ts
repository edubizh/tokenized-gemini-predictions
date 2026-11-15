import { afterEach, describe, expect, it } from "vitest";
import type { ChainOrder } from "../src/chain/chain.ts";
import { createAlertLog, createDaemon } from "../src/daemon.ts";
import { openJournal } from "../src/journal.ts";
import { createMarketManager } from "../src/markets.ts";
import { feeCap, takerFee } from "../src/money.ts";
import { createReconciler } from "../src/reconcile.ts";
import { openRegistry } from "../src/registry.ts";
import { createSettlementWatcher } from "../src/settlement.ts";
import { RollingMockVenue } from "../src/venue/mock-feed.ts";
import { FakeFullChain } from "./helpers/fake-full-chain.ts";

// One contract of the simulated venue from its first listing to its settlement, through the
// relayer's own loops: no curated list, the market is picked from the events the venue lists.
const NOW = Date.parse("2026-11-14T02:50:00Z");
const END = Date.parse("2026-11-14T03:00:00Z");

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

function relayer() {
  const clock = { ms: NOW };
  const now = () => clock.ms;
  const venue = new RollingMockVenue({ windowSecs: 900, resolve: "yes", now, random: () => 0.5 });
  const chain = new FakeFullChain(NOW / 1000);
  chain.marketSide.treasury = 50_000_000n;
  const journal = openJournal(":memory:");
  const registry = openRegistry(":memory:");
  closers.push(journal, registry);
  const alerts = createAlertLog({ log: () => {}, now });
  const manager = createMarketManager({ venue, chain, registry, now });
  const settlement = createSettlementWatcher({ venue, chain, registry, journal, now, alert: alerts.alert });
  const reconciler = createReconciler({ venue, chain, registry, journal, alert: alerts.alert });
  const daemon = createDaemon({
    identity: { cluster: "localnet", venue: "mock", programId: "Program", relayer: "Relayer", stableMint: "StableMint" },
    venue,
    chain,
    journal,
    manager,
    settlement,
    reconciler,
    alerts,
    now,
    sleep: async (ms) => {
      chain.nowSecs += ms / 1000;
    },
  });
  /** Moves the wall clock and the cluster clock together. */
  const at = (ms: number): void => {
    clock.ms = ms;
    chain.nowSecs = Math.floor(ms / 1000);
  };
  return { venue, chain, journal, registry, alerts, manager, daemon, at };
}

describe("a contract of the simulated venue, from listing to settlement", () => {
  it("is discovered, created on request, traded, reconciled and settled when the venue resolves it", async () => {
    const w = relayer();

    // Discovery: every event the venue lists, the soonest first.
    await w.daemon.tickMarkets();
    const [event] = w.manager.eventViews();
    expect(event).toMatchObject({ ticker: "BTC15M2611140300", shape: "binary", cadence: "15m" });
    const picked = event!.markets[0]!;
    expect(picked).toMatchObject({ tradable: true, onchain: null, book: { askPx: "5200" } });
    const { symbol } = picked;

    // Creation on request, with the names of the naming scheme.
    const created = await w.manager.ensureOnchain(symbol);
    expect(created.onchain).toMatchObject({ status: "open", closeTs: END / 1000, placeCutoffSecs: 150 });
    expect(w.chain.marketSide.ensured[0]).toMatchObject({ yes: { name: "BTC Up 15m 14Nov26 03:00 YES", ticker: "BTCY0300Q" }, no: { ticker: "BTCN0300Q" } });

    // An order at the ask fills at the venue and on-chain.
    const order: ChainOrder = {
      address: "OrderA",
      addressBytes: new Uint8Array(32).fill(7),
      user: "UserA",
      symbol,
      side: "YES",
      kind: "buy",
      units: 300n,
      limitPx: 5_200n,
      maxFeeMicros: feeCap(300n, 5_200n),
      expiresAt: NOW / 1000 + 90,
    };
    w.chain.addOrder(order);
    await w.daemon.tickOrders();
    expect(w.chain.fills).toMatchObject([{ address: "OrderA", kind: "buy", fillUnits: 300n, amountMicros: 1_560_000n, feeMicros: takerFee(300n, 5_200n) }]);
    expect(w.journal.get("OrderA")).toMatchObject({ state: "chain_filled", filledUnits: 300n });

    // The next list read carries the trade: the last price and the event's volume.
    w.at(NOW + 20_000);
    await w.daemon.tickMarkets();
    expect(w.manager.view(symbol)).toMatchObject({ lastPx: "5200", onchain: { yesSupply: "300" } });
    expect(w.manager.eventView(event!.ticker)?.volumeUnits).toBe("300");

    // The venue's position equals the supply.
    await w.daemon.tickReconcile();
    expect(w.daemon.status()).toMatchObject({
      markets: [{ symbol, yesSupply: "300", noSupply: "0", venueNet: "300", inFlight: "0", houseInventory: "0", balanced: true }],
      solvency: { requiredMicros: "3000000", ok: true },
    });

    // Expiry: the contract leaves the event list; the watcher waits for the resolution to hold.
    w.at(END + 6_000);
    await w.daemon.tickMarkets();
    expect(w.manager.eventViews().map((listed) => listed.ticker)).not.toContain(event!.ticker);
    await w.daemon.tickSettlement();
    expect(w.registry.get(symbol)).toMatchObject({ settleState: "awaiting_result", venueStatus: "settled", resolution: "yes" });
    expect(w.chain.marketSide.settlements).toEqual([]);

    w.at(END + 26_000);
    await w.daemon.tickSettlement();
    expect(w.chain.marketSide.settlements).toMatchObject([{ symbol, yesPayout: 10_000n, noPayout: 0n }]);

    // The views carry the result; nothing is left to reconcile; no alert was raised on the way.
    await w.daemon.tickMarkets();
    expect(w.manager.views()).toHaveLength(1);
    expect(w.manager.view(symbol)).toMatchObject({
      venueStatus: "settled",
      resolution: "yes",
      settleState: "settled",
      tradable: false,
      notTradableReason: "not_active",
      lastPx: "5200",
      onchain: { status: "settled", yesSupply: "300", yesPayout: "10000", noPayout: "0", redeemAfter: END / 1000 + 30 },
    });
    expect(w.manager.view(symbol)?.settlementValue).toMatch(/^\d+\.\d{2}$/);
    expect(w.manager.eventView(event!.ticker)).toMatchObject({ volumeUnits: "300", markets: [{ symbol, settleState: "settled" }] });
    await w.daemon.tickReconcile();
    expect(w.daemon.status()).toMatchObject({ markets: [], solvency: { requiredMicros: "0", ok: true } });
    expect(w.alerts.recent()).toEqual([]);
  });
});
