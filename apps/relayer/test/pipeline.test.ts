import { afterEach, describe, expect, it } from "vitest";
import type { ChainOrder } from "../src/chain/chain.ts";
import { clientOrderIdFor } from "../src/ids.ts";
import { openJournal } from "../src/journal.ts";
import type { Journal } from "../src/journal.ts";
import { DEFAULT_PIPELINE_CONFIG, processOrder, recover } from "../src/pipeline.ts";
import type { PipelineDeps } from "../src/pipeline.ts";
import { MockVenue } from "../src/venue/mock.ts";
import type { MockVenueOptions } from "../src/venue/mock.ts";
import type { VenueOrderRequest, VenueOrderResult } from "../src/venue/types.ts";
import type { ContractInfo } from "../src/venue/venue.ts";
import { FakeChain } from "./helpers/fake-chain.ts";
import type { ChainMethod } from "./helpers/fake-chain.ts";

const SYMBOL = "GEMI-BTC-TEST";
/** Cluster time at the start of every test, unix seconds. */
const T0 = 1_800_000_000;

type Alert = Parameters<PipelineDeps["alert"]>[0];

/** A venue whose connection can die right after an order went out: it executes, then throws. */
class FlakyVenue extends MockVenue {
  throwAfterExecuting = false;

  override async placeOrder(request: VenueOrderRequest): Promise<VenueOrderResult> {
    const result = await super.placeOrder(request);
    if (this.throwAfterExecuting) throw new Error("connection lost after send");
    return result;
  }
}

function contract(overrides: Partial<ContractInfo> = {}): ContractInfo {
  return {
    symbol: SYMBOL,
    eventTicker: "BTC-TEST",
    status: "active",
    marketState: "open",
    effectiveAt: new Date((T0 - 600) * 1000),
    expiresAt: new Date((T0 + 3_600) * 1000),
    tickPx: 100n,
    unitIncrement: 100n,
    minUnits: 100n,
    resolutionSide: null,
    ...overrides,
  };
}

let orderSeq = 0;
/** BUY YES 300 units at no more than 1_700, with exactly the required fee allowance. */
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
    limitPx: 1_700n,
    maxFeeMicros: 60_000n,
    expiresAt: T0 + 120,
    ...overrides,
  };
}

/** SELL YES 300 units at no less than 1_500, with exactly the required fee allowance. */
function sellOrder(overrides: Partial<ChainOrder> = {}): ChainOrder {
  return buyOrder({ kind: "sell", limitPx: 1_500n, maxFeeMicros: 90_000n, ...overrides });
}

interface World {
  venue: FlakyVenue;
  chain: FakeChain;
  journal: Journal;
  deps: PipelineDeps;
  alerts: Alert[];
  sleeps: number[];
}

const journals: Journal[] = [];
afterEach(() => {
  while (journals.length > 0) journals.pop()?.close();
});

/** Fresh dependencies over existing state, as a restarted process would build them. Sleeping
 *  moves the chain clock, so retry loops end the way they do in real time. */
function depsFor(state: Pick<World, "venue" | "chain" | "journal">): Pick<World, "deps" | "alerts" | "sleeps"> {
  const alerts: Alert[] = [];
  const sleeps: number[] = [];
  const deps: PipelineDeps = {
    venue: state.venue,
    chain: state.chain,
    journal: state.journal,
    config: DEFAULT_PIPELINE_CONFIG,
    sleep: async (ms) => {
      sleeps.push(ms);
      state.chain.nowSecs += ms / 1000;
    },
    alert: (event) => alerts.push(event),
  };
  return { deps, alerts, sleeps };
}

/** A liquid market: 1_000 units bid at 1_600 and offered at 1_700. */
function world(options: MockVenueOptions = {}): World {
  const venue = new FlakyVenue(options);
  venue.addContract(contract());
  venue.setBook(SYMBOL, { bids: [[1_600n, 1_000n]], asks: [[1_700n, 1_000n]] });
  venue.setCash(100_000_000n);
  const chain = new FakeChain(T0);
  const journal = openJournal(":memory:");
  journals.push(journal);
  const state = { venue, chain, journal };
  return { ...state, ...depsFor(state) };
}

