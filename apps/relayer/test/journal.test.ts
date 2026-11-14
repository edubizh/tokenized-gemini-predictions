import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../src/journal.ts";
import type { Journal, NewOrder, OrderState } from "../src/journal.ts";
import type { VenueFill, VenueOrderResult } from "../src/venue/types.ts";

const open: Journal[] = [];
function memory(): Journal {
  const journal = openJournal(":memory:");
  open.push(journal);
  return journal;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function order(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    orderAddress: "OrderA",
    clientOrderId: "client-a",
    user: "UserA",
    kind: "buy",
    side: "YES",
    symbol: "GEMI-BTC-TEST",
    units: 300n,
    limitPx: 1_700n,
    maxFeeMicros: 60_000n,
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

function fill(tradeId: string, units: bigint, px: bigint, feeMicros = 0n): VenueFill {
  return { tradeId, units, px, feeMicros, feeSource: "reported" };
}

function filled(fills: VenueFill[], venueOrderId = "73797746498585286"): VenueOrderResult {
  return {
    kind: "filled",
    venueOrderId,
    fills,
    filledUnits: fills.reduce((sum, f) => sum + f.units, 0n),
    costMicros: fills.reduce((sum, f) => sum + f.units * f.px, 0n),
    feeMicros: fills.reduce((sum, f) => sum + f.feeMicros, 0n),
  };
}

/** Drives a fresh order to `state` through allowed transitions only. */
function reach(journal: Journal, state: OrderState, o: NewOrder = order()): void {
  journal.recordSeen(o);
  if (state === "seen") return;
  if (state === "chain_cancelled" || state === "failed") {
    journal.markChain(o.orderAddress, state);
    return;
  }
  journal.markSubmitting(o.orderAddress);
  if (state === "submitting") return;
  if (state === "venue_unknown") {
    journal.recordVenueResult(o.orderAddress, { kind: "unknown", venueOrderId: null, reason: "timeout" });
    return;
  }
  if (state === "venue_not_filled") {
    journal.recordVenueResult(o.orderAddress, { kind: "not_filled", venueOrderId: null, reason: "fok" });
    return;
  }
  journal.recordVenueResult(o.orderAddress, filled([fill(`t-${o.orderAddress}`, o.units, o.limitPx)]));
  if (state === "venue_filled") return;
  journal.markChain(o.orderAddress, state);
}

describe("recordSeen", () => {
  it("creates a row in state seen with zeroed results", () => {
    const journal = memory();
    const { created, row } = journal.recordSeen(order());
    expect(created).toBe(true);
    expect(row).toMatchObject({
      ...order(),
      state: "seen",
      venueOrderId: null,
      filledUnits: 0n,
      amountMicros: 0n,
      feeMicros: 0n,
      chainSignature: null,
      detail: null,
    });
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBe(row.createdAt);
    expect(journal.get("OrderA")).toEqual(row);
    expect(journal.get("missing")).toBeUndefined();
  });

  it("is idempotent on the order address and keeps the existing state", () => {
    const journal = memory();
    journal.recordSeen(order());
    journal.markSubmitting("OrderA");
    const again = journal.recordSeen(order());
    expect(again.created).toBe(false);
    expect(again.row.state).toBe("submitting");
    expect(journal.byState("submitting")).toHaveLength(1);
  });

  it("throws when a known address arrives with a different client order id", () => {
    const journal = memory();
    journal.recordSeen(order());
    expect(() => journal.recordSeen(order({ clientOrderId: "client-b" }))).toThrow(/client order id/);
  });
});

describe("recordVenueResult", () => {
  it("stores a filled buy: fills, venue id, units, fee and cost", () => {
    const journal = memory();
    journal.recordSeen(order());
    journal.markSubmitting("OrderA");
    const fills = [fill("5000000000000001", 100n, 1_600n, 10_000n), fill("5000000000000002", 200n, 1_700n, 20_000n)];
    journal.recordVenueResult("OrderA", filled(fills));
    expect(journal.get("OrderA")).toMatchObject({
      state: "venue_filled",
      venueOrderId: "73797746498585286",
      filledUnits: 300n,
      amountMicros: 100n * 1_600n + 200n * 1_700n,
      feeMicros: 30_000n,
    });
    expect(journal.fills("OrderA")).toEqual(fills);
    expect(journal.fills("missing")).toEqual([]);
  });

  it("stores the proceeds of a filled sell", () => {
    const journal = memory();
    // Sell YES at no less than 300: the venue order is BUY NO, filled here at NO px 9_600.
    journal.recordSeen(order({ kind: "sell", limitPx: 300n }));
    journal.markSubmitting("OrderA");
    journal.recordVenueResult("OrderA", filled([fill("5000000000000003", 300n, 9_600n)]));
    expect(journal.get("OrderA")?.amountMicros).toBe(300n * 400n);
  });

  it("maps not_filled and rejected to venue_not_filled with the reason", () => {
    const journal = memory();
    reach(journal, "submitting");
    journal.recordVenueResult("OrderA", { kind: "not_filled", venueOrderId: "73797746498585287", reason: "fok_killed" });
    expect(journal.get("OrderA")).toMatchObject({
      state: "venue_not_filled",
      venueOrderId: "73797746498585287",
      detail: "fok_killed",
    });

    reach(journal, "submitting", order({ orderAddress: "OrderB", clientOrderId: "client-b" }));
    journal.recordVenueResult("OrderB", { kind: "rejected", code: 400, message: "InsufficientFunds" });
    const rejected = journal.get("OrderB");
    expect(rejected?.state).toBe("venue_not_filled");
    expect(rejected?.detail).toContain("InsufficientFunds");
    expect(rejected?.detail).toContain("400");
  });

  it("maps unknown to venue_unknown, which can be resolved later", () => {
    const journal = memory();
    reach(journal, "venue_unknown");
    expect(journal.get("OrderA")).toMatchObject({ state: "venue_unknown", detail: "timeout" });
    journal.recordVenueResult("OrderA", { kind: "unknown", venueOrderId: null, reason: "still open" });
    expect(journal.get("OrderA")).toMatchObject({ state: "venue_unknown", detail: "still open" });
    journal.recordVenueResult("OrderA", filled([fill("lookup:1", 300n, 1_700n)]));
    expect(journal.get("OrderA")?.state).toBe("venue_filled");
  });

  it("throws when a trade id is already stored for another order and stores nothing", () => {
    const journal = memory();
    reach(journal, "venue_filled");
    reach(journal, "submitting", order({ orderAddress: "OrderB", clientOrderId: "client-b" }));
    expect(() => journal.recordVenueResult("OrderB", filled([fill("fresh", 100n, 1_700n), fill("t-OrderA", 200n, 1_700n)]))).toThrow(
      /trade id t-OrderA/,
    );
    expect(journal.get("OrderB")?.state).toBe("submitting");
    expect(journal.fills("OrderB")).toEqual([]);
  });

  it("throws for an unknown order address", () => {
    const journal = memory();
    expect(() => journal.markSubmitting("missing")).toThrow(/unknown order missing/);
  });
});

describe("transitions", () => {
  const chainOutcomes = ["chain_filled", "chain_cancelled", "orphaned", "failed"] as const;
  const allowedChain: Record<string, readonly string[]> = {
    seen: ["chain_cancelled", "failed"],
    submitting: [],
    venue_filled: ["chain_filled", "orphaned", "failed"],
    venue_not_filled: ["chain_cancelled", "failed"],
    venue_unknown: ["orphaned", "failed"],
    chain_filled: [],
    chain_cancelled: [],
    orphaned: [],
    failed: [],
  };

  for (const [from, allowed] of Object.entries(allowedChain)) {
    for (const to of chainOutcomes) {
      const ok = allowed.includes(to);
      it(`${from} -> ${to} ${ok ? "is allowed" : "throws"}`, () => {
        const journal = memory();
        reach(journal, from as OrderState);
        if (ok) {
          journal.markChain("OrderA", to, { signature: "sig1", detail: "why" });
          expect(journal.get("OrderA")).toMatchObject({ state: to, chainSignature: "sig1", detail: "why" });
        } else {
          expect(() => journal.markChain("OrderA", to)).toThrow(new RegExp(`${from} -> ${to}`));
          expect(journal.get("OrderA")?.state).toBe(from);
        }
      });
    }
  }

  it("markSubmitting is only allowed from seen", () => {
    for (const from of ["submitting", "venue_filled", "venue_not_filled", "venue_unknown", "chain_filled", "failed"] as const) {
      const journal = memory();
      reach(journal, from);
      expect(() => journal.markSubmitting("OrderA")).toThrow(new RegExp(`${from} -> submitting`));
    }
  });

  it("recordVenueResult is only allowed from submitting or venue_unknown", () => {
    const result: VenueOrderResult = { kind: "not_filled", venueOrderId: null, reason: "fok" };
    for (const from of ["seen", "venue_filled", "venue_not_filled", "chain_cancelled", "orphaned"] as const) {
      const journal = memory();
      reach(journal, from);
      expect(() => journal.recordVenueResult("OrderA", result)).toThrow(new RegExp(`${from} -> venue_not_filled`));
      expect(journal.get("OrderA")?.state).toBe(from);
    }
  });

  it("markChain keeps the venue detail when none is given", () => {
    const journal = memory();
    reach(journal, "venue_not_filled");
    journal.markChain("OrderA", "chain_cancelled", { signature: "sig2" });
    expect(journal.get("OrderA")).toMatchObject({ state: "chain_cancelled", chainSignature: "sig2", detail: "fok" });
  });
});

describe("queries", () => {
  it("byState and unresolved return rows oldest first", () => {
    const journal = memory();
    const states: OrderState[] = ["chain_filled", "venue_unknown", "seen", "failed", "venue_filled", "submitting", "venue_not_filled"];
    states.forEach((state, i) => reach(journal, state, order({ orderAddress: `Order${i}`, clientOrderId: `client-${i}` })));
    expect(journal.unresolved().map((row) => row.state)).toEqual([
      "venue_unknown",
      "seen",
      "venue_filled",
      "submitting",
      "venue_not_filled",
    ]);
    expect(journal.byState("failed", "chain_filled").map((row) => row.orderAddress)).toEqual(["Order0", "Order3"]);
    expect(journal.byState()).toEqual([]);
  });

  it("byUser returns that user's rows newest first, up to the limit", () => {
    const journal = memory();
    const users = ["UserA", "UserB", "UserA", "UserA"];
    users.forEach((user, i) => journal.recordSeen(order({ user, orderAddress: `Order${i}`, clientOrderId: `client-${i}` })));
    expect(journal.get("Order1")?.user).toBe("UserB");
    expect(journal.byUser("UserA", 10).map((row) => row.orderAddress)).toEqual(["Order3", "Order2", "Order0"]);
    expect(journal.byUser("UserA", 2).map((row) => row.orderAddress)).toEqual(["Order3", "Order2"]);
    expect(journal.byUser("UserB", 10).map((row) => row.user)).toEqual(["UserB"]);
    expect(journal.byUser("Nobody", 10)).toEqual([]);
    expect(journal.byUser("UserA", 0)).toEqual([]);
  });

  it("houseInventoryUnits sums the signed fills of orphaned orders per symbol", () => {
    const journal = memory();
    const cases: Array<[Pick<NewOrder, "kind" | "side">, bigint, bigint]> = [
      [{ kind: "buy", side: "YES" }, 300n, 300n],
      [{ kind: "buy", side: "NO" }, 100n, 200n],
      [{ kind: "sell", side: "YES" }, 50n, 150n],
      [{ kind: "sell", side: "NO" }, 25n, 175n],
    ];
    expect(journal.houseInventoryUnits("GEMI-BTC-TEST")).toBe(0n);
    cases.forEach(([shape, units, expected], i) => {
      reach(journal, "orphaned", order({ ...shape, units, limitPx: 5_000n, orderAddress: `Order${i}`, clientOrderId: `client-${i}` }));
      expect(journal.houseInventoryUnits("GEMI-BTC-TEST")).toBe(expected);
    });
    // Orders that were minted, or that sit on another symbol, are not house inventory.
    reach(journal, "chain_filled", order({ orderAddress: "Minted", clientOrderId: "client-m" }));
    reach(journal, "orphaned", order({ orderAddress: "Other", clientOrderId: "client-o", symbol: "GEMI-ETH-TEST" }));
    expect(journal.houseInventoryUnits("GEMI-BTC-TEST")).toBe(175n);
    expect(journal.houseInventoryUnits("GEMI-ETH-TEST")).toBe(300n);
  });
});

describe("durability", () => {
  it("a journal reopened from the same file returns the same rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-test-"));
    try {
      const path = join(dir, "journal.sqlite");
      const first = openJournal(path);
      const big = order({ units: 2n ** 70n, limitPx: 9_999n, maxFeeMicros: 2n ** 65n });
      first.recordSeen(big);
      reach(first, "orphaned", order({ orderAddress: "OrderB", clientOrderId: "client-b" }));
      const rows = [first.get("OrderA"), first.get("OrderB")];
      const fills = first.fills("OrderB");
      first.close();

      const second = openJournal(path);
      try {
        expect([second.get("OrderA"), second.get("OrderB")]).toEqual(rows);
        expect(second.get("OrderA")?.units).toBe(2n ** 70n);
        expect(second.fills("OrderB")).toEqual(fills);
        expect(second.unresolved().map((row) => row.orderAddress)).toEqual(["OrderA"]);
        expect(second.houseInventoryUnits("GEMI-BTC-TEST")).toBe(300n);
        expect(second.recordSeen(big).created).toBe(false);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
