import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { RestError, createRestClient } from "../src/venue/gemini/rest.ts";

const HOST = "https://api.sandbox.gemini.com";
const API_KEY = "account-TESTKEY";
const API_SECRET = "test-secret";

interface Call {
  url: string;
  init: RequestInit;
  at: number;
}

/** A client on a manual clock: `sleep` advances the clock instead of waiting. */
function harness(responses: Array<Response | Error> = [], options: { minSpacingMs?: number; startMs?: number } = {}) {
  const clock = { ms: options.startMs ?? 1_794_624_000_250 };
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const fetchFake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {}, at: clock.ms });
    const next = queue.shift() ?? json({});
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createRestClient({
    host: HOST,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    fetch: fetchFake,
    now: () => clock.ms,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.ms += ms;
    },
    ...(options.minSpacingMs === undefined ? {} : { minSpacingMs: options.minSpacingMs }),
  });
  return { client, calls, sleeps, clock };
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe("createRestClient: host guard", () => {
  it.each([
    "https://api.gemini.com",
    "https://api.sandbox.gemini.com/",
    "http://api.sandbox.gemini.com",
    "https://api.sandbox.gemini.com.example.org",
    "",
  ])("refuses the host %j", (host) => {
    expect(() => createRestClient({ host, apiKey: API_KEY, apiSecret: API_SECRET })).toThrow(
      "this build is sandbox only",
    );
  });

  it("accepts the sandbox host", () => {
    expect(() => createRestClient({ host: HOST, apiKey: API_KEY, apiSecret: API_SECRET })).not.toThrow();
  });
});