/** Puts the order on-chain and runs it through the pipeline. */
function place(w: World, order: ChainOrder): ReturnType<typeof processOrder> {
  w.chain.addOrder(order);
  return processOrder(order, w.deps);
}

describe("processOrder", () => {
  it("fills a buy: one FOK venue order, one on-chain fill at the venue cost", async () => {
    const w = world();
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");

    expect(w.venue.requests).toEqual([
      { clientOrderId: clientOrderIdFor(order.addressBytes), symbol: SYMBOL, outcome: "YES", units: 300n, limitPx: 1_700n, timeInForce: "FOK" },
    ]);
    expect(w.chain.fills).toEqual([
      { address: order.address, kind: "buy", fillUnits: 300n, amountMicros: 510_000n, feeMicros: 0n, signature: "sig-1" },
    ]);
    expect(w.chain.cancels).toEqual([]);
    expect(w.journal.get(order.address)).toMatchObject({
      state: "chain_filled",
      user: "UserA",
      filledUnits: 300n,
      amountMicros: 510_000n,
      chainSignature: "sig-1",
    });
    expect(w.journal.byUser("UserA", 5).map((row) => row.orderAddress)).toEqual([order.address]);
    expect(w.alerts).toEqual([]);
  });

  it("fills a sell by buying the opposite outcome and pays the proceeds", async () => {
    const w = world();
    const order = sellOrder();
    expect(await place(w, order)).toBe("chain_filled");

    // SELL YES at no less than 1_500 is BUY NO at no more than 8_500; the 1_600 bid fills it at 8_400.
    expect(w.venue.requests).toMatchObject([{ outcome: "NO", units: 300n, limitPx: 8_500n, timeInForce: "FOK" }]);
    expect(w.chain.fills).toMatchObject([
      { address: order.address, kind: "sell", fillUnits: 300n, amountMicros: 300n * 1_600n, feeMicros: 0n },
    ]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_filled", amountMicros: 480_000n });
  });

  it("cancels on-chain when the venue does not fill", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [[1_600n, 1_000n]], asks: [[1_800n, 1_000n]] });
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_cancelled");

    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.chain.fills).toEqual([]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_cancelled", chainSignature: "sig-1" });
  });

  it("cancels on-chain when the venue rejects the order", async () => {
    const w = world();
    const order = buyOrder({ units: 250n, maxFeeMicros: 200_000n }); // off the 100-unit grid
    expect(await place(w, order)).toBe("chain_cancelled");
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.journal.get(order.address)?.detail).toBe("rejected: invalid quantity: 250");
  });

  it("clamps a buy fee above the cap and alerts", async () => {
    const w = world({ feeFor: () => 100_000n });
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(w.chain.fills).toMatchObject([{ fillUnits: 300n, amountMicros: 510_000n, feeMicros: 60_000n }]);
    expect(w.journal.get(order.address)?.feeMicros).toBe(100_000n);
    expect(w.alerts).toMatchObject([{ kind: "fee_absorbed", orderAddress: order.address }]);
  });

  it("clamps a sell fee above the cap and alerts", async () => {
    const w = world({ feeFor: () => 100_000n });
    const order = sellOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(w.chain.fills).toMatchObject([{ kind: "sell", amountMicros: 480_000n, feeMicros: 90_000n }]);
    expect(w.alerts).toMatchObject([{ kind: "fee_absorbed", orderAddress: order.address }]);
  });

  it("passes a fee within the cap through without alerting", async () => {
    const w = world({ feeFor: () => 30_000n });
    expect(await place(w, buyOrder())).toBe("chain_filled");
    expect(w.chain.fills).toMatchObject([{ feeMicros: 30_000n }]);
    expect(w.alerts).toEqual([]);
  });

  it("never creates a second venue order when called twice for the same order", async () => {
    const w = world();
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(await processOrder(order, w.deps)).toBe("chain_filled");
    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.fills).toHaveLength(1);
    expect(w.chain.calls.fillBuy).toBe(1);
  });
});

