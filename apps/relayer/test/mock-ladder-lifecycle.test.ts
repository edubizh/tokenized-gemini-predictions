import { afterEach, describe, expect, it } from "vitest";
import type { ChainOrder } from "../src/chain/chain.ts";
import { createAlertLog, createDaemon } from "../src/daemon.ts";
import { openJournal } from "../src/journal.ts";
import { createMarketManager } from "../src/markets.ts";
import { feeCap } from "../src/money.ts";
import { createReconciler } from "../src/reconcile.ts";
import { openRegistry } from "../src/registry.ts";
import { createSettlementWatcher } from "../src/settlement.ts";
import { RollingMockVenue } from "../src/venue/mock-feed.ts";
import { FakeFullChain } from "./helpers/fake-full-chain.ts";

// Two strikes of the simulated gold ladder through the relayer's own loops, with a restart of the
// relayer between the fills and the expiry: the new venue is given the positions back, and each
// contract settles by itself, one YES and one NO, from the ladder's one final value.
const NOW = Date.parse("2026-11-14T23:50:00Z");
const END = Date.parse("2026-11-15T00:00:00Z");
const TICKER = "XAU2611150000";

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.close();
});

describe("a ladder of the simulated venue, across a restart of the relayer", () => {
  it("is traded on two strikes, taken over by the restarted venue and settled contract by contract", async () => {
    const clock = { ms: NOW };
    const now = () => clock.ms;
    const chain = new FakeFullChain(NOW / 1000);
    chain.marketSide.treasury = 50_000_000n;
    const journal = openJournal(":memory:");
    const registry = openRegistry(":memory:");
    closers.push(journal, registry);
    const alerts = createAlertLog({ log: () => {}, now });
    /** A relayer process over the state that outlives it: the chain, the journal and the registry. */
    const start = () => {
      const venue = new RollingMockVenue({ windowSecs: 900, resolve: "random", now });
      const manager = createMarketManager({ venue, chain, registry, now });
      const daemon = createDaemon({
        identity: { cluster: "localnet", venue: "mock", programId: "Program", relayer: "Relayer", stableMint: "StableMint" },
        venue,
        chain,
        journal,
        manager,
        settlement: createSettlementWatcher({ venue, chain, registry, journal, now, alert: alerts.alert }),
        reconciler: createReconciler({ venue, chain, registry, journal, alert: alerts.alert }),
        alerts,
        now,
        sleep: async (ms) => {
          chain.nowSecs += ms / 1000;
        },
      });
      return { venue, manager, daemon };
    };
    const at = (ms: number): void => {
      clock.ms = ms;
      chain.nowSecs = Math.floor(ms / 1000);
    };

    // The commodity ladder is quoted, so its contracts can be bought.
    const first = start();
    await first.daemon.tickMarkets();
    const ladder = first.manager.eventViews().find((event) => event.ticker === TICKER)!;
    expect(ladder).toMatchObject({ category: "Commodities", shape: "ladder", cadence: "daily" });
    expect(ladder.markets.every((market) => market.tradable)).toBe(true);
    const [low, high] = [ladder.markets[3]!, ladder.markets[4]!];
    expect([low.symbol, high.symbol]).toEqual([`MOCK-${TICKER}-HI3775`, `MOCK-${TICKER}-HI3800`]);

    let orders = 0;
    for (const [market, units] of [[low, 300n], [high, 200n]] as const) {
      await first.manager.ensureOnchain(market.symbol);
      const limitPx = BigInt(market.book!.askPx!);
      const order: ChainOrder = {
        address: `Order${orders}`,
        addressBytes: new Uint8Array(32).fill(++orders),
        user: "UserA",
        symbol: market.symbol,
        side: "YES",
        kind: "buy",
        units,
        limitPx,
        maxFeeMicros: feeCap(units, limitPx),
        expiresAt: NOW / 1000 + 90,
      };
      chain.addOrder(order);
    }
    expect(chain.marketSide.ensured.map((spec) => [spec.yes.name, spec.yes.ticker])).toEqual([
      ["XAU >=3775 15Nov26 00:00 YES", "XAUY3775D"],
      ["XAU >=3800 15Nov26 00:00 YES", "XAUY3800D"],
    ]);
    await first.daemon.tickOrders();
    expect(chain.fills.map((fill) => [fill.address, fill.fillUnits])).toEqual([["Order0", 300n], ["Order1", 200n]]);
    expect(await first.venue.positions()).toEqual(new Map([[low.symbol, 300n], [high.symbol, 200n]]));

    // The relayer stops and starts again after the ladder expired. As `main.ts` does, the new
    // venue is given each unsettled market back with the position its token supply implies.
    at(END + 6_000);
    const second = start();
    for (const market of registry.onchainUnsettled()) {
      const onchain = (await chain.market(market.symbol))!;
      second.venue.adopt(
        {
          symbol: market.symbol,
          eventTicker: market.eventTicker,
          status: "active",
          marketState: "open",
          effectiveAt: new Date(market.effectiveAt),
          expiresAt: new Date(market.expiresAt),
          tickPx: market.tickPx,
          unitIncrement: market.unitIncrement,
          minUnits: market.minUnits,
          resolutionSide: null,
          label: market.label,
          sortOrder: market.sortOrder,
          rules: market.rules,
          strike: market.strike,
        },
        onchain.yesSupply - onchain.noSupply,
        market.resolution ?? undefined,
      );
    }
    await second.daemon.tickMarkets();
    await second.daemon.tickSettlement();
    expect(registry.get(low.symbol)).toMatchObject({ settleState: "awaiting_result", venueStatus: "settled", resolution: "yes" });
    expect(registry.get(high.symbol)).toMatchObject({ settleState: "awaiting_result", venueStatus: "settled", resolution: "no" });
    // One final value for the whole ladder, between the two strikes.
    const value = Number(registry.get(low.symbol)!.settlementValue);
    expect(registry.get(high.symbol)!.settlementValue).toBe(registry.get(low.symbol)!.settlementValue);
    expect(value).toBeGreaterThanOrEqual(3_775);
    expect(value).toBeLessThan(3_800);

    at(END + 26_000);
    await second.daemon.tickSettlement();
    expect(chain.marketSide.settlements.map(({ symbol, yesPayout, noPayout }) => [symbol, yesPayout, noPayout])).toEqual([
      [low.symbol, 10_000n, 0n],
      [high.symbol, 0n, 10_000n],
    ]);
    await second.daemon.tickReconcile();
    expect(second.daemon.status()).toMatchObject({ markets: [], solvency: { requiredMicros: "0", ok: true } });
    expect(alerts.recent()).toEqual([]);
  });
});