describe("signed", () => {
  it("sends exactly the documented headers and an empty body", async () => {
    const { client, calls } = harness();
    await client.signed("POST", "/v1/balances");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${HOST}/v1/balances`);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
    expect(Object.keys(headersOf(call)).sort()).toEqual([
      "Cache-Control",
      "Content-Length",
      "Content-Type",
      "X-GEMINI-APIKEY",
      "X-GEMINI-PAYLOAD",
      "X-GEMINI-SIGNATURE",
    ]);
    expect(headersOf(call)).toMatchObject({
      "Cache-Control": "no-cache",
      "Content-Length": "0",
      "Content-Type": "text/plain",
      "X-GEMINI-APIKEY": API_KEY,
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("signs base64(JSON({ request, ...params, nonce })) with HMAC-SHA384 (known answer)", async () => {
    const { client, calls } = harness([], { startMs: 1_794_624_000_999 });
    await client.signed("POST", "/v1/prediction-markets/orders/history", { symbol: "DEMO-BTC15M-UP", limit: 50 });

    const expectedPayload = Buffer.from(
      '{"request":"/v1/prediction-markets/orders/history","symbol":"DEMO-BTC15M-UP","limit":50,"nonce":1794624000}',
    ).toString("base64");
    const expectedSignature = createHmac("sha384", API_SECRET).update(expectedPayload).digest("hex");
    const headers = headersOf(calls[0]!);
    expect(headers["X-GEMINI-PAYLOAD"]).toBe(expectedPayload);
    expect(headers["X-GEMINI-SIGNATURE"]).toBe(expectedSignature);
    expect(headers["X-GEMINI-SIGNATURE"]).toMatch(/^[0-9a-f]{96}$/);
  });

  it("puts query parameters in the URL and leaves them out of the signed request path", async () => {
    const { client, calls } = harness();
    await client.signed("POST", "/v1/prediction-markets/positions", {}, { limit: "100" });

    expect(calls[0]!.url).toBe(`${HOST}/v1/prediction-markets/positions?limit=100`);
    const payload = JSON.parse(Buffer.from(headersOf(calls[0]!)["X-GEMINI-PAYLOAD"]!, "base64").toString());
    expect(payload).toEqual({ request: "/v1/prediction-markets/positions", nonce: 1_794_624_000 });
  });

  it("spaces calls at least 1100 ms apart by default so no two share a nonce second", async () => {
    const { client, calls, sleeps } = harness();
    await Promise.all([client.signed("POST", "/v1/balances"), client.signed("POST", "/v1/balances"), client.signed("POST", "/v1/balances")]);

    expect(calls.map((call) => call.at - calls[0]!.at)).toEqual([0, 1_100, 2_200]);
    expect(sleeps).toEqual([1_100, 1_100]);
    const nonces = calls.map((call) => JSON.parse(Buffer.from(headersOf(call)["X-GEMINI-PAYLOAD"]!, "base64").toString()).nonce);
    expect(nonces).toEqual([1_794_624_000, 1_794_624_001, 1_794_624_002]);
  });

  it("waits only for the remainder of the spacing and never overlaps two signed calls", async () => {
    const { client, calls, sleeps, clock } = harness([], { minSpacingMs: 2_000 });
    await client.signed("POST", "/v1/balances");
    clock.ms += 1_500;
    await client.signed("POST", "/v1/balances");
    clock.ms += 5_000;
    await client.signed("POST", "/v1/balances");
    expect(sleeps).toEqual([500]);
    expect(calls).toHaveLength(3);

    // Serialised: the second call does not start before the first response arrived.
    let release!: (response: Response) => void;
    const order: string[] = [];
    const slow = createRestClient({
      host: HOST,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      minSpacingMs: 0,
      fetch: async () => {
        order.push("start");
        if (order.length === 1) await new Promise<Response>((resolve) => (release = resolve));
        order.push("end");
        return json({});
      },
    });
    const both = Promise.all([slow.signed("POST", "/v1/balances"), slow.signed("POST", "/v1/balances")]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["start"]);
    release(json({}));
    await both;
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  it("lets reserveSlot take a nonce second in the same queue", async () => {
    const { client, calls, sleeps } = harness();
    await client.signed("POST", "/v1/balances");
    await client.reserveSlot();
    await client.signed("POST", "/v1/balances");
    expect(sleeps).toEqual([1_100, 1_100]);
    expect(calls[1]!.at - calls[0]!.at).toBe(2_200);
  });

  it("keeps the queue running after a failed call", async () => {
    const { client, calls } = harness([new Error("socket hang up"), json({ ok: true })]);
    await expect(client.signed("POST", "/v1/balances")).rejects.toThrow("socket hang up");
    await expect(client.signed("POST", "/v1/balances")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe("publicGet", () => {
  it("sends no credentials and limits calls to one per second", async () => {
    const { client, calls, sleeps } = harness([json({ a: 1 }), json({ a: 2 })]);
    const [first, second] = await Promise.all([client.publicGet("/v1/book/DEMO?limit_bids=1"), client.publicGet("/v1/book/DEMO?limit_bids=1")]);

    expect(first).toEqual({ a: 1 });
    expect(second).toEqual({ a: 2 });
    expect(calls[0]!.url).toBe(`${HOST}/v1/book/DEMO?limit_bids=1`);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.headers).toBeUndefined();
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(sleeps).toEqual([1_000]);
    expect(calls[1]!.at - calls[0]!.at).toBe(1_000);
  });

  it("does not make signed calls wait for public ones", async () => {
    const { client, sleeps } = harness();
    await client.publicGet("/v1/book/DEMO");
    await client.signed("POST", "/v1/balances");
    expect(sleeps).toEqual([]);
  });
});

describe("responses", () => {
  it("keeps integers of 16 or more digits as strings", async () => {
    const { client } = harness([json('{"orderId":700000000000000001,"tradeId":5000000000000001,"count":3,"price":"0.17"}')]);
    await expect(client.publicGet("/v1/anything")).resolves.toEqual({
      orderId: "700000000000000001",
      tradeId: "5000000000000001",
      count: 3,
      price: "0.17",
    });
  });

  it("maps a non-2xx response to a RestError carrying the status and the parsed body", async () => {
    const body = { result: "error", reason: "InvalidNonce", message: "Nonce '1' has not increased" };
    const { client } = harness([json(body, 400)]);
    const error: unknown = await client.signed("POST", "/v1/balances").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RestError);
    expect((error as RestError).status).toBe(400);
    expect((error as RestError).body).toEqual(body);
    expect((error as RestError).message).toBe("HTTP 400 from POST /v1/balances");
  });

  it("keeps a body that is not JSON as text on an error and rejects it on success", async () => {
    const { client } = harness([json("<html>Bad Gateway</html>", 502), json("ok", 200)]);
    const failed: unknown = await client.publicGet("/v1/book/DEMO").catch((caught: unknown) => caught);
    expect(failed).toBeInstanceOf(RestError);
    expect((failed as RestError).status).toBe(502);
    expect((failed as RestError).body).toBe("<html>Bad Gateway</html>");

    const notJson: unknown = await client.publicGet("/v1/book/DEMO").catch((caught: unknown) => caught);
    expect(notJson).toBeInstanceOf(RestError);
    expect((notJson as RestError).status).toBe(200);
    expect((notJson as RestError).body).toBe("ok");
  });

  it("never puts the key, secret, payload or signature in an error", async () => {
    const { client, calls } = harness([json({ result: "error" }, 500)]);
    const error = (await client.signed("POST", "/v1/balances", { marker: "x" }).catch((caught: unknown) => caught)) as RestError;
    const text = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    const headers = headersOf(calls[0]!);
    for (const secret of [API_KEY, API_SECRET, headers["X-GEMINI-PAYLOAD"]!, headers["X-GEMINI-SIGNATURE"]!]) {
      expect(text).not.toContain(secret);
    }
  });
});