describe("pre-trade guards", () => {
  const cases: Array<[name: string, detail: string, order: () => ChainOrder, arrange?: (w: World) => void]> = [
    ["too little time before the deadline", "expiry_window", () => buyOrder({ expiresAt: T0 + 24 })],
    ["an unknown contract", "contract_missing", () => buyOrder({ symbol: "GEMI-NOPE" })],
    ["a market that is not open", "not_tradable:market_not_open", () => buyOrder(), (w) => w.venue.addContract(contract({ marketState: "closed" }))],
    [
      "a contract past its order cutoff",
      "not_tradable:too_close_to_expiry",
      () => buyOrder(),
      (w) => w.venue.addContract(contract({ expiresAt: new Date((T0 + 100) * 1000) })),
    ],
    ["no asks for a buy of YES", "book_side_empty", () => buyOrder(), (w) => w.venue.setBook(SYMBOL, { bids: [[1_600n, 1_000n]], asks: [] })],
    ["no bids for a sell of YES", "book_side_empty", () => sellOrder(), (w) => w.venue.setBook(SYMBOL, { bids: [], asks: [[1_700n, 1_000n]] })],
    ["a buy fee allowance below the cap", "fee_cap", () => buyOrder({ maxFeeMicros: 59_999n })],
    ["a sell fee allowance below the cap", "fee_cap", () => sellOrder({ maxFeeMicros: 89_999n })],
    ["a sell whose minimum proceeds do not exceed its fee allowance", "min_proceeds", () => sellOrder({ limitPx: 300n, maxFeeMicros: 90_000n })],
    ["a px of zero", "bad_order_values", () => buyOrder({ limitPx: 0n })],
    ["a px above the range", "bad_order_values", () => sellOrder({ limitPx: 10_000n })],
    ["negative units", "bad_order_values", () => buyOrder({ units: -100n })],
    ["zero units", "bad_order_values", () => buyOrder({ units: 0n })],
  ];

  it.each(cases)("cancels %s without touching the venue (%s)", async (_name, detail, makeOrder, arrange) => {
    const w = world();
    arrange?.(w);
    const order = makeOrder();
    expect(await place(w, order)).toBe("chain_cancelled");
    expect(w.venue.requests).toEqual([]);
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_cancelled", detail, chainSignature: "sig-1" });
  });

  it("cancels without touching the venue when slow venue reads use up the window (expiry_window)", async () => {
    const w = world();
    const topOfBook = w.venue.topOfBook.bind(w.venue);
    w.venue.topOfBook = async (symbol) => {
      w.chain.nowSecs += 100; // the read waited behind other requests
      return topOfBook(symbol);
    };
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_cancelled");
    expect(w.venue.requests).toEqual([]);
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_cancelled", detail: "expiry_window" });
  });

  it("accepts an order with exactly the minimum window and exactly the required allowances", async () => {
    const w = world();
    expect(await place(w, buyOrder({ expiresAt: T0 + 25 }))).toBe("chain_filled");
    expect(await place(w, sellOrder({ expiresAt: T0 + 25 }))).toBe("chain_filled");
  });
});

