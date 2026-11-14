import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openJournal } from "../src/journal.ts";
import { openRegistry } from "../src/registry.ts";
import type { Registry } from "../src/registry.ts";
import type { ContractInfo } from "../src/venue/venue.ts";

// Synthetic contracts in the shape the venue adapters produce.
const SYMBOL = "TEST-BTC15M2611140300-UP";
const EFFECTIVE = Date.parse("2026-11-14T02:45:00Z");
const EXPIRY = Date.parse("2026-11-14T03:00:00Z");

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
    title: "BTC price at 3am",
    label: "Up",
    series: "BTC15M",
    strike: "64000.50",
    settlementValue: null,
    ...overrides,
  };
}

const open: Registry[] = [];
function memory(): Registry {
  const registry = openRegistry(":memory:");
  open.push(registry);
  return registry;
}
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe("upsertContract", () => {
  it("stores a new contract with empty on-chain fields and settle state open", () => {
    const registry = memory();
    const stored = registry.upsertContract(info(), 1_000);
    expect(stored).toEqual({
      symbol: SYMBOL,
      eventTicker: "BTC15M2611140300",
      series: "BTC15M",
      underlying: "BTC",
      title: "BTC price at 3am",
      label: "Up",
      effectiveAt: EFFECTIVE,
      expiresAt: EXPIRY,
      strike: "64000.50",
      venueStatus: "active",
      marketState: "open",
      tickPx: 100n,
      unitIncrement: 1n,
      minUnits: 1n,
      resolution: null,
      settlementValue: null,
      marketAddress: null,
      yesMint: null,
      noMint: null,
      settleState: "open",
      settleSignature: null,
      detail: null,
      updatedAt: 1_000,
    });
    expect(registry.get(SYMBOL)).toEqual(stored);
    expect(registry.get("TEST-NOPE")).toBeUndefined();
  });

  it("derives the series from the event ticker and the underlying from the series", () => {
    const registry = memory();
    const { title: _title, label: _label, series: _series, ...bare } = info();
    expect(registry.upsertContract(bare, 1)).toMatchObject({ series: "BTC15M", underlying: "BTC", title: "BTC15M2611140300", label: "UP" });
    expect(registry.upsertContract(info({ symbol: "TEST-SOL1H-UP", series: "SOL1H" }), 1).underlying).toBe("SOL");
    // No interval tag: the series is its own underlying.
    expect(registry.upsertContract(info({ symbol: "TEST-FED-YES", series: "FEDRATE" }), 1)).toMatchObject({ series: "FEDRATE", underlying: "FEDRATE" });
    expect(registry.upsertContract(info({ symbol: "TEST-2024-YES", series: "2024" }), 1).underlying).toBe("2024");
  });

  it("updates venue fields and never clears on-chain, settle or display fields", () => {
    const registry = memory();
    registry.upsertContract(info(), 1_000);
    registry.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
    registry.setSettle(SYMBOL, "awaiting_result");

    const { title: _title, label: _label, series: _series, strike: _strike, ...bare } = info({
      status: "settled",
      marketState: "closed",
      resolutionSide: "yes",
      settlementValue: "64100.125",
      tickPx: 1n,
      minUnits: 5n,
      unitIncrement: 5n,
    });
    const updated = registry.upsertContract(bare, 2_000);
    expect(updated).toMatchObject({
      venueStatus: "settled",
      marketState: "closed",
      resolution: "yes",
      settlementValue: "64100.125",
      tickPx: 1n,
      minUnits: 5n,
      unitIncrement: 5n,
      title: "BTC price at 3am",
      label: "Up",
      series: "BTC15M",
      underlying: "BTC",
      strike: "64000.50",
      marketAddress: "MarketA",
      yesMint: "YesA",
      noMint: "NoA",
      settleState: "awaiting_result",
      updatedAt: 2_000,
    });
    // A later answer without the resolution does not erase what is known.
    expect(registry.upsertContract(info({ strike: null }), 3_000)).toMatchObject({ resolution: "yes", settlementValue: "64100.125", strike: "64000.50" });
  });

  it("refuses a contract whose dates cannot be read", () => {
    const registry = memory();
    expect(() => registry.upsertContract(info({ expiresAt: new Date("nope") }), 1)).toThrow(`contract ${SYMBOL}: unreadable effective or expiry date`);
    expect(registry.get(SYMBOL)).toBeUndefined();
  });
});

