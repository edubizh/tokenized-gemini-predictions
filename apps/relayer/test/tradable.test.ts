import { describe, it, expect } from "vitest";
import { bookSideAvailable, cutoffMs, tradableNow } from "../src/venue/tradable.ts";
import type { Outcome } from "../src/venue/types.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 14, 3, 0, 0);
const at = (offsetMs: number) => new Date(START + offsetMs);

describe("cutoffMs", () => {
  it.each([
    ["1 minute", 1 * MINUTE, 60_000],
    ["5 minutes", 5 * MINUTE, 60_000],
    ["5 minutes and 1 ms", 5 * MINUTE + 1, 120_000],
    ["10 minutes", 10 * MINUTE, 120_000],
    ["15 minutes", 15 * MINUTE, 120_000],
    ["15 minutes and 1 ms", 15 * MINUTE + 1, 300_000],
    ["1 hour", 60 * MINUTE, 300_000],
    ["1 day", 24 * 60 * MINUTE, 300_000],
  ])("is right for a contract that lives %s", (_label, lifeMs, expected) => {
    expect(cutoffMs(at(0), at(lifeMs))).toBe(expected);
  });

  it("takes the longest cutoff when a date is invalid", () => {
    expect(cutoffMs(new Date(Number.NaN), at(5 * MINUTE))).toBe(300_000);
    expect(cutoffMs(at(0), new Date(Number.NaN))).toBe(300_000);
  });
});

describe("tradableNow", () => {
  // A 15-minute contract: orders stop 2 minutes before expiry.
  const contract = { status: "active", marketState: "open", effectiveAt: at(0), expiresAt: at(15 * MINUTE) };

  it("is ok for an active, open contract that has started and is not close to expiry", () => {
    expect(tradableNow(contract, at(5 * MINUTE))).toEqual({ ok: true });
  });

  it("is ok from the very start", () => {
    expect(tradableNow(contract, at(0))).toEqual({ ok: true });
    expect(tradableNow(contract, at(-1))).toEqual({ ok: false, reason: "not_started" });
  });

  it("stops at the cutoff before expiry", () => {
    expect(tradableNow(contract, at(13 * MINUTE - 1))).toEqual({ ok: true });
    expect(tradableNow(contract, at(13 * MINUTE))).toEqual({ ok: false, reason: "too_close_to_expiry" });
    expect(tradableNow(contract, at(15 * MINUTE))).toEqual({ ok: false, reason: "too_close_to_expiry" });
    expect(tradableNow(contract, at(60 * MINUTE))).toEqual({ ok: false, reason: "too_close_to_expiry" });
  });

  it("applies the cutoff that matches the contract's life", () => {
    const fiveMinutes = { ...contract, expiresAt: at(5 * MINUTE) };
    expect(tradableNow(fiveMinutes, at(4 * MINUTE - 1))).toEqual({ ok: true });
    expect(tradableNow(fiveMinutes, at(4 * MINUTE))).toEqual({ ok: false, reason: "too_close_to_expiry" });

    const oneHour = { ...contract, expiresAt: at(60 * MINUTE) };
    expect(tradableNow(oneHour, at(55 * MINUTE - 1))).toEqual({ ok: true });
    expect(tradableNow(oneHour, at(55 * MINUTE))).toEqual({ ok: false, reason: "too_close_to_expiry" });
  });

  it.each(["settled", "under_review", "Active", "ACTIVE", ""])("is not ok when the status is %j", (status) => {
    expect(tradableNow({ ...contract, status }, at(5 * MINUTE))).toEqual({ ok: false, reason: "not_active" });
  });

  it.each(["post_only", "closed", "halted", "Open", ""])("is not ok when the market state is %j", (marketState) => {
    expect(tradableNow({ ...contract, marketState }, at(5 * MINUTE))).toEqual({
      ok: false,
      reason: "market_not_open",
    });
  });

  it("reports the first failing check: status, market state, start, then expiry", () => {
    const allWrong = { status: "settled", marketState: "post_only", effectiveAt: at(10 * MINUTE), expiresAt: at(0) };
    expect(tradableNow(allWrong, at(5 * MINUTE))).toEqual({ ok: false, reason: "not_active" });
    expect(tradableNow({ ...allWrong, status: "active" }, at(5 * MINUTE))).toEqual({
      ok: false,
      reason: "market_not_open",
    });
    expect(tradableNow({ ...allWrong, status: "active", marketState: "open" }, at(5 * MINUTE))).toEqual({
      ok: false,
      reason: "not_started",
    });
  });

  it("is never ok when a date is invalid", () => {
    const invalid = new Date(Number.NaN);
    expect(tradableNow({ ...contract, effectiveAt: invalid }, at(5 * MINUTE))).toEqual({
      ok: false,
      reason: "not_started",
    });
    expect(tradableNow({ ...contract, expiresAt: invalid }, at(5 * MINUTE))).toEqual({
      ok: false,
      reason: "too_close_to_expiry",
    });
    expect(tradableNow(contract, invalid).ok).toBe(false);
  });

  it("is never ok for a contract that expires before it starts", () => {
    const inverted = { ...contract, effectiveAt: at(15 * MINUTE), expiresAt: at(0) };
    for (const offset of [-MINUTE, 0, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE]) {
      expect(tradableNow(inverted, at(offset)).ok).toBe(false);
    }
  });
});

describe("bookSideAvailable", () => {
  const level = { price: "0.17", amount: "5" };

  it("needs asks to buy YES", () => {
    expect(bookSideAvailable({ bids: [], asks: [level] }, "YES")).toBe(true);
    expect(bookSideAvailable({ bids: [level], asks: [] }, "YES")).toBe(false);
  });

  it("needs bids to buy NO", () => {
    expect(bookSideAvailable({ bids: [level], asks: [] }, "NO")).toBe(true);
    expect(bookSideAvailable({ bids: [], asks: [level] }, "NO")).toBe(false);
  });

  it("is false for an empty book", () => {
    expect(bookSideAvailable({ bids: [], asks: [] }, "YES")).toBe(false);
    expect(bookSideAvailable({ bids: [], asks: [] }, "NO")).toBe(false);
  });

  it("is false when the book side is missing or the outcome is unknown", () => {
    const noSides = {} as unknown as { bids: unknown[]; asks: unknown[] };
    expect(bookSideAvailable(noSides, "YES")).toBe(false);
    expect(bookSideAvailable(noSides, "NO")).toBe(false);
    expect(bookSideAvailable({ bids: [level], asks: [level] }, "MAYBE" as unknown as Outcome)).toBe(false);
  });
});
