import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoller } from "./poller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("startPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at once and then once per interval", async () => {
    const seen: number[] = [];
    let count = 0;
    const poller = startPoller({ fn: async () => ++count, intervalMs: 10_000, onData: (value) => seen.push(value), onError: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([1, 2]);
    poller.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).toEqual([1, 2]);
  });

  it("reports a failed read and keeps polling", async () => {
    const data: string[] = [];
    const errors: string[] = [];
    let count = 0;
    const poller = startPoller({
      fn: async () => {
        count += 1;
        if (count === 2) throw new Error("HTTP error (429): Too Many Requests");
        return `read ${count}`;
      },
      intervalMs: 5_000,
      onData: (value) => data.push(value),
      onError: (error) => errors.push(error.message),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(data).toEqual(["read 1", "read 3"]);
    expect(errors).toEqual(["HTTP error (429): Too Many Requests"]);
    poller.stop();
  });

  it("never overlaps: a refresh during a read runs once more when it ends", async () => {
    const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
    let calls = 0;
    const data: string[] = [];
    const poller = startPoller({ fn: () => (pending[calls++] as (typeof pending)[number]).promise, intervalMs: 5_000, onData: (value) => data.push(value), onError: () => {} });
    expect(calls).toBe(1);
    poller.refresh();
    poller.refresh();
    expect(calls).toBe(1);
    pending[0]?.resolve("before the change");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    pending[1]?.resolve("after the change");
    await vi.advanceTimersByTimeAsync(0);
    expect(data).toEqual(["before the change", "after the change"]);
    // Back to the interval: nothing more until it has passed.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    poller.stop();
  });

  it("does not read while paused, and reads again on refresh", async () => {
    let paused = true;
    let calls = 0;
    const poller = startPoller({ fn: async () => ++calls, intervalMs: 5_000, onData: () => {}, onError: () => {}, paused: () => paused });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(0);
    paused = false;
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    poller.stop();
  });

  it("drops the answer of a read that ends after it was stopped", async () => {
    const slow = deferred<string>();
    const data: string[] = [];
    const poller = startPoller({ fn: () => slow.promise, intervalMs: 5_000, onData: (value) => data.push(value), onError: () => {} });
    poller.stop();
    slow.resolve("late");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(data).toEqual([]);
  });
});