describe("unknown venue outcome", () => {
  it("recovers by lookup when placeOrder throws after the order executed", async () => {
    const w = world();
    w.venue.throwAfterExecuting = true;
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");

    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.calls.fillBuy).toBe(1);
    // The lookup knows the average price (1_700) but not the fee, which comes from the formula.
    expect(w.chain.fills).toMatchObject([{ address: order.address, fillUnits: 300n, amountMicros: 510_000n, feeMicros: 30_000n }]);
    const row = w.journal.get(order.address);
    expect(row).toMatchObject({ state: "chain_filled", filledUnits: 300n, amountMicros: 510_000n });
    expect(w.journal.fills(order.address)).toEqual([
      { tradeId: `lookup:${row?.venueOrderId}`, units: 300n, px: 1_700n, feeMicros: 30_000n, feeSource: "computed" },
    ]);
    expect(w.alerts).toMatchObject([{ kind: "recovered_by_lookup", orderAddress: order.address }]);
  });

  it("charges a recovered buy at its limit when the average price is not a whole px", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [], asks: [[1_600n, 100n], [1_700n, 200n]] });
    w.venue.failNext("unknown_after_fill");
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(w.chain.fills).toMatchObject([{ fillUnits: 300n, amountMicros: 300n * 1_700n }]);
  });

  it("pays a recovered sell its minimum when the average price is not a whole px", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [[1_700n, 100n], [1_600n, 200n]], asks: [] });
    w.venue.failNext("unknown_after_fill");
    const order = sellOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(w.chain.fills).toMatchObject([{ kind: "sell", fillUnits: 300n, amountMicros: 300n * 1_500n }]);
  });

  it.each(["unknown_no_fill", "throw"] as const)("cancels after every lookup misses (%s)", async (mode) => {
    const w = world();
    w.venue.failNext(mode);
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_cancelled");

    expect(w.venue.requests).toHaveLength(1);
    expect(w.sleeps).toEqual([1_500, 1_500, 1_500]); // four lookups
    expect(w.chain.cancels).toEqual([order.address]);
    expect(w.chain.fills).toEqual([]);
    expect(w.journal.get(order.address)?.state).toBe("chain_cancelled");
  });

  it("cancels when the lookup finds the order closed without a fill", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [], asks: [[1_800n, 1_000n]] });
    w.venue.failNext("unknown_after_fill");
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_cancelled");
    expect(w.sleeps).toEqual([]); // the first lookup settled it
    expect(w.chain.cancels).toEqual([order.address]);
  });

  it("leaves an order that is still open at the venue alone, and settles it on a later recover", async () => {
    const w = world();
    const order = buyOrder();
    w.venue.failNext("unknown_after_fill");
    w.venue.holdOpen(clientOrderIdFor(order.addressBytes));
    expect(await place(w, order)).toBe("left_unknown");

    expect(w.sleeps).toEqual([1_500, 1_500, 1_500]);
    expect(w.chain.calls).toEqual({ fillBuy: 0, fillSell: 0, cancel: 0 });
    expect(w.journal.get(order.address)?.state).toBe("venue_unknown");
    expect(w.alerts).toMatchObject([{ kind: "venue_unknown", orderAddress: order.address }]);

    w.venue.holdOpen(clientOrderIdFor(order.addressBytes), false);
    const restarted = depsFor(w);
    await recover(restarted.deps);
    expect(w.journal.get(order.address)?.state).toBe("chain_filled");
    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.fills).toMatchObject([{ address: order.address, fillUnits: 300n, amountMicros: 510_000n }]);
    expect(restarted.alerts).toMatchObject([{ kind: "recovered_by_lookup" }]);
  });
});

