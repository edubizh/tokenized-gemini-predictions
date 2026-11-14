import { describe, expect, it } from "vitest";
import { createClock } from "./clock";

describe("clock", () => {
  it("reads the local clock until it has been aligned", () => {
    const clock = createClock();
    expect(clock.synced()).toBe(false);
    expect(clock.chainNowMs(1_000_000)).toBe(1_000_000);
  });

  it("keeps the offset between chain time and the local clock", () => {
    const clock = createClock();
    // The cluster clock reads 1_700_000_000 s when the local clock reads 1_700_000_012_500 ms.
    clock.sync(1_700_000_000, 1_700_000_012_500);
    expect(clock.synced()).toBe(true);
    expect(clock.offsetMs()).toBe(-12_500);
    expect(clock.chainNowMs(1_700_000_020_000)).toBe(1_700_000_007_500);
    expect(clock.msUntilChain(1_700_000_060, 1_700_000_020_000)).toBe(52_500);
  });

  it("ignores a chain time that is not a positive number", () => {
    const clock = createClock();
    clock.sync(Number.NaN, 5_000);
    clock.sync(0, 5_000);
    expect(clock.synced()).toBe(false);
  });
});
