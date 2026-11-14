import { describe, expect, it } from "vitest";
import type { ApiOrder } from "@outcome/relayer/api-types";
import type { OpenOrder } from "@/lib/chain/reads";
import { orderEntries } from "./entries";
import type { LocalOrder } from "./timeline";

const NOW = 1_800_000_000_000;
const api = (address: string, createdAt: number, symbol = "SYM"): ApiOrder => ({
  address,
  user: "user",
  symbol,
  kind: "buy",
  side: "YES",
  units: "200",
  limitPx: "4500",
  maxFeeMicros: "70000",
  expiresAt: 0,
  state: "chain_filled",
  venueOrderId: null,
  filledUnits: "0",
  amountMicros: "0",
  feeMicros: "0",
  fills: [],
  chainSignature: null,
  detail: null,
  createdAt,
  updatedAt: createdAt,
});
const open = (address: string, market = "market"): OpenOrder => ({ address, user: "user", market, side: 0, kind: 0, qtyUnits: 200n, limitPx: 4_500n, maxFee: 70_000n, expiresAt: 0, rentPayer: "user", nonce: 1n });
const local = (address: string, placedAt: number, patch: Partial<LocalOrder> = {}): LocalOrder => ({ address, signature: "sig", symbol: "SYM", side: "YES", units: "200", limitPx: "4500", maxFeeMicros: "70000", placedAt, expiresAt: 0, ...patch });

describe("orderEntries", () => {
  it("merges the relayer's rows, the open order accounts and this browser's record by address, newest first", () => {
    const entries = orderEntries({
      api: [api("A", NOW - 60_000), api("B", NOW - 120_000, "OTHER")],
      open: { orders: [open("A"), open("C", "elsewhere")], startedAt: NOW - 1_000 },
      local: { A: local("A", NOW - 61_000), D: local("D", NOW - 30_000, { reclaimSignature: "r" }) },
      nowMs: NOW,
    });
    expect(entries.map((entry) => entry.address)).toEqual(["C", "D", "A", "B"]);
    const [c, d, a, b] = entries;
    // Only its account is known: it sorts first and has no placement time.
    expect(c).toMatchObject({ api: null, local: null, placedAt: null, symbol: null, marketAddress: "elsewhere" });
    expect(c?.chain?.address).toBe("C");
    expect(d).toMatchObject({ chain: null, placedAt: NOW - 30_000, symbol: "SYM" });
    expect(a).toMatchObject({ placedAt: NOW - 61_000, symbol: "SYM", marketAddress: "market" });
    expect(a?.api?.address).toBe("A");
    expect(b).toMatchObject({ chain: null, local: null, placedAt: NOW - 120_000, symbol: "OTHER", marketAddress: null });
  });

  it("does not yet know whether an order account exists before the chain has been read", () => {
    const [entry] = orderEntries({ api: [api("A", NOW)], open: undefined, local: {}, nowMs: NOW });
    expect(entry?.chain).toBeUndefined();
  });

  it("does not take a just-placed order for a closed one because one read missed it", () => {
    // The chain was read before the order was placed.
    const early = orderEntries({ api: [], open: { orders: [], startedAt: NOW - 5_000 }, local: { A: local("A", NOW - 2_000) }, nowMs: NOW });
    expect(early[0]?.chain).toBeUndefined();
    // Read after placing, but the relayer has not recorded the order yet.
    const settling = orderEntries({ api: [], open: { orders: [], startedAt: NOW - 1_000 }, local: { A: local("A", NOW - 2_000) }, nowMs: NOW });
    expect(settling[0]?.chain).toBeUndefined();
    // Long enough after placing, a missing account means the order is closed.
    const closed = orderEntries({ api: [], open: { orders: [], startedAt: NOW - 1_000 }, local: { A: local("A", NOW - 60_000) }, nowMs: NOW });
    expect(closed[0]?.chain).toBeNull();
  });
});

describe("orderEntries while the relayer is away", () => {
  const sources = {
    api: undefined,
    open: { orders: [open("OPEN")], startedAt: NOW - 1_000 },
    local: { OPEN: local("OPEN", NOW - 90_000), GONE: local("GONE", NOW - 80_000), MINE: local("MINE", NOW - 70_000, { reclaimSignature: "r" }), NEW: local("NEW", NOW - 500) },
    nowMs: NOW,
  };

  it("leaves out an order that has left Solana when nothing says how it ended", () => {
    const entries = orderEntries({ ...sources, relayerAway: true });
    // Still open, reclaimed by the user, or placed after the last read of the chain: all kept.
    expect(entries.map((entry) => entry.address)).toEqual(["NEW", "MINE", "OPEN"]);
  });

  it("keeps it when the relayer's last answer has a record of it", () => {
    const entries = orderEntries({ ...sources, api: [api("GONE", NOW - 79_000)], relayerAway: true });
    expect(entries.map((entry) => entry.address)).toContain("GONE");
  });

  it("keeps everything while the relayer answers", () => {
    expect(orderEntries(sources).map((entry) => entry.address)).toEqual(["NEW", "MINE", "GONE", "OPEN"]);
  });
});
