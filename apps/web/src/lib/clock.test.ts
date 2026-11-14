import { describe, expect, it } from "vitest";
import { clusterTimeFromSysvar, createClock } from "./clock";

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

describe("clusterTimeFromSysvar", () => {
  it("reads the unix timestamp of the cluster's Clock account", () => {
    const data = new Uint8Array(40);
    new DataView(data.buffer).setBigInt64(32, 1_794_690_000n, true);
    expect(clusterTimeFromSysvar(data)).toBe(1_794_690_000);
  });

  it("reads it from a view into a larger buffer", () => {
    const buffer = new Uint8Array(48);
    new DataView(buffer.buffer).setBigInt64(8 + 32, 1_794_690_123n, true);
    expect(clusterTimeFromSysvar(buffer.subarray(8))).toBe(1_794_690_123);
  });

  it("refuses data that is too short to be the Clock account", () => {
    expect(() => clusterTimeFromSysvar(new Uint8Array(39))).toThrow("cluster clock");
  });
});