describe("on-chain failures", () => {
  it("retries a failed fill until it lands", async () => {
    const w = world();
    w.chain.fail("fillBuy", 2);
    const order = buyOrder();
    expect(await place(w, order)).toBe("chain_filled");
    expect(w.chain.calls.fillBuy).toBe(3);
    expect(w.sleeps).toEqual([1_000, 1_000]);
    expect(w.chain.fills).toHaveLength(1);
    expect(w.venue.requests).toHaveLength(1);
  });

  it("orphans a fill that cannot land before the deadline and counts it as house inventory", async () => {
    const w = world();
    w.chain.fail("fillBuy");
    const order = buyOrder({ expiresAt: T0 + 30 });
    expect(await place(w, order)).toBe("orphaned");

    // Retried every second while at least chainSafetySecs (3) remained.
    expect(w.chain.calls.fillBuy).toBe(29);
    expect(w.chain.nowSecs).toBe(T0 + 28);
    expect(w.chain.fills).toEqual([]);
    expect(w.journal.get(order.address)?.state).toBe("orphaned");
    expect(w.journal.houseInventoryUnits(SYMBOL)).toBe(300n);
    expect((await w.venue.positions()).get(SYMBOL)).toBe(300n);
    expect(w.alerts).toMatchObject([{ kind: "orphaned_fill", orderAddress: order.address }]);
  });

  it("orphans a filled sell whose order account is gone", async () => {
    const w = world();
    const order = sellOrder();
    // The account disappears while the venue order is out.
    const placeOrder = w.venue.placeOrder.bind(w.venue);
    w.venue.placeOrder = async (request) => {
      const result = await placeOrder(request);
      w.chain.removeOrder(order.address);
      return result;
    };
    expect(await place(w, order)).toBe("orphaned");
    expect(w.chain.calls.fillSell).toBe(1);
    expect(w.sleeps).toEqual([]);
    // The venue bought NO against tokens that still exist.
    expect(w.journal.houseInventoryUnits(SYMBOL)).toBe(-300n);
    expect(w.alerts).toMatchObject([{ kind: "orphaned_fill", orderAddress: order.address }]);
  });

  it("treats a failed cancel as cancelled when the order account is gone", async () => {
    const w = world();
    const order = buyOrder({ maxFeeMicros: 0n }); // fails the fee guard
    w.chain.fail("cancel");
    // Never put on-chain: somebody else already refunded it.
    expect(await processOrder(order, w.deps)).toBe("chain_cancelled");
    expect(w.chain.calls.cancel).toBe(1);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_cancelled", detail: "fee_cap", chainSignature: null });
    expect(w.alerts).toEqual([]);
  });

  it("marks a cancel that cannot land before the deadline as failed, without alerting", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [], asks: [[1_800n, 1_000n]] });
    w.chain.fail("cancel");
    const order = buyOrder({ expiresAt: T0 + 30 });
    expect(await place(w, order)).toBe("failed");
    expect(w.chain.calls.cancel).toBe(29);
    expect(w.chain.cancels).toEqual([]);
    expect(w.journal.get(order.address)?.state).toBe("failed");
    expect(w.alerts).toEqual([]);
  });
});

