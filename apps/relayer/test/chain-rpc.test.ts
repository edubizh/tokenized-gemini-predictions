import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError, type RpcTransport } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { httpStatusOf, withRetry } from "../src/chain/rpc.ts";

function httpError(statusCode: number, headers: Record<string, string> = {}): SolanaError {
  return new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(headers),
    message: "error",
    statusCode,
  });
}

/** A transport that fails with the queued errors in turn, then answers "ok". */
function scriptedTransport(failures: unknown[]): { transport: RpcTransport; calls: () => number } {
  let calls = 0;
  const transport = (async () => {
    const failure = failures[calls];
    calls++;
    if (failure !== undefined) throw failure;
    return "ok";
  }) as RpcTransport;
  return { transport, calls: () => calls };
}

const request = { payload: { method: "getSlot" } };

describe("withRetry", () => {
  it("passes a successful response through without waiting", async () => {
    const { transport, calls } = scriptedTransport([]);
    const waits: number[] = [];
    const retrying = withRetry(transport, { sleep: async (ms) => void waits.push(ms) });

    await expect(retrying(request)).resolves.toBe("ok");
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("retries a rate-limited request with doubling waits", async () => {
    const { transport, calls } = scriptedTransport([httpError(429), httpError(429), httpError(429)]);
    const waits: number[] = [];
    const retrying = withRetry(transport, { sleep: async (ms) => void waits.push(ms) });

    await expect(retrying(request)).resolves.toBe("ok");
    expect(calls()).toBe(4);
    expect(waits).toEqual([500, 1_000, 2_000]);
  });

  it("waits as long as the Retry-After header says, up to the maximum", async () => {
    const { transport } = scriptedTransport([httpError(429, { "retry-after": "3" }), httpError(429, { "retry-after": "60" })]);
    const waits: number[] = [];
    const retrying = withRetry(transport, { sleep: async (ms) => void waits.push(ms) });

    await expect(retrying(request)).resolves.toBe("ok");
    expect(waits).toEqual([3_000, 5_000]);
  });

  it("retries gateway errors too", async () => {
    const { transport, calls } = scriptedTransport([httpError(502), httpError(503), httpError(504)]);
    const retrying = withRetry(transport, { sleep: async () => {} });

    await expect(retrying(request)).resolves.toBe("ok");
    expect(calls()).toBe(4);
  });

  it("gives up after the configured number of retries and throws the last error", async () => {
    const last = httpError(429);
    const { transport, calls } = scriptedTransport([httpError(429), httpError(429), last]);
    const retrying = withRetry(transport, { retries: 2, sleep: async () => {} });

    await expect(retrying(request)).rejects.toBe(last);
    expect(calls()).toBe(3);
  });

  it("does not retry other HTTP errors", async () => {
    const error = httpError(400);
    const { transport, calls } = scriptedTransport([error]);
    const retrying = withRetry(transport, { sleep: async () => {} });

    await expect(retrying(request)).rejects.toBe(error);
    expect(calls()).toBe(1);
  });

  it("does not retry errors that are not HTTP errors", async () => {
    const error = new Error("socket hang up");
    const { transport, calls } = scriptedTransport([error]);
    const retrying = withRetry(transport, { sleep: async () => {} });

    await expect(retrying(request)).rejects.toBe(error);
    expect(calls()).toBe(1);
  });

  it("stops retrying once the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = httpError(429);
    const { transport, calls } = scriptedTransport([error]);
    const retrying = withRetry(transport, { sleep: async () => {} });

    await expect(retrying({ ...request, signal: controller.signal })).rejects.toBe(error);
    expect(calls()).toBe(1);
  });

  it("reports each retry", async () => {
    const { transport } = scriptedTransport([httpError(429), httpError(503)]);
    const seen: Array<{ attempt: number; delayMs: number; statusCode: number }> = [];
    const retrying = withRetry(transport, { sleep: async () => {}, onRetry: (info) => seen.push(info) });

    await retrying(request);
    expect(seen).toEqual([
      { attempt: 1, delayMs: 500, statusCode: 429 },
      { attempt: 2, delayMs: 1_000, statusCode: 503 },
    ]);
  });
});

describe("httpStatusOf", () => {
  it("reads the status of a transport error and ignores everything else", () => {
    expect(httpStatusOf(httpError(429))).toBe(429);
    expect(httpStatusOf(new Error("nope"))).toBeNull();
    expect(httpStatusOf(undefined)).toBeNull();
  });
});