describe("setOnchain and setSettle", () => {
  it("record the addresses, the state, the signature and the detail", () => {
    const registry = memory();
    registry.upsertContract(info(), 1);
    registry.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
    registry.setSettle(SYMBOL, "needs_review", { detail: "payout mismatch" });
    expect(registry.get(SYMBOL)).toMatchObject({ marketAddress: "MarketA", settleState: "needs_review", settleSignature: null, detail: "payout mismatch" });
    registry.setSettle(SYMBOL, "settled", { signature: "SigA" });
    expect(registry.get(SYMBOL)).toMatchObject({ settleState: "settled", settleSignature: "SigA", detail: "payout mismatch" });
  });

  it("throw for a symbol that is not in the registry", () => {
    const registry = memory();
    expect(() => registry.setOnchain("TEST-NOPE", { marketAddress: "M", yesMint: "Y", noMint: "N" })).toThrow("unknown market TEST-NOPE");
    expect(() => registry.setSettle("TEST-NOPE", "settled")).toThrow("unknown market TEST-NOPE");
  });
});

describe("queries", () => {
  function seeded(): Registry {
    const registry = memory();
    const at = (minutes: number) => new Date(EXPIRY + minutes * 60_000);
    registry.upsertContract(info({ symbol: "TEST-BTC-A", expiresAt: at(0) }), 1);
    registry.upsertContract(info({ symbol: "TEST-BTC-B", expiresAt: at(30) }), 1);
    registry.upsertContract(info({ symbol: "TEST-ETH-C", series: "ETH15M", expiresAt: at(15) }), 1);
    registry.upsertContract(info({ symbol: "TEST-DOGE-D", series: "DOGE15M", expiresAt: at(15) }), 1);
    return registry;
  }
  const symbols = (rows: Array<{ symbol: string }>) => rows.map((row) => row.symbol);

  it("live: unexpired contracts of the given series, soonest expiry first", () => {
    const registry = seeded();
    expect(symbols(registry.live(EXPIRY - 1, ["BTC15M", "ETH15M"]))).toEqual(["TEST-BTC-A", "TEST-ETH-C", "TEST-BTC-B"]);
    expect(symbols(registry.live(EXPIRY, ["BTC15M", "ETH15M"]))).toEqual(["TEST-ETH-C", "TEST-BTC-B"]);
    expect(symbols(registry.live(EXPIRY, ["DOGE15M"]))).toEqual(["TEST-DOGE-D"]);
    expect(registry.live(EXPIRY, [])).toEqual([]);
  });

  it("all: newest expiry first, limited", () => {
    const registry = seeded();
    expect(symbols(registry.all(10))).toEqual(["TEST-BTC-B", "TEST-DOGE-D", "TEST-ETH-C", "TEST-BTC-A"]);
    expect(symbols(registry.all(1))).toEqual(["TEST-BTC-B"]);
    expect(registry.all(0)).toEqual([]);
  });

  it("onchainUnsettled: markets with an address whose settle state is open or awaiting_result", () => {
    const registry = seeded();
    const onchain = (symbol: string) => registry.setOnchain(symbol, { marketAddress: `M-${symbol}`, yesMint: "Y", noMint: "N" });
    onchain("TEST-BTC-A");
    onchain("TEST-BTC-B");
    onchain("TEST-ETH-C");
    registry.setSettle("TEST-BTC-A", "awaiting_result");
    registry.setSettle("TEST-ETH-C", "settled", { signature: "Sig" });
    registry.setSettle("TEST-DOGE-D", "awaiting_result"); // no address: not on-chain
    expect(symbols(registry.onchainUnsettled())).toEqual(["TEST-BTC-A", "TEST-BTC-B"]);
    registry.setSettle("TEST-BTC-A", "unused");
    registry.setSettle("TEST-BTC-B", "needs_review");
    expect(registry.onchainUnsettled()).toEqual([]);
  });
});

describe("persistence", () => {
  it("keeps markets across a reopen and shares the file with the journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "registry-test-"));
    const path = join(dir, "relayer.sqlite");
    try {
      const journal = openJournal(path);
      const first = openRegistry(path);
      first.upsertContract(info(), 1_000);
      first.setOnchain(SYMBOL, { marketAddress: "MarketA", yesMint: "YesA", noMint: "NoA" });
      first.setSettle(SYMBOL, "settled", { signature: "SigA" });
      const before = first.get(SYMBOL);
      journal.recordSeen({
        orderAddress: "OrderA",
        clientOrderId: "client-a",
        user: "UserA",
        kind: "buy",
        side: "YES",
        symbol: SYMBOL,
        units: 100n,
        limitPx: 4_500n,
        maxFeeMicros: 50_000n,
        expiresAt: 1_800_000_000,
      });
      first.close();
      journal.close();

      const again = openRegistry(path);
      const journalAgain = openJournal(path);
      try {
        expect(again.get(SYMBOL)).toEqual(before);
        expect(again.get(SYMBOL)).toMatchObject({ marketAddress: "MarketA", settleState: "settled", settleSignature: "SigA", tickPx: 100n });
        expect(journalAgain.get("OrderA")?.symbol).toBe(SYMBOL);
      } finally {
        again.close();
        journalAgain.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