describe("recover", () => {
  it("finishes an order after a crash between the venue fill and the on-chain fill", async () => {
    const w = world();
    const order = buyOrder();
    w.chain.fail("fillBuy");
    const dying: PipelineDeps = {
      ...w.deps,
      sleep: async () => {
        throw new Error("process killed");
      },
    };
    w.chain.addOrder(order);
    await expect(processOrder(order, dying)).rejects.toThrow("process killed");
    expect(w.journal.get(order.address)?.state).toBe("venue_filled");
    expect(w.chain.calls.fillBuy).toBe(1);
    expect(w.chain.fills).toEqual([]);

    // Restart: fresh dependencies over the same journal and venue, and the chain works again.
    w.chain.fail("fillBuy", 0);
    const restarted = depsFor(w);
    await recover(restarted.deps);
    expect(w.journal.get(order.address)).toMatchObject({ state: "chain_filled", chainSignature: "sig-1" });
    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.fills).toMatchObject([{ address: order.address, fillUnits: 300n, amountMicros: 510_000n, feeMicros: 0n }]);

    await recover(depsFor(w).deps);
    expect(w.venue.requests).toHaveLength(1);
    expect(w.chain.fills).toHaveLength(1);
    expect(restarted.alerts).toEqual([]);
  });

  it("orphans a venue-filled order whose account is gone at restart", async () => {
    const w = world();
    const order = buyOrder({ side: "NO", limitPx: 8_400n, maxFeeMicros: 200_000n });
    w.chain.fail("fillBuy");
    w.chain.addOrder(order);
    await expect(
      processOrder(order, {
        ...w.deps,
        sleep: async () => {
          throw new Error("process killed");
        },
      }),
    ).rejects.toThrow("process killed");
    w.chain.removeOrder(order.address);

    const restarted = depsFor(w);
    await recover(restarted.deps);
    expect(w.journal.get(order.address)?.state).toBe("orphaned");
    expect(w.journal.houseInventoryUnits(SYMBOL)).toBe(-300n);
    expect(w.chain.calls.fillBuy).toBe(1);
    expect(restarted.alerts).toMatchObject([{ kind: "orphaned_fill", orderAddress: order.address }]);
  });

  it("runs the normal flow for a row that was only seen, and fails it when the order is gone", async () => {
    const w = world();
    const live = buyOrder();
    const gone = buyOrder();
    for (const order of [live, gone]) {
      w.journal.recordSeen({
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
    }
    w.chain.addOrder(live);

    await recover(w.deps);
    expect(w.journal.get(live.address)?.state).toBe("chain_filled");
    expect(w.journal.get(gone.address)?.state).toBe("failed");
    expect(w.venue.requests.map((request) => request.clientOrderId)).toEqual([clientOrderIdFor(live.addressBytes)]);
    expect(w.chain.fills.map((fill) => fill.address)).toEqual([live.address]);
    expect(w.journal.unresolved()).toEqual([]);
  });

  it("looks up a row stuck in submitting and cancels when the venue never saw it", async () => {
    const w = world();
    const order = buyOrder();
    w.chain.addOrder(order);
    w.venue.failNext("throw");
    // Dies while waiting between lookups, leaving the row in venue_unknown; a second order dies
    // even earlier, between markSubmitting and the venue answer.
    await expect(
      processOrder(order, {
        ...w.deps,
        sleep: async () => {
          throw new Error("process killed");
        },
      }),
    ).rejects.toThrow("process killed");
    expect(w.journal.get(order.address)?.state).toBe("venue_unknown");

    const stuck = buyOrder();
    w.chain.addOrder(stuck);
    w.journal.recordSeen({
      orderAddress: stuck.address,
      clientOrderId: clientOrderIdFor(stuck.addressBytes),
      user: stuck.user,
      kind: stuck.kind,
      side: stuck.side,
      symbol: stuck.symbol,
      units: stuck.units,
      limitPx: stuck.limitPx,
      maxFeeMicros: stuck.maxFeeMicros,
      expiresAt: stuck.expiresAt,
    });
    w.journal.markSubmitting(stuck.address);

    await recover(depsFor(w).deps);
    expect(w.journal.get(order.address)?.state).toBe("chain_cancelled");
    expect(w.journal.get(stuck.address)?.state).toBe("chain_cancelled");
    expect(w.venue.requests).toHaveLength(1); // only the first order ever went out, once
    expect(w.chain.cancels).toEqual([order.address, stuck.address]);
    expect(w.chain.fills).toEqual([]);
  });

  it("cancels a venue_not_filled row whose cancel never went out", async () => {
    const w = world();
    w.venue.setBook(SYMBOL, { bids: [], asks: [[1_800n, 1_000n]] });
    const order = buyOrder();
    const gone = buyOrder();
    w.chain.fail("cancel");
    const dying: PipelineDeps = {
      ...w.deps,
      sleep: async () => {
        throw new Error("process killed");
      },
    };
    for (const o of [order, gone]) {
      w.chain.addOrder(o);
      await expect(processOrder(o, dying)).rejects.toThrow("process killed");
      expect(w.journal.get(o.address)?.state).toBe("venue_not_filled");
    }
    w.chain.removeOrder(gone.address);
    w.chain.fail("cancel", 0);

    await recover(depsFor(w).deps);
    expect(w.journal.get(order.address)?.state).toBe("chain_cancelled");
    expect(w.journal.get(gone.address)?.state).toBe("chain_cancelled");
    expect(w.chain.cancels).toEqual([order.address]);
  });
});

describe("invariants under random faults", () => {
  /** Small deterministic generator (mulberry32) so a failing round can be replayed. */
  function generator(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  it("never mints more than the venue filled and never sends two venue orders for one address", async () => {
    const random = generator(20_261_114);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const chance = (p: number): boolean => random() < p;
    const methods: ChainMethod[] = ["fillBuy", "fillSell", "cancel"];
    const shapes: Array<Partial<ChainOrder>> = [
      { kind: "buy", side: "YES", limitPx: 1_700n },
      { kind: "buy", side: "NO", limitPx: 8_400n },
      { kind: "sell", side: "YES", limitPx: 1_500n },
      { kind: "sell", side: "NO", limitPx: 8_200n },
    ];
    const seenOutcomes = new Set<string>();

    for (let round = 0; round < 300; round++) {
      const w = world({ feeFor: () => pick([0n, 30_000n, 500_000n]) });
      if (chance(0.3)) w.venue.setBook(SYMBOL, { bids: [[100n, 1_000n]], asks: [[9_900n, 1_000n]] }); // nothing within any limit
      const order = buyOrder({ ...pick(shapes), maxFeeMicros: 200_000n, expiresAt: T0 + pick([30, 60, 120]) });
      const clientOrderId = clientOrderIdFor(order.addressBytes);
      w.chain.addOrder(order);

      const venueFault = pick(["none", "none", "unknown_after_fill", "unknown_no_fill", "throw", "throw_after_fill"] as const);
      if (venueFault === "throw_after_fill") w.venue.throwAfterExecuting = true;
      else if (venueFault !== "none") w.venue.failNext(venueFault);
      if (chance(0.2)) w.venue.holdOpen(clientOrderId);
      for (const method of methods) w.chain.fail(method, pick([0, 0, 0, 1, 2, Number.POSITIVE_INFINITY]));

      // The process may die at any wait, and the order account may vanish during one.
      const dieAtSleep = chance(0.35) ? pick([1, 2, 3]) : 0;
      const vanishAtSleep = chance(0.15) ? pick([1, 2, 4]) : 0;
      let sleepCount = 0;
      const faulty: PipelineDeps = {
        ...w.deps,
        sleep: async (ms) => {
          sleepCount += 1;
          if (sleepCount === vanishAtSleep) w.chain.removeOrder(order.address);
          if (sleepCount === dieAtSleep) throw new Error("process killed");
          w.chain.nowSecs += ms / 1000;
        },
      };

      try {
        await processOrder(order, faulty);
        if (chance(0.3)) await processOrder(order, faulty);
      } catch (error) {
        expect((error as Error).message).toBe("process killed");
      }
      // Restarts: one with faults still possible, then one with everything healthy.
      for (const method of methods) w.chain.fail(method, pick([0, 0, 1, Number.POSITIVE_INFINITY]));
      await recover(depsFor(w).deps);
      for (const method of methods) w.chain.fail(method, 0);
      w.venue.holdOpen(clientOrderId, false);
      const last = depsFor(w);
      await recover(last.deps);

      const lookup = await w.venue.findOrder(clientOrderId, SYMBOL, 0);
      const venueFilled = lookup.found ? lookup.filledUnits : 0n;
      const context = `round ${round}`;
      expect(w.venue.requests.filter((request) => request.clientOrderId === clientOrderId).length, context).toBeLessThanOrEqual(1);
      expect(w.venue.requests.length, context).toBeLessThanOrEqual(1);
      expect(w.chain.filledUnits(order.address), context).toBeLessThanOrEqual(venueFilled);
      expect(w.chain.fills.length, context).toBeLessThanOrEqual(1);

      // With the faults gone every row is resolved, and the journal agrees with chain and venue.
      expect(last.alerts.filter((alert) => alert.kind === "recover_error"), context).toEqual([]);
      expect(w.journal.unresolved(), context).toEqual([]);
      const row = w.journal.get(order.address);
      expect(row?.state === "chain_filled", context).toBe(w.chain.fills.length === 1);
      if (row?.state === "orphaned") expect(venueFilled, context).toBe(300n);
      if (venueFilled > 0n) expect(["chain_filled", "orphaned"], context).toContain(row?.state);
      seenOutcomes.add(row?.state ?? "missing");
    }
    // The loop is only meaningful if it reached every terminal state.
    expect([...seenOutcomes].sort()).toEqual(["chain_cancelled", "chain_filled", "failed", "orphaned"]);
  });
});
